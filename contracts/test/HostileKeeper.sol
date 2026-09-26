// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMonadUpDownAMMLock {
    function lockRoundWithUpdate(bytes32 marketId, uint256 roundId, bytes[] calldata priceUpdateData) external payable;
}

/**
 * @title HostileKeeper
 * @notice TEST-ONLY attacker for regression test SEC-03. Locks a round, then burns all gas it is
 * given whenever it receives native tokens, which used to make every honest settle run out of gas.
 */
contract HostileKeeper {
    function lock(address amm, bytes32 marketId, uint256 roundId, bytes[] calldata data) external payable {
        IMonadUpDownAMMLock(amm).lockRoundWithUpdate{value: msg.value}(marketId, roundId, data);
    }

    receive() external payable {
        while (true) {}
    }
}
