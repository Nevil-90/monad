// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../SignedPriceOracle.sol";

interface IMonadUpDownAMMLock {
    function lockRoundWithUpdate(bytes32 marketId, uint256 roundId, SignedPriceOracle.SignedPrice[] calldata reports) external;
}

/**
 * @title HostileKeeper
 * @notice TEST-ONLY attacker for regression test SEC-03. Locks a round, then burns all gas it is
 * given whenever it receives native tokens, which used to make every honest settle run out of gas.
 */
contract HostileKeeper {
    function lock(address amm, bytes32 marketId, uint256 roundId, SignedPriceOracle.SignedPrice[] calldata reports) external {
        IMonadUpDownAMMLock(amm).lockRoundWithUpdate(marketId, roundId, reports);
    }

    receive() external payable {
        while (true) {}
    }
}
