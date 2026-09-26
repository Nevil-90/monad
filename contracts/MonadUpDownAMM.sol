// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AMMMath.sol";
import "./SignedPriceOracle.sol";

/**
 * @title MonadUpDownAMM
 * @author MonadPulse Protocol
 * @notice Fully on-chain, permissionless Up/Down binary options AMM built for Monad Parallel EVM.
 * Prices come from signed oracle reports (RedStone's free public feeds), verified in SignedPriceOracle.
 */
contract MonadUpDownAMM is SignedPriceOracle {
    using AMMMath for uint256;

    enum RoundStatus {
        Inactive,
        Open,       // Accepting bets
        Locked,     // Bets frozen, tracking price toward resolution
        Settled,    // Settled with winning side
        Cancelled   // Uncontested, Tie, or Timeout: Full 100% refunds available
    }

    enum Side {
        None,
        Up,
        Down
    }

    struct Round {
        uint256 roundId;
        uint256 startTimestamp;
        uint256 lockTimestamp;
        uint256 closeTimestamp;
        uint256 lockPrice;     // Normalized 36-decimal ultra-precision price
        uint256 closePrice;    // Normalized 36-decimal ultra-precision price
        uint256 totalUp;
        uint256 totalDown;
        uint256 totalPool;
        uint256 netPayoutPool; // Exact net payout pool for winners (Capital Preservation Guaranteed)
        Side winningSide;
        RoundStatus status;
        address lockKeeper;
        uint256 feeBps;        // Snapshotted protocolTotalFeeBps at round start
        uint256 creatorFeeBps; // Snapshotted creator fee
        uint256 keeperFeeBps;  // Snapshotted keeper fee
        uint256 betCloseTimestamp; // SEC-05: snapshotted betting cutoff (immune to later owner param changes)
        uint256 priceWindow;       // SEC-05: snapshotted oracle report interval in seconds (prices are pinned to its multiples)
        uint256 lockPublishTime;   // SEC-01/02: timestamp (s) of the pinned lock report
        uint256 closePublishTime;  // SEC-01/02: timestamp (s) of the pinned close report
        uint256 upBettors;         // Distinct wallets on Up this round
        uint256 downBettors;       // Distinct wallets on Down this round
    }

    struct UserBet {
        uint256 amount;
        Side side;
        bool claimed;
    }

    struct Market {
        bytes32 marketId;
        address creator;            // Earns 0.1% royalty on all settled volume
        bytes32 feedId;             // Oracle data feed id, e.g. bytes32("BTC")
        string name;                // e.g. "Bitcoin"
        string symbol;              // e.g. "BTC/USD"
        uint256 roundDuration;      // e.g. 60 seconds
        uint256 currentRoundId;
        uint256 totalVolume;
        uint256 creatorFeesAccrued; // Claimable by creator
        bool active;
        bool verified;              // SEC-08: owner-curated flag; UIs should warn on unverified markets
    }

    // Dynamic Protocol Fee Configuration (Zero Hardcoding - Tunable on Mainnet)
    uint256 public creatorFeeBps = 10;        // 0.1% to Market Creator
    uint256 public keeperFeeBps = 10;         // 0.1% to Keeper who calls settleRound (covers gas)
    uint256 public treasuryFeeBps = 130;      // 1.3% to Protocol Treasury
    uint256 public protocolTotalFeeBps = 150; // 1.5% Total

    uint256 public lockBufferSeconds = 10;    // Anti-Frontrunning Buffer before lockTimestamp
    // SEC-01/02: oracle nodes sign a report every `priceWindowSeconds`, on its exact multiples. The lock
    // and close prices are the report at the first multiple at/after the target time: one timestamp,
    // so the caller has no choice of price.
    uint256 public priceWindowSeconds = 10;
    // Past reports cannot be fetched from the free gateway, so if nobody captured a round's report
    // the round is refunded after this timeout instead of waiting hours (SEC-21).
    uint256 public emergencyTimeout = 10 minutes;
    uint256 public minBet = 0.001 ether;       // Minimum bet in native MON
    uint256 public constant MIN_ROUND_DURATION = 30;   // Minimum 30s round
    uint256 public constant MAX_ROUND_DURATION = 86400;// Maximum 1 day

    address public owner;
    address public pendingOwner;  // SEC-07: two-step ownership transfer
    bool public paused;           // SEC-06: blocks new bets & markets; resolution and claims always work

    // On-Chain Market Registry (Zero Database)
    bytes32[] public allMarketIds;
    mapping(bytes32 => Market) public markets;

    // Storage strictly partitioned by (marketId, roundId) for Monad Parallel EVM OCC
    mapping(bytes32 => mapping(uint256 => Round)) public rounds;
    mapping(bytes32 => mapping(uint256 => mapping(address => UserBet))) public userBets;
    
    // Treasury accumulated fees
    mapping(bytes32 => uint256) public treasuryFees;

    // SEC-03: keeper bounties are credited here and pulled via claimKeeperRewards(), never pushed
    mapping(address => uint256) public keeperRewards;

    // All-time amount owed to winners per market (sum of settled rounds' netPayoutPool).
    // Written once per settlement, never on bets, so it adds no contention to the betting path.
    mapping(bytes32 => uint256) public totalWinnings;

    // Reentrancy Guard
    uint256 private _status;
    modifier nonReentrant() {
        require(_status != 2, "ReentrancyGuard: reentrant call");
        _status = 2;
        _;
        _status = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    // Events (Fully Indexable on-chain)
    event ProtocolFeesUpdated(uint256 creatorFeeBps, uint256 keeperFeeBps, uint256 treasuryFeeBps, uint256 protocolTotalFeeBps);
    event ProtocolParametersUpdated(uint256 lockBufferSeconds, uint256 priceWindowSeconds, uint256 emergencyTimeout, uint256 minBet);
    event MarketCreated(
        bytes32 indexed marketId,
        address indexed creator,
        bytes32 indexed feedId,
        string name,
        string symbol,
        uint256 roundDuration
    );
    event RoundStarted(bytes32 indexed marketId, uint256 indexed roundId, uint256 lockTimestamp, uint256 closeTimestamp);
    event BetPlaced(bytes32 indexed marketId, uint256 indexed roundId, address indexed user, Side side, uint256 amount);
    event RoundLocked(bytes32 indexed marketId, uint256 indexed roundId, uint256 lockPrice);
    event RoundSettled(
        bytes32 indexed marketId,
        uint256 indexed roundId,
        uint256 closePrice,
        Side winningSide,
        address indexed keeper,
        uint256 keeperReward
    );
    event RoundCancelled(bytes32 indexed marketId, uint256 indexed roundId, string reason);
    event PayoutClaimed(bytes32 indexed marketId, uint256 indexed roundId, address indexed user, uint256 amount);
    event CreatorFeesClaimed(bytes32 indexed marketId, address indexed creator, uint256 amount);
    event TreasuryWithdrawn(bytes32 indexed marketId, address indexed recipient, uint256 amount);
    event KeeperRewardClaimed(address indexed keeper, uint256 amount);
    event Paused(bool paused);
    event MarketStatusUpdated(bytes32 indexed marketId, bool active, bool verified);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address[] memory signers, uint256 threshold) {
        owner = msg.sender;
        _setSigners(signers, threshold);
        _status = 1;
    }

    // =========================================================================
    // ORACLE SIGNERS: changes are public and take effect only after ORACLE_CHANGE_DELAY (SEC-22)
    // =========================================================================

    function proposeOracleSigners(address[] calldata signers, uint256 threshold) external onlyOwner {
        _proposeSigners(signers, threshold);
    }

    function applyOracleSigners() external onlyOwner {
        _applySigners();
    }

    function cancelOracleSignersProposal() external onlyOwner {
        _cancelSignerProposal();
    }

    /**
     * @notice Dynamically update protocol fees (Zero hardcoding - mainnet governance ready)
     */
    function setProtocolFees(uint256 _creatorFeeBps, uint256 _keeperFeeBps, uint256 _treasuryFeeBps) external onlyOwner {
        uint256 total = _creatorFeeBps + _keeperFeeBps + _treasuryFeeBps;
        require(total <= 1000, "Total fee cannot exceed 10%");
        require(_creatorFeeBps > 0 && _keeperFeeBps > 0, "Fees must be non-zero");
        creatorFeeBps = _creatorFeeBps;
        keeperFeeBps = _keeperFeeBps;
        treasuryFeeBps = _treasuryFeeBps;
        protocolTotalFeeBps = total;
        emit ProtocolFeesUpdated(_creatorFeeBps, _keeperFeeBps, _treasuryFeeBps, total);
    }

    /**
     * @notice Dynamically update operational parameters on-chain.
     * @dev SEC-05: values are snapshotted into each round at start, so changes only affect future rounds.
     */
    function setProtocolParameters(
        uint256 _lockBuffer,
        uint256 _priceWindow,
        uint256 _emergencyTimeout,
        uint256 _minBet
    ) external onlyOwner {
        require(_lockBuffer >= 5 && _lockBuffer <= 60, "Invalid lock buffer");
        require(_priceWindow >= 1 && _priceWindow <= 60, "Invalid price window");
        require(_emergencyTimeout >= 5 minutes && _emergencyTimeout <= 24 hours, "Invalid emergency timeout");
        require(_minBet > 0 && _minBet <= 1 ether, "Invalid min bet");
        lockBufferSeconds = _lockBuffer;
        priceWindowSeconds = _priceWindow;
        emergencyTimeout = _emergencyTimeout;
        minBet = _minBet;
        emit ProtocolParametersUpdated(_lockBuffer, _priceWindow, _emergencyTimeout, _minBet);
    }

    // Public view accessors for backward-compatibility with tests & external contracts
    function PROTOCOL_TOTAL_FEE_BPS() external view returns (uint256) { return protocolTotalFeeBps; }
    function CREATOR_FEE_BPS() external view returns (uint256) { return creatorFeeBps; }
    function KEEPER_FEE_BPS() external view returns (uint256) { return keeperFeeBps; }
    function TREASURY_FEE_BPS() external view returns (uint256) { return treasuryFeeBps; }
    function LOCK_BUFFER_SECONDS() external view returns (uint256) { return lockBufferSeconds; }
    function EMERGENCY_TIMEOUT() external view returns (uint256) { return emergencyTimeout; }
    function MIN_BET() external view returns (uint256) { return minBet; }

    // =========================================================================
    // ADMIN: PAUSE, MARKET CURATION (SEC-06, SEC-08)
    // =========================================================================

    /**
     * @notice SEC-06: Pause blocks new bets and new markets only. Locking, settling, refunds and
     * claims stay callable so user funds can never be frozen by the owner.
     */
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    /**
     * @notice SEC-06: Deactivate a market (e.g. dead feed). The in-flight round can still be resolved
     * and claimed; no new round is chained. Reactivate, then anyone may call startRound().
     */
    function setMarketActive(bytes32 marketId, bool active) external onlyOwner {
        Market storage market = markets[marketId];
        require(market.creator != address(0), "Unknown market");
        market.active = active;
        emit MarketStatusUpdated(marketId, active, market.verified);
    }

    /**
     * @notice SEC-08: Mark a market as matching a canonical, liquid oracle feed for its symbol.
     */
    function setMarketVerified(bytes32 marketId, bool verified) external onlyOwner {
        Market storage market = markets[marketId];
        require(market.creator != address(0), "Unknown market");
        market.verified = verified;
        emit MarketStatusUpdated(marketId, market.active, verified);
    }

    /**
     * @notice Permissionlessly create an Up/Down market for any oracle feed id.
     */
    function createMarket(
        bytes32 feedId,
        string calldata name,
        string calldata symbol,
        uint256 roundDuration
    ) external returns (bytes32 marketId) {
        require(!paused, "Protocol paused");
        require(feedId != bytes32(0), "Invalid feed ID");
        require(roundDuration >= MIN_ROUND_DURATION && roundDuration <= MAX_ROUND_DURATION, "Invalid round duration");
        require(bytes(symbol).length > 0, "Empty symbol");

        // Canonical deterministic market key derived from feed ID, symbol, and round duration
        marketId = keccak256(abi.encodePacked(feedId, symbol, roundDuration));
        // SEC-09: existence keyed on creator, not `active`, so a deactivated market can never be
        // re-created and have its round counter reset over live round storage.
        require(markets[marketId].creator == address(0), "Market already exists");

        markets[marketId] = Market({
            marketId: marketId,
            creator: msg.sender,
            feedId: feedId,
            name: name,
            symbol: symbol,
            roundDuration: roundDuration,
            currentRoundId: 0,
            totalVolume: 0,
            creatorFeesAccrued: 0,
            active: true,
            verified: false
        });

        allMarketIds.push(marketId);

        emit MarketCreated(marketId, msg.sender, feedId, name, symbol, roundDuration);

        // Immediately start Round #1 for this newly created market
        _startRound(marketId);
    }

    /**
     * @notice Starts a new round for a market. Can only succeed if the previous round is settled or cancelled.
     */
    function startRound(bytes32 marketId) external nonReentrant returns (uint256 newRoundId) {
        return _startRound(marketId);
    }

    function _startRound(bytes32 marketId) internal returns (uint256 newRoundId) {
        Market storage market = markets[marketId];
        require(market.active, "Market inactive");

        // Strict Sequencing Check: Prevent rogue spam-incrementation while a round is still active
        if (market.currentRoundId > 0) {
            Round storage prev = rounds[marketId][market.currentRoundId];
            require(
                prev.status == RoundStatus.Settled || prev.status == RoundStatus.Cancelled,
                "Previous round still active"
            );
        }

        newRoundId = market.currentRoundId + 1;
        market.currentRoundId = newRoundId;

        uint256 start = block.timestamp;
        uint256 lock = start + market.roundDuration;
        uint256 close = lock + market.roundDuration;

        Round storage round = rounds[marketId][newRoundId];
        round.roundId = newRoundId;
        round.startTimestamp = start;
        round.lockTimestamp = lock;
        round.closeTimestamp = close;
        round.status = RoundStatus.Open;
        round.feeBps = protocolTotalFeeBps;
        round.creatorFeeBps = creatorFeeBps;
        round.keeperFeeBps = keeperFeeBps;

        // SEC-05: snapshot timing and clamp to half the duration so betting always has a window
        // and the lock/close price windows can never overlap.
        uint256 half = market.roundDuration / 2;
        round.betCloseTimestamp = lock - (lockBufferSeconds < half ? lockBufferSeconds : half);
        round.priceWindow = priceWindowSeconds < half ? priceWindowSeconds : half;

        emit RoundStarted(marketId, newRoundId, lock, close);
    }

    function _startRoundIfActive(bytes32 marketId) internal {
        if (markets[marketId].active) {
            _startRound(marketId);
        }
    }

    /**
     * @notice Places bet on UP side with native MON
     */
    function betUp(bytes32 marketId, uint256 roundId) external payable nonReentrant {
        _placeBet(marketId, roundId, Side.Up, 0);
    }

    /**
     * @notice Places bet on DOWN side with native MON
     */
    function betDown(bytes32 marketId, uint256 roundId) external payable nonReentrant {
        _placeBet(marketId, roundId, Side.Down, 0);
    }

    /**
     * @notice Places bet on UP side with minimum odds / slippage protection
     */
    function betUpWithMinOdds(bytes32 marketId, uint256 roundId, uint256 minMultiplierWad) external payable nonReentrant {
        _placeBet(marketId, roundId, Side.Up, minMultiplierWad);
    }

    /**
     * @notice Places bet on DOWN side with minimum odds / slippage protection
     */
    function betDownWithMinOdds(bytes32 marketId, uint256 roundId, uint256 minMultiplierWad) external payable nonReentrant {
        _placeBet(marketId, roundId, Side.Down, minMultiplierWad);
    }

    function _placeBet(bytes32 marketId, uint256 roundId, Side side, uint256 minMultiplierWad) internal {
        require(!paused, "Protocol paused");
        require(msg.value >= minBet, "Bet below minimum MON");
        Market storage market = markets[marketId];
        require(market.active, "Market inactive");

        Round storage round = rounds[marketId][roundId];
        require(round.status == RoundStatus.Open, "Round not open for bets");
        
        // Anti-frontrunning lock buffer
        require(
            block.timestamp <= round.betCloseTimestamp,
            "Betting window closed (anti-frontrunning cutoff active)"
        );

        UserBet storage userBet = userBets[marketId][roundId][msg.sender];
        require(userBet.side == Side.None || userBet.side == side, "Cannot bet opposing sides in same round");

        // Count each wallet once per round (only its first bet writes the counter)
        if (userBet.amount == 0) {
            if (side == Side.Up) round.upBettors += 1;
            else round.downBettors += 1;
        }

        userBet.amount += msg.value;
        userBet.side = side;

        if (side == Side.Up) {
            round.totalUp += msg.value;
        } else {
            round.totalDown += msg.value;
        }
        round.totalPool += msg.value;

        // Slippage / Min odds protection against predatory pool sniping
        if (minMultiplierWad > 0) {
            uint256 currentMult = AMMMath.calculateMultiplier(
                round.totalPool,
                side == Side.Up ? round.totalUp : round.totalDown,
                round.feeBps
            );
            require(currentMult >= minMultiplierWad, "Slippage: payout multiplier below minimum");
        }

        // Monad OCC Parallel Optimization: We do NOT write to market.totalVolume on every bet
        // to prevent multi-transaction write contention on the same storage slot within the same block!
        emit BetPlaced(marketId, roundId, msg.sender, side, msg.value);
    }

    /**
     * @notice Lock a round. The lock price is PINNED to the signed report at the first
     * priceWindow multiple at/after round.lockTimestamp (SEC-01/02), so neither the caller nor the
     * call time can influence it. See lockReportTimestamp().
     * @param reports Signed reports for that timestamp. May be empty if the round is uncontested.
     */
    function lockRoundWithUpdate(
        bytes32 marketId,
        uint256 roundId,
        SignedPrice[] calldata reports
    ) external nonReentrant {
        Round storage round = rounds[marketId][roundId];
        require(round.status == RoundStatus.Open, "Not open");
        require(block.timestamp >= round.lockTimestamp, "Lock time not reached");

        // SEC-04: no "late lock => cancel" rule. The price is pinned, so lateness gives nobody an option.
        if (round.totalUp == 0 || round.totalDown == 0) {
            round.status = RoundStatus.Cancelled;
            emit RoundCancelled(marketId, roundId, "Uncontested pool: opposite side has zero liquidity");
            _startRoundIfActive(marketId);
        } else {
            (uint256 price, uint256 publishTime) =
                _pinnedPrice(markets[marketId].feedId, reports, round.lockTimestamp, round.priceWindow);
            round.lockPrice = price;
            round.lockPublishTime = publishTime;
            round.lockKeeper = msg.sender; // Record keeper for bounty split
            round.status = RoundStatus.Locked;
            emit RoundLocked(marketId, roundId, price);
        }
    }

    /**
     * @notice Settle a round. The close price is PINNED to the signed report at the first
     * priceWindow multiple at/after round.closeTimestamp (SEC-01/02). See closeReportTimestamp().
     * Stored/stale prices are never read.
     */
    function settleRoundWithUpdate(
        bytes32 marketId,
        uint256 roundId,
        SignedPrice[] calldata reports
    ) external nonReentrant {
        Round storage round = rounds[marketId][roundId];
        require(round.status == RoundStatus.Locked, "Round not locked");
        require(block.timestamp >= round.closeTimestamp, "Close time not reached");

        Market storage market = markets[marketId];
        (uint256 price, uint256 publishTime) =
            _pinnedPrice(market.feedId, reports, round.closeTimestamp, round.priceWindow);
        // Defence in depth: windows cannot overlap (SEC-05 clamp), but never accept a non-later price.
        require(publishTime > round.lockPublishTime, "Close price not after lock price");

        round.closePrice = price;
        round.closePublishTime = publishTime;

        if (price == round.lockPrice) {
            // Genuine tie between two distinct, pinned observations: 100% refund
            round.winningSide = Side.None;
            round.status = RoundStatus.Cancelled;
            emit RoundCancelled(marketId, roundId, "Exact price tie: 100% refund");
        } else {
            round.winningSide = price > round.lockPrice ? Side.Up : Side.Down;
            round.status = RoundStatus.Settled;
            market.totalVolume += round.totalPool;

            uint256 winningPool = round.winningSide == Side.Up ? round.totalUp : round.totalDown;
            uint256 losingPool = round.totalPool - winningPool;

            // Capital Preservation Guarantee:
            // Fee is capped at losing pool so winners are guaranteed >= 1.0x (never negative return).
            uint256 feeRate = round.feeBps;
            uint256 requestedTotalFee = (round.totalPool * feeRate) / 10000;
            uint256 actualTotalFee = requestedTotalFee > losingPool ? losingPool : requestedTotalFee;

            // Exactly record net payout pool for winners
            round.netPayoutPool = round.totalPool - actualTotalFee;
            totalWinnings[marketId] += round.netPayoutPool;

            uint256 keeperReward = _distributeFees(
                marketId, actualTotalFee, round.lockKeeper, feeRate, round.creatorFeeBps, round.keeperFeeBps
            );

            emit RoundSettled(marketId, roundId, price, round.winningSide, msg.sender, keeperReward);
        }

        // Automatically chain-start the next round
        _startRoundIfActive(marketId);
    }

    /**
     * @dev SEC-01/02: the pinned report timestamp is the first multiple of `interval` at/after
     * `target`. Exactly one timestamp qualifies, and _verifiedMedian requires every report to carry
     * it, so the caller has no choice among candidate prices.
     */
    function _pinnedTimestamp(uint256 target, uint256 interval) internal pure returns (uint256) {
        return ((target + interval - 1) / interval) * interval;
    }

    function _pinnedPrice(
        bytes32 feedId,
        SignedPrice[] calldata reports,
        uint256 target,
        uint256 interval
    ) internal view returns (uint256 price, uint256 publishTime) {
        require(reports.length > 0, "Price update required");
        publishTime = _pinnedTimestamp(target, interval);
        // 8-decimal oracle value -> 36-decimal price scale used throughout
        price = _verifiedMedian(feedId, publishTime * 1000, reports) * 1e28;
    }

    /// @notice Timestamp (seconds) of the report that locks this round; the keeper submits reports for it
    function lockReportTimestamp(bytes32 marketId, uint256 roundId) external view returns (uint256) {
        Round storage round = rounds[marketId][roundId];
        return _pinnedTimestamp(round.lockTimestamp, round.priceWindow);
    }

    /// @notice Timestamp (seconds) of the report that settles this round
    function closeReportTimestamp(bytes32 marketId, uint256 roundId) external view returns (uint256) {
        Round storage round = rounds[marketId][roundId];
        return _pinnedTimestamp(round.closeTimestamp, round.priceWindow);
    }

    function _distributeFees(
        bytes32 marketId,
        uint256 actualTotalFee,
        address locker,
        uint256 roundTotalFeeBps,
        uint256 roundCreatorFeeBps,
        uint256 roundKeeperFeeBps
    ) private returns (uint256 keeperReward) {
        if (actualTotalFee == 0 || roundTotalFeeBps == 0) return 0;

        uint256 creatorFee = (actualTotalFee * roundCreatorFeeBps) / roundTotalFeeBps;
        keeperReward = (actualTotalFee * roundKeeperFeeBps) / roundTotalFeeBps;
        uint256 treasuryFee = actualTotalFee - creatorFee - keeperReward;

        markets[marketId].creatorFeesAccrued += creatorFee;
        treasuryFees[marketId] += treasuryFee;

        // SEC-03: credit, never push. A hostile locker contract can no longer burn the settler's gas
        // or revert settlement, because no external call is made to it here.
        if (keeperReward > 0) {
            if (locker != address(0) && locker != msg.sender) {
                uint256 split = keeperReward / 2;
                keeperRewards[locker] += split;
                keeperRewards[msg.sender] += keeperReward - split;
            } else {
                keeperRewards[msg.sender] += keeperReward;
            }
        }
    }

    /**
     * @notice SEC-03: Withdraw accumulated lock/settle bounties.
     */
    function claimKeeperRewards() external nonReentrant {
        uint256 amount = keeperRewards[msg.sender];
        require(amount > 0, "No keeper rewards");
        keeperRewards[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Keeper reward claim failed");
        emit KeeperRewardClaimed(msg.sender, amount);
    }

    /**
     * @notice Emergency timeout refund recovery mechanism.
     * Guaranteed fund safety: If a round remains stuck in Open or Locked past EMERGENCY_TIMEOUT,
     * anyone can cancel it to unlock 100% refunds for all bettors.
     */
    function emergencyRefund(bytes32 marketId, uint256 roundId) external nonReentrant {
        Round storage round = rounds[marketId][roundId];
        require(
            round.status == RoundStatus.Open || round.status == RoundStatus.Locked,
            "Round already resolved"
        );
        require(
            block.timestamp > round.closeTimestamp + emergencyTimeout,
            "Emergency timeout has not expired"
        );

        round.status = RoundStatus.Cancelled;
        emit RoundCancelled(marketId, roundId, "Emergency timeout: unresolved round cancelled for full refund");

        if (markets[marketId].currentRoundId == roundId) {
            _startRoundIfActive(marketId);
        }
    }

    /**
     * @notice Claim payout for a settled or cancelled round
     */
    function claimPayout(bytes32 marketId, uint256 roundId) external nonReentrant {
        UserBet storage userBet = userBets[marketId][roundId][msg.sender];
        require(userBet.amount > 0, "No bet placed");
        require(!userBet.claimed, "Already claimed");

        Round storage round = rounds[marketId][roundId];
        require(
            round.status == RoundStatus.Settled || round.status == RoundStatus.Cancelled,
            "Round not yet resolved"
        );

        userBet.claimed = true;
        uint256 payout = 0;

        if (round.status == RoundStatus.Cancelled) {
            // 100% Full refund with 0 fee deduction
            payout = userBet.amount;
        } else if (round.status == RoundStatus.Settled) {
            require(userBet.side == round.winningSide, "Did not bet on winning side");
            uint256 winningPool = round.winningSide == Side.Up ? round.totalUp : round.totalDown;
            require(winningPool > 0, "Zero winning pool");
            payout = (userBet.amount * round.netPayoutPool) / winningPool;
        }

        require(payout > 0, "No payout due");
        (bool success, ) = payable(msg.sender).call{value: payout}("");
        require(success, "Transfer failed");

        emit PayoutClaimed(marketId, roundId, msg.sender, payout);
    }

    /**
     * @notice Claim payouts across multiple rounds in a single atomic transaction (Max gas efficiency)
     */
    function claimBatch(bytes32 marketId, uint256[] calldata roundIds) external nonReentrant returns (uint256 totalPayout) {
        require(roundIds.length > 0 && roundIds.length <= 100, "Invalid batch size");
        for (uint256 i = 0; i < roundIds.length; i++) {
            uint256 rId = roundIds[i];
            UserBet storage userBet = userBets[marketId][rId][msg.sender];
            if (userBet.amount == 0 || userBet.claimed) continue;
            
            Round storage round = rounds[marketId][rId];
            if (round.status != RoundStatus.Settled && round.status != RoundStatus.Cancelled) continue;
            
            userBet.claimed = true;
            uint256 payout = 0;
            if (round.status == RoundStatus.Cancelled) {
                payout = userBet.amount;
            } else if (round.status == RoundStatus.Settled) {
                if (userBet.side != round.winningSide) continue;
                uint256 winningPool = round.winningSide == Side.Up ? round.totalUp : round.totalDown;
                if (winningPool == 0) continue;
                payout = (userBet.amount * round.netPayoutPool) / winningPool;
            }
            if (payout > 0) {
                totalPayout += payout;
                emit PayoutClaimed(marketId, rId, msg.sender, payout);
            }
        }
        require(totalPayout > 0, "No payout due across batch");
        (bool success, ) = payable(msg.sender).call{value: totalPayout}("");
        require(success, "Transfer failed");
    }

    /**
     * @notice Allows a market creator to claim their accumulated 0.1% commission royalties!
     */
    function claimCreatorFees(bytes32 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(msg.sender == market.creator, "Only market creator can claim royalties");
        uint256 claimable = market.creatorFeesAccrued;
        require(claimable > 0, "No creator fees claimable");

        market.creatorFeesAccrued = 0;
        (bool success, ) = payable(msg.sender).call{value: claimable}("");
        require(success, "Creator fee claim failed");

        emit CreatorFeesClaimed(marketId, msg.sender, claimable);
    }

    // =========================================================================
    // 100% ON-CHAIN STATE GETTERS (ZERO DATABASE NEEDED)
    // =========================================================================

    function getAllMarkets() external view returns (Market[] memory) {
        uint256 count = allMarketIds.length;
        Market[] memory result = new Market[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = markets[allMarketIds[i]];
        }
        return result;
    }

    function getMarketCount() external view returns (uint256) {
        return allMarketIds.length;
    }

    function getRound(bytes32 marketId, uint256 roundId) external view returns (Round memory) {
        return rounds[marketId][roundId];
    }

    function getUserBet(bytes32 marketId, uint256 roundId, address user) external view returns (UserBet memory) {
        return userBets[marketId][roundId][user];
    }

    function getLiveOdds(bytes32 marketId, uint256 roundId)
        external
        view
        returns (
            uint256 upMultiplierWad,
            uint256 downMultiplierWad,
            uint256 totalUp,
            uint256 totalDown,
            uint256 totalPool
        )
    {
        Round storage round = rounds[marketId][roundId];
        totalUp = round.totalUp;
        totalDown = round.totalDown;
        totalPool = round.totalPool;

        uint256 fee = round.feeBps > 0 ? round.feeBps : protocolTotalFeeBps;
        upMultiplierWad = AMMMath.calculateMultiplier(round.totalPool, round.totalUp, fee);
        downMultiplierWad = AMMMath.calculateMultiplier(round.totalPool, round.totalDown, fee);
    }

    function withdrawTreasury(bytes32 marketId, address recipient) external onlyOwner nonReentrant {
        require(recipient != address(0), "Invalid recipient");
        uint256 amount = treasuryFees[marketId];
        require(amount > 0, "No treasury fees");
        treasuryFees[marketId] = 0;
        (bool success, ) = payable(recipient).call{value: amount}("");
        require(success, "Withdraw failed");
        emit TreasuryWithdrawn(marketId, recipient, amount);
    }

    /**
     * @notice Allows safe paginated market retrieval to prevent out-of-gas errors on public RPCs
     */
    function getMarketsPaginated(uint256 cursor, uint256 size)
        external
        view
        returns (Market[] memory result, uint256 nextCursor)
    {
        uint256 total = allMarketIds.length;
        if (cursor >= total || size == 0) {
            return (new Market[](0), cursor);
        }
        uint256 end = cursor + size;
        if (end > total) {
            end = total;
        }
        uint256 count = end - cursor;
        result = new Market[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = markets[allMarketIds[cursor + i]];
        }
        nextCursor = end;
    }

    /**
     * @notice SEC-07: Two-step ownership transfer to a Multi-Sig or Timelock. The new owner must
     * call acceptOwnership(), so a typo'd address can never brick admin control.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
