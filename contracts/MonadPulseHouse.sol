// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SignedPriceOracle.sol";

/**
 * @title MonadPulseHouse
 * @notice Rise-or-fall bets against a house vault. Every bet is its own round, so it never waits for
 * another player and is never refunded for lack of one.
 *
 *  - Strike: the signed oracle price at the first report mark (10 s grid) at least `minLead` seconds
 *    after the bet, so nobody can bet on a price they have already seen. Result: the price `duration`
 *    seconds after the strike. Higher than the strike wins for Rise, lower wins for Fall; an exact tie
 *    returns the stake (push).
 *  - Odds move with the betting: each bet window (market, strike time, length) has its own market maker.
 *    The side more people back pays less and the other side more (1.60x to 2.38x by default, 1.91x when
 *    even), so players on both sides offset each other and the vault only carries the imbalance. Prices
 *    come from a quadratic cost function (a share pays 1 MON if its side wins), which is path
 *    independent: no sequence of bets can lock in a profit, and a bet that would move the price past the
 *    band is refused rather than capped. The payout is fixed when the bet lands.
 *  - The house earns a margin on every stake (vault), a fee on every winner's profit (treasury, owner),
 *    and a small cut of every stake feeds the streak jackpot; a bet that pushes or voids never played,
 *    so its cut is refunded to the vault along with the stake.
 *  - Solvency: the full payout of every pending bet is reserved in the vault when the bet is placed, so
 *    the vault can always pay every winner. One bet may win at most `maxWinBps` of the free vault.
 *  - Winnings are credited to the player's in-game balance at settlement: they can bet it again at once
 *    ("ride it") or withdraw it to their wallet at any time.
 *  - Streak jackpot: a win on a streak bet (placed while the player had no other bet pending, so a
 *    streak cannot be built by betting both sides) extends the player's streak; reaching
 *    `jackpotStreak` wins in a row pays part of the jackpot pot, capped at a multiple of the smallest
 *    stake in the streak. The pot is funded only by its cut of stakes, never by the vault.
 *  - Liquidity providers deposit MON into the vault for shares and earn the house edge. A deposit is
 *    priced as if every pending bet loses and a withdrawal as if every pending bet wins, so knowing a
 *    signed result before it settles gains an LP nothing; with no bets pending both prices are equal.
 *    A deposit is locked for `lpLockSeconds`.
 *  - Settlement is permissionless: anyone can record signed prices and settle any bet. A price missing
 *    from the oracle for `priceGrace` (5 min: time for anyone to post the exact report) is replaced by the earliest recorded report up to
 *    MAX_SUBSTITUTE_STEPS marks later; a bet whose price never appears is void after `voidAfter` and its
 *    stake is returned.
 */
contract MonadPulseHouse is SignedPriceOracle {
    enum Side { None, Up, Down }
    enum Status { None, Pending, Won, Lost, Push, Void }

    struct Bet {
        // slot 1
        address player;
        uint40 startTs;      // strike report time (seconds, multiple of REPORT_INTERVAL)
        uint16 duration;     // seconds from strike to result
        Side side;
        Status status;
        bool streakBet;      // placed with no other bet of this player pending
        uint16 winFeeBps;    // fee on the profit if it wins, fixed at placement
        // slot 2
        bytes32 marketId;
        // slot 3
        uint128 stake;
        uint128 payout;      // gross payout on a win (shares bought); the winner gets it less the win fee
        // slot 4
        uint128 cut;         // jackpot cut taken from the stake at placement; refunded if the bet voids or pushes
        uint16 priceGrace;   // seconds, fixed at placement so the owner cannot retime a pending bet's substitute rule
        uint24 voidAfter;    // seconds, fixed at placement so the owner cannot retime a pending bet's void timeout
    }

    struct Market {
        bytes32 feedId;
        bool active;
    }

    /// @dev One bet window's market maker: liquidity B (fixed at its first bet) and net shares Up - Down
    struct Window {
        uint128 liquidity;
        int128 net;
    }

    /// @dev Jackpot rules snapshotted when a player's streak starts, so the owner cannot change what a
    /// streak in progress pays (or whether it pays at all) part-way through it.
    struct StreakRules {
        uint16 streak;       // wins in a row that pay the jackpot
        uint16 shareBps;     // share of the pot paid
        uint16 capMultiple;  // jackpot at most this x the smallest stake in the streak
    }

    uint256 public constant REPORT_INTERVAL = 10;
    uint256 public constant MAX_SUBSTITUTE_STEPS = 3;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_JACKPOT_CUT_BPS = 300;
    uint256 private constant ONE = 1e18;

    // Tunable within bounds; each bet keeps the values it was placed with
    uint256 public marginBps = 300;          // house margin on every stake (3%)
    uint256 public winFeeBps = 300;          // fee on a winner's profit, to the treasury (3%)
    uint256 public maxSkewBps = 1_000;       // price band: 0.5 +/- 0.10, i.e. odds 1.60x to 2.38x
    uint256 public liquidityBps = 20_000;    // a window's B = 2x the free vault at its first bet (how fast odds move)
    uint256 public jackpotCutBps = 100;      // 1% of each stake to the jackpot pot
    uint256 public maxWinBps = 200;          // one bet wins at most 2% of the free vault
    uint256 public minBet = 0.1 ether;
    uint256 public minLead = 5;              // seconds between a bet and the earliest strike
    // The house is the counterparty and usually also the keeper, so a missing price must never become an
    // option for it: anyone can record the exact report (the oracle gateway keeps 24 h of history), a
    // later report may stand in only after `priceGrace`, and a bet voids only after `voidAfter`.
    uint256 public priceGrace = 5 minutes;   // seconds before a missing price may be substituted
    uint256 public voidAfter = 20 hours;     // a price still missing after this voids the bet
    uint256 public jackpotStreak = 5;        // wins in a row that pay the jackpot
    uint256 public jackpotShareBps = 2_500;  // share of the pot paid per jackpot
    uint256 public jackpotCapMultiple = 20;  // jackpot at most this x the smallest stake in the streak
    uint256 public lpLockSeconds = 1 hours;

    address public owner;
    address public pendingOwner;
    bool public paused; // blocks new bets and LP deposits; settlement and withdrawals always work

    mapping(bytes32 => Market) public markets;
    bytes32[] public marketIds;
    mapping(uint256 => bool) public durationAllowed;

    // Signed median price (8 decimals) per market and report time; 0 = not recorded
    mapping(bytes32 => mapping(uint256 => uint256)) public prices;

    Bet[] internal _bets;

    // Market maker per bet window: keccak(marketId, startTs, duration)
    mapping(bytes32 => Window) public windows;

    uint256 public treasury; // win fees, withdrawable by the owner

    // Players
    mapping(address => uint256) public balances;      // winnings and pushes, withdrawable any time
    mapping(address => uint256) public pendingBets;
    mapping(address => uint256) public streak;
    mapping(address => uint256) public streakMinStake;
    mapping(address => StreakRules) internal _streakRules; // snapshotted when streak[player] starts from 0
    uint256 public totalBalances;

    // Vault
    uint256 public vaultAssets;      // MON owned by the vault, including the stakes of pending bets
    uint256 public lockedPayouts;    // full payouts of pending bets, reserved
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public lpUnlockAt;

    uint256 public jackpotPot;

    // All-time counters for the dashboard
    uint256 public totalWagered;
    uint256 public totalPaidOut;
    uint256 public betsSettled;

    uint256 private _lock = 1;

    event MarketSet(bytes32 indexed marketId, bytes32 feedId, bool active);
    event DurationSet(uint256 duration, bool allowed);
    event ParamsUpdated();
    event Paused(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    event BetPlaced(
        uint256 indexed betId, address indexed player, bytes32 indexed marketId,
        Side side, uint256 stake, uint256 payout, uint256 startTs, uint256 duration, bool streakBet
    );
    event PriceRecorded(bytes32 indexed marketId, uint256 indexed ts, uint256 price, bool substitute);
    event BetSettled(
        uint256 indexed betId, address indexed player, bytes32 indexed marketId,
        Status status, uint256 paid, uint256 startPrice, uint256 endPrice, uint256 streak
    );
    event JackpotWon(address indexed player, uint256 indexed betId, uint256 amount, uint256 streak);
    event BalanceWithdrawn(address indexed player, uint256 amount);
    event LiquidityAdded(address indexed provider, uint256 amount, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 amount, uint256 shares);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "Reentrant call");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address[] memory signers, uint256 threshold) {
        owner = msg.sender;
        _setSigners(signers, threshold);
        durationAllowed[10] = true;
        durationAllowed[30] = true;
        durationAllowed[60] = true;
        emit DurationSet(10, true);
        emit DurationSet(30, true);
        emit DurationSet(60, true);
    }

    // ---------------------------------------------------------------------------------------------
    // Betting
    // ---------------------------------------------------------------------------------------------

    /**
     * @notice Bet `side` on `marketId` over `duration` seconds. The stake is msg.value plus
     * `fromBalance` taken from the in-game balance. Reverts if the payout would be below
     * `minPayout` (protects against a multiplier change between quote and inclusion).
     */
    function placeBet(bytes32 marketId, Side side, uint256 duration, uint256 fromBalance, uint256 minPayout)
        external
        payable
        nonReentrant
        returns (uint256 betId)
    {
        require(!paused, "Paused");
        require(markets[marketId].active, "Market inactive");
        require(side == Side.Up || side == Side.Down, "Invalid side");
        require(durationAllowed[duration], "Duration not offered");
        if (fromBalance > 0) {
            require(balances[msg.sender] >= fromBalance, "Balance too low");
            balances[msg.sender] -= fromBalance;
            totalBalances -= fromBalance;
        }
        uint256 stake = msg.value + fromBalance;
        require(stake >= minBet, "Bet below minimum");
        require(stake <= type(uint128).max, "Bet too large");

        uint256 startTs = _ceilToInterval(block.timestamp + minLead);
        uint256 free = vaultAssets - lockedPayouts;
        bytes32 wk = _windowKey(marketId, startTs, duration);
        Window memory w = windows[wk];
        if (w.liquidity == 0) {
            w.liquidity = uint128((free * liquidityBps) / BPS);
            require(w.liquidity > 0, "Bet exceeds house limit");
        }
        (uint256 payout, int256 netAfter) = _price(w, side, stake);
        require(_netPayout(stake, payout, winFeeBps) >= minPayout, "Payout below minimum");
        // Largest possible net loss for the vault on this bet, against its free liquidity
        require(payout - stake <= (free * maxWinBps) / BPS, "Bet exceeds house limit");
        windows[wk] = Window(w.liquidity, int128(netAfter));

        uint256 cut = (stake * jackpotCutBps) / BPS;
        uint256 toVault = stake - cut;
        jackpotPot += cut;
        vaultAssets += toVault;
        lockedPayouts += payout;
        require(lockedPayouts <= vaultAssets, "Vault cannot cover payout");

        bool streakBet = pendingBets[msg.sender] == 0;
        pendingBets[msg.sender] += 1;
        totalWagered += stake;
        // A fresh streak locks in the rules it will pay under for its whole run, so the owner cannot
        // change what it takes or what it pays part-way through one player's streak.
        if (streakBet && streak[msg.sender] == 0) {
            _streakRules[msg.sender] = StreakRules(uint16(jackpotStreak), uint16(jackpotShareBps), uint16(jackpotCapMultiple));
        }

        betId = _bets.length;
        _bets.push(Bet({
            player: msg.sender,
            startTs: uint40(startTs),
            duration: uint16(duration),
            side: side,
            status: Status.Pending,
            streakBet: streakBet,
            winFeeBps: uint16(winFeeBps),
            marketId: marketId,
            stake: uint128(stake),
            payout: uint128(payout),
            cut: uint128(cut),
            priceGrace: uint16(priceGrace),
            voidAfter: uint24(voidAfter)
        }));
        emit BetPlaced(betId, msg.sender, marketId, side, stake, _netPayout(stake, payout, winFeeBps), startTs, duration, streakBet);
    }

    function _windowKey(bytes32 marketId, uint256 startTs, uint256 duration) internal pure returns (bytes32) {
        return keccak256(abi.encode(marketId, startTs, duration));
    }

    /**
     * @dev Quadratic cost market maker. With d = Up shares - Down shares and liquidity B, the price of an
     * Up share is a = 1/2 + d/(2B) (Down: 1/2 - d/(2B)), and buying x shares costs x*a + x^2/(4B): the
     * change of C = (qUp + qDown)/2 + d^2/(4B), so the cost depends only on the start and end state.
     * The stake buys at cost stake/(1 + margin); solving for x: x = 2B(sqrt(a^2 + cost/B) - a).
     * Reverts if the price after the bet would leave 1/2 +/- maxSkew (the band).
     */
    function _price(Window memory w, Side side, uint256 stake) internal view returns (uint256 shares, int256 netAfter) {
        uint256 b = w.liquidity;
        int256 d = w.net;
        // Price of the side bought, 1e18 fixed point (d is signed; Down sees -d)
        int256 dSide = side == Side.Up ? d : -d;
        int256 aSigned = int256(ONE / 2) + (dSide * int256(ONE)) / int256(2 * b);
        require(aSigned > 0, "Odds at limit on this side");
        uint256 a = uint256(aSigned);
        uint256 cost = (stake * BPS) / (BPS + marginBps);
        // x = 2B(sqrt(a^2 + cost/B) - a), all in 1e18 fixed point
        uint256 root = _sqrt(a * a + (cost * ONE * ONE) / b);
        shares = (2 * b * (root - a)) / ONE;
        netAfter = side == Side.Up ? d + int256(shares) : d - int256(shares);
        uint256 absAfter = netAfter >= 0 ? uint256(netAfter) : uint256(-netAfter);
        require((absAfter * BPS) / (2 * b) <= maxSkewBps, "Odds at limit on this side");
        require(shares > stake, "Odds at limit on this side");
    }

    /// @dev What a winner receives: the gross payout less the win fee on the profit
    function _netPayout(uint256 stake, uint256 gross, uint256 feeBps) internal pure returns (uint256) {
        return gross - ((gross - stake) * feeBps) / BPS;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 r) {
        if (x == 0) return 0;
        r = 1 << (_log2(x) / 2 + 1);
        for (uint256 i = 0; i < 7; i++) r = (r + x / r) >> 1;
        uint256 r2 = x / r;
        if (r2 < r) r = r2;
    }

    function _log2(uint256 x) private pure returns (uint256 n) {
        for (uint256 k = 128; k > 0; k >>= 1) {
            if (x >> k > 0) {
                x >>= k;
                n += k;
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Prices and settlement (permissionless)
    // ---------------------------------------------------------------------------------------------

    struct PriceUpdate {
        bytes32 marketId;
        uint256 ts;
        SignedPrice[] reports;
    }

    /// @notice Records signed prices (already-recorded ones are skipped), then settles `betIds`
    /// (bets not settleable yet are skipped), so one keeper batch never fails on a race.
    function recordAndSettle(PriceUpdate[] calldata updates, uint256[] calldata betIds) external nonReentrant {
        for (uint256 i = 0; i < updates.length; i++) {
            _record(updates[i]);
        }
        for (uint256 i = 0; i < betIds.length; i++) {
            _settle(betIds[i]);
        }
    }

    function _record(PriceUpdate calldata u) internal {
        Market storage m = markets[u.marketId];
        require(m.feedId != bytes32(0), "Unknown market");
        require(u.ts % REPORT_INTERVAL == 0, "Not a report time");
        require(u.ts <= block.timestamp, "Future report time");
        if (prices[u.marketId][u.ts] != 0) return;
        uint256 price = _verifiedMedian(m.feedId, u.ts * 1000, u.reports);
        prices[u.marketId][u.ts] = price;
        emit PriceRecorded(u.marketId, u.ts, price, false);
    }

    /**
     * @dev Final price for (market, ts): the recorded report at ts; after `grace` (the bet's own
     * priceGrace, fixed at placement so the owner cannot retime a pending bet), the earliest recorded
     * report up to MAX_SUBSTITUTE_STEPS marks later, which is then fixed as the price at ts so every bet
     * reads the same one. 0 = not available yet.
     */
    function _finalPrice(bytes32 marketId, uint256 ts, uint256 grace) internal returns (uint256) {
        uint256 p = prices[marketId][ts];
        if (p != 0 || block.timestamp < ts + grace) return p;
        for (uint256 k = 1; k <= MAX_SUBSTITUTE_STEPS; k++) {
            uint256 later = prices[marketId][ts + k * REPORT_INTERVAL];
            if (later != 0) {
                prices[marketId][ts] = later;
                emit PriceRecorded(marketId, ts, later, true);
                return later;
            }
        }
        return 0;
    }

    function _settle(uint256 betId) internal {
        if (betId >= _bets.length) return;
        Bet storage b = _bets[betId];
        if (b.status != Status.Pending) return;
        uint256 endTs = uint256(b.startTs) + b.duration;
        if (block.timestamp < endTs) return;

        uint256 startPrice = _finalPrice(b.marketId, b.startTs, b.priceGrace);
        uint256 endPrice = startPrice == 0 ? 0 : _finalPrice(b.marketId, endTs, b.priceGrace);
        Status result;
        if (startPrice == 0 || endPrice == 0) {
            if (block.timestamp < endTs + b.voidAfter) return; // wait for the price
            result = Status.Void;
        } else if (endPrice == startPrice) {
            result = Status.Push;
        } else if ((endPrice > startPrice) == (b.side == Side.Up)) {
            result = Status.Won;
        } else {
            result = Status.Lost;
        }

        address player = b.player;
        uint256 stake = b.stake;
        uint256 payout = b.payout;
        b.status = result;
        pendingBets[player] -= 1;
        lockedPayouts -= payout;
        betsSettled += 1;

        uint256 paid;
        if (result == Status.Won) {
            // The vault pays the gross payout; the fee on the profit goes to the treasury
            paid = _netPayout(stake, payout, b.winFeeBps);
            vaultAssets -= payout;
            treasury += payout - paid;
        } else if (result == Status.Push || result == Status.Void) {
            paid = stake;
            // The jackpot cut taken from this stake at placement never played, so give it back to the
            // vault rather than the vault alone funding the refund (capped: older jackpots may already
            // have paid it out).
            uint256 cutBack = b.cut;
            if (cutBack > jackpotPot) cutBack = jackpotPot;
            jackpotPot -= cutBack;
            vaultAssets -= (paid - cutBack);
        }
        if (paid > 0) {
            balances[player] += paid;
            totalBalances += paid;
            totalPaidOut += paid;
        }

        if (b.streakBet) {
            if (result == Status.Won) {
                uint256 s = streak[player] + 1;
                uint256 minStake = s == 1 || stake < streakMinStake[player] ? stake : streakMinStake[player];
                streak[player] = s;
                streakMinStake[player] = minStake;
                StreakRules memory r = _streakRules[player];
                if (s >= r.streak) _payJackpot(player, betId, s, minStake, r.shareBps, r.capMultiple);
            } else if (result == Status.Lost) {
                streak[player] = 0;
            }
        }
        emit BetSettled(betId, player, b.marketId, result, paid, startPrice, endPrice, streak[player]);
    }

    function _payJackpot(address player, uint256 betId, uint256 s, uint256 minStake, uint256 shareBps, uint256 capMultiple) internal {
        uint256 amount = (jackpotPot * shareBps) / BPS;
        uint256 cap = minStake * capMultiple;
        if (amount > cap) amount = cap;
        streak[player] = 0;
        if (amount == 0) return;
        jackpotPot -= amount;
        balances[player] += amount;
        totalBalances += amount;
        totalPaidOut += amount;
        emit JackpotWon(player, betId, amount, s);
    }

    // ---------------------------------------------------------------------------------------------
    // Player balance
    // ---------------------------------------------------------------------------------------------

    /// @notice Withdraws `amount` of the in-game balance to the wallet (0 = all of it)
    function withdrawBalance(uint256 amount) external nonReentrant {
        uint256 bal = balances[msg.sender];
        if (amount == 0) amount = bal;
        require(amount > 0 && amount <= bal, "Nothing to withdraw");
        balances[msg.sender] = bal - amount;
        totalBalances -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
        emit BalanceWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Vault (liquidity providers)
    // ---------------------------------------------------------------------------------------------

    /// @notice Vault value if every pending bet loses (the price a deposit pays per share)
    function vaultValue() public view returns (uint256) {
        return vaultAssets;
    }

    function freeLiquidity() public view returns (uint256) {
        return vaultAssets - lockedPayouts;
    }

    function addLiquidity() external payable nonReentrant returns (uint256 minted) {
        require(!paused, "Paused");
        require(msg.value > 0, "Nothing deposited");
        // Priced as if every pending bet loses: a depositor who knows a result cannot buy in cheap ahead of it
        uint256 value = vaultValue();
        if (totalShares == 0) {
            // If every LP fully exited while a bet was still pending (each takes exactly the free
            // liquidity, leaving the locked reserve behind), a later loss on that bet leaves its
            // reserve sitting here unclaimed by any share. Without this, the next depositor would
            // mint shares 1:1 against their own deposit but end up owning that leftover too - a
            // windfall that was never theirs. Sweep it to the treasury (house profit) instead, never
            // touching the part still reserved for a pending bet.
            if (vaultAssets > lockedPayouts) {
                uint256 orphaned = vaultAssets - lockedPayouts;
                treasury += orphaned;
                vaultAssets -= orphaned;
            }
            minted = msg.value;
        } else {
            require(value > 0, "Vault has no value");
            minted = (msg.value * totalShares) / value;
        }
        require(minted > 0, "Deposit too small");
        vaultAssets += msg.value;
        totalShares += minted;
        shares[msg.sender] += minted;
        lpUnlockAt[msg.sender] = block.timestamp + lpLockSeconds;
        emit LiquidityAdded(msg.sender, msg.value, minted);
    }

    function removeLiquidity(uint256 shareAmount) external nonReentrant returns (uint256 amount) {
        require(shareAmount > 0 && shareAmount <= shares[msg.sender], "Not enough shares");
        require(block.timestamp >= lpUnlockAt[msg.sender], "Deposit still locked");
        // Priced as if every pending bet wins: an LP who knows a loss is coming cannot leave ahead of it,
        // and the reserve behind pending bets always stays in the vault
        amount = (shareAmount * freeLiquidity()) / totalShares;
        require(amount > 0, "Nothing withdrawable right now");
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        vaultAssets -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
        emit LiquidityRemoved(msg.sender, amount, shareAmount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function betCount() external view returns (uint256) {
        return _bets.length;
    }

    function bets(uint256 betId) external view returns (Bet memory) {
        return _bets[betId];
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    struct HouseInfo {
        uint256 marginBps;
        uint256 winFeeBps;
        uint256 maxSkewBps;
        uint256 liquidityBps;
        uint256 treasury;
        uint256 jackpotCutBps;
        uint256 minBet;
        uint256 minLead;
        uint256 maxStake;
        uint256 jackpotPot;
        uint256 jackpotStreak;
        uint256 jackpotShareBps;
        uint256 jackpotCapMultiple;
        uint256 vaultAssets;
        uint256 lockedPayouts;
        uint256 vaultValue;
        uint256 totalShares;
        uint256 totalWagered;
        uint256 totalPaidOut;
        uint256 betsSettled;
        bool paused;
        uint256 lpLockSeconds;
        uint256 priceGrace;
    }

    struct PlayerInfo {
        uint256 balance;
        uint256 streak;
        uint256 streakMinStake;
        uint256 pendingBets;
        uint256 shares;
        uint256 lpUnlockAt;
    }

    /// @notice Everything the app shows about the house, in one call
    function houseInfo() external view returns (HouseInfo memory h) {
        h = HouseInfo({
            marginBps: marginBps,
            winFeeBps: winFeeBps,
            maxSkewBps: maxSkewBps,
            liquidityBps: liquidityBps,
            treasury: treasury,
            jackpotCutBps: jackpotCutBps,
            minBet: minBet,
            minLead: minLead,
            maxStake: maxStake(),
            jackpotPot: jackpotPot,
            jackpotStreak: jackpotStreak,
            jackpotShareBps: jackpotShareBps,
            jackpotCapMultiple: jackpotCapMultiple,
            vaultAssets: vaultAssets,
            lockedPayouts: lockedPayouts,
            vaultValue: vaultValue(),
            totalShares: totalShares,
            totalWagered: totalWagered,
            totalPaidOut: totalPaidOut,
            betsSettled: betsSettled,
            paused: paused,
            lpLockSeconds: lpLockSeconds,
            priceGrace: priceGrace
        });
    }

    /// @notice A player's balance, streak and vault position, in one call
    function playerInfo(address player) external view returns (PlayerInfo memory) {
        return PlayerInfo(balances[player], streak[player], streakMinStake[player], pendingBets[player], shares[player], lpUnlockAt[player]);
    }

    /// @notice Largest stake accepted right now at even odds (the max-win limit against the free vault).
    /// On the side the window leans to the limit is a little higher, on the other a little lower; the
    /// exact answer for a bet is its quote.
    function maxStake() public view returns (uint256) {
        // At even odds the gross payout is stake * 2/(1+m), so the profit is stake * (1-m)/(1+m)
        return (((freeLiquidity() * maxWinBps) / BPS) * (BPS + marginBps)) / (BPS - marginBps);
    }

    struct Quote {
        uint256 payout;       // what the player receives on a win (after the win fee)
        uint256 grossPayout;  // shares bought: what the vault reserves and pays
        uint256 startTs;      // the strike time a bet placed now gets
        uint256 priceBps;     // probability price of this side before the bet (5000 = even)
        uint256 upShares;     // window totals so far (for the Rise / Fall balance)
        uint256 downShares;
        string refused;       // why the bet would be refused ("" = accepted)
    }

    /// @notice Exactly what a bet placed now would get (payout, strike time) or why it would be refused
    function quote(bytes32 marketId, Side side, uint256 duration, uint256 stake) external view returns (Quote memory q) {
        q.startTs = _ceilToInterval(block.timestamp + minLead);
        Window memory w = windows[_windowKey(marketId, q.startTs, duration)];
        uint256 free = vaultAssets - lockedPayouts;
        if (w.liquidity == 0) w.liquidity = uint128((free * liquidityBps) / BPS);
        int256 d = w.net;
        q.upShares = d > 0 ? uint256(d) : 0;
        q.downShares = d < 0 ? uint256(-d) : 0;
        if (w.liquidity == 0) return _refuse(q, "Bet exceeds house limit");
        int256 dSide = side == Side.Up ? d : -d;
        int256 a = int256(ONE / 2) + (dSide * int256(ONE)) / int256(2 * uint256(w.liquidity));
        q.priceBps = a > 0 ? (uint256(a) * BPS) / ONE : 0;
        if (paused) return _refuse(q, "Paused");
        if (!markets[marketId].active) return _refuse(q, "Market inactive");
        if (side != Side.Up && side != Side.Down) return _refuse(q, "Invalid side");
        if (!durationAllowed[duration]) return _refuse(q, "Duration not offered");
        if (stake < minBet) return _refuse(q, "Bet below minimum");
        if (a <= 0) return _refuse(q, "Odds at limit on this side");
        try this.priceView(w.liquidity, w.net, side, stake) returns (uint256 shares) {
            q.grossPayout = shares;
            q.payout = _netPayout(stake, shares, winFeeBps);
            if (shares - stake > (free * maxWinBps) / BPS) q.refused = "Bet exceeds house limit";
        } catch {
            return _refuse(q, "Odds at limit on this side");
        }
    }

    function _refuse(Quote memory q, string memory why) private pure returns (Quote memory) {
        q.refused = why;
        return q;
    }

    /// @dev External so quote() can catch a refusal; pure pricing, no state change
    function priceView(uint128 liquidity, int128 net, Side side, uint256 stake) external view returns (uint256 shares) {
        (shares, ) = _price(Window(liquidity, net), side, stake);
    }

    /// @notice Strike time a bet placed now would get
    function nextStartTs() external view returns (uint256) {
        return _ceilToInterval(block.timestamp + minLead);
    }

    function _ceilToInterval(uint256 t) internal pure returns (uint256) {
        return ((t + REPORT_INTERVAL - 1) / REPORT_INTERVAL) * REPORT_INTERVAL;
    }

    // ---------------------------------------------------------------------------------------------
    // Owner (bounded; never touches player balances, reserved payouts or pending bets)
    // ---------------------------------------------------------------------------------------------

    function setMarket(bytes32 marketId, bytes32 feedId, bool active) external onlyOwner {
        require(feedId != bytes32(0), "Invalid feed");
        Market storage m = markets[marketId];
        if (m.feedId == bytes32(0)) marketIds.push(marketId);
        else require(m.feedId == feedId, "Feed is fixed per market");
        m.feedId = feedId;
        m.active = active;
        emit MarketSet(marketId, feedId, active);
    }

    function setDuration(uint256 duration, bool allowed) external onlyOwner {
        require(duration >= REPORT_INTERVAL && duration <= 1 hours && duration % REPORT_INTERVAL == 0, "Invalid duration");
        durationAllowed[duration] = allowed;
        emit DurationSet(duration, allowed);
    }

    function setParams(
        uint256 _marginBps,
        uint256 _winFeeBps,
        uint256 _jackpotCutBps,
        uint256 _maxWinBps,
        uint256 _minBet,
        uint256 _minLead
    ) external onlyOwner {
        // House margin 1-10% and win fee at most 10% of the profit: the house always has an edge,
        // and players are never charged more than that
        require(_marginBps >= 100 && _marginBps <= 1_000, "Invalid margin");
        require(_winFeeBps <= 1_000, "Invalid win fee");
        require(_jackpotCutBps <= MAX_JACKPOT_CUT_BPS, "Invalid jackpot cut");
        require(_maxWinBps > 0 && _maxWinBps <= 1_000, "Invalid max win");
        require(_minBet > 0, "Invalid min bet");
        require(_minLead >= 3 && _minLead <= 60, "Invalid lead");
        marginBps = _marginBps;
        winFeeBps = _winFeeBps;
        jackpotCutBps = _jackpotCutBps;
        maxWinBps = _maxWinBps;
        minBet = _minBet;
        minLead = _minLead;
        emit ParamsUpdated();
    }

    /// @notice Odds band (max skew from even) and how fast odds move (window liquidity as a share of the
    /// free vault). A band of 0.5 +/- 0.2 at most, so neither side ever pays less than ~1.4x.
    function setOdds(uint256 _maxSkewBps, uint256 _liquidityBps) external onlyOwner {
        require(_maxSkewBps <= 2_000, "Invalid band");
        require(_liquidityBps >= 500 && _liquidityBps <= 50_000, "Invalid liquidity");
        maxSkewBps = _maxSkewBps;
        liquidityBps = _liquidityBps;
        emit ParamsUpdated();
    }

    /// @notice Sends the collected win fees to `to`
    function withdrawTreasury(address to) external onlyOwner nonReentrant {
        uint256 amount = treasury;
        require(amount > 0, "Nothing to withdraw");
        require(to != address(0), "Invalid recipient");
        treasury = 0;
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Transfer failed");
        emit TreasuryWithdrawn(to, amount);
    }

    function setJackpotRules(uint256 _streak, uint256 _shareBps, uint256 _capMultiple) external onlyOwner {
        require(_streak >= 3 && _streak <= 20, "Invalid streak");
        require(_shareBps > 0 && _shareBps <= 5_000, "Invalid share");
        require(_capMultiple > 0 && _capMultiple <= 1_000, "Invalid cap");
        jackpotStreak = _streak;
        jackpotShareBps = _shareBps;
        jackpotCapMultiple = _capMultiple;
        emit ParamsUpdated();
    }

    function setTimeouts(uint256 _priceGrace, uint256 _voidAfter, uint256 _lpLockSeconds) external onlyOwner {
        // Grace at least 2 min (time for anyone to post the exact report); void only after the grace and
        // at least 1 h, at most 23 h (inside the oracle's 24 h history, so the exact price stays postable)
        require(_priceGrace >= 2 minutes && _priceGrace <= 30 minutes, "Invalid grace");
        require(_voidAfter >= 1 hours && _voidAfter <= 23 hours && _voidAfter > _priceGrace, "Invalid void timeout");
        require(_lpLockSeconds <= 7 days, "Invalid LP lock");
        priceGrace = _priceGrace;
        voidAfter = _voidAfter;
        lpLockSeconds = _lpLockSeconds;
        emit ParamsUpdated();
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function proposeOracleSigners(address[] calldata signers, uint256 threshold) external onlyOwner {
        _proposeSigners(signers, threshold);
    }

    function applyOracleSigners() external onlyOwner {
        _applySigners();
    }

    function cancelOracleSignerProposal() external onlyOwner {
        _cancelSignerProposal();
    }
}
