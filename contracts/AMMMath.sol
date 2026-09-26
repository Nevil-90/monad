// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AMMMath
 * @notice Fixed-point arithmetic library for MonadPulse AMM.
 * @dev Enforces rounding DOWN in favor of protocol solvency with overflow-checked arithmetic.
 */
library AMMMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS_DENOMINATOR = 10000;

    /**
     * @notice Computes (x * y) / denominator rounding down with checked overflow protection.
     * Reverts on division by zero or if (x * y) overflows uint256.
     */
    function mulDiv(
        uint256 x,
        uint256 y,
        uint256 denominator
    ) internal pure returns (uint256) {
        require(denominator > 0, "AMMMath: Division by zero");
        if (x == 0 || y == 0) return 0;
        uint256 prod = x * y; // Solidity 0.8+ checks overflow automatically
        return prod / denominator;
    }

    /**
     * @notice Calculates payout multiplier formatted in 18 decimals (WAD)
     * Multiplier = (TotalPool * (10000 - FeeBps)) / SidePool
     */
    function calculateMultiplier(
        uint256 totalPool,
        uint256 sidePool,
        uint256 feeBps
    ) internal pure returns (uint256 multiplierWad) {
        if (sidePool == 0) return 0;
        require(feeBps <= BPS_DENOMINATOR, "AMMMath: Fee exceeds 100%");
        uint256 netPool = mulDiv(totalPool, BPS_DENOMINATOR - feeBps, BPS_DENOMINATOR);
        multiplierWad = mulDiv(netPool, WAD, sidePool);
    }

    /**
     * @notice Calculates user payout amount rounding strictly DOWN
     * Payout = (userBet * netPool) / winningPool
     */
    function calculateUserPayout(
        uint256 userBet,
        uint256 winningPool,
        uint256 totalPool,
        uint256 feeBps
    ) internal pure returns (uint256 payout) {
        if (winningPool == 0 || userBet == 0) return 0;
        require(feeBps <= BPS_DENOMINATOR, "AMMMath: Fee exceeds 100%");
        uint256 netPool = mulDiv(totalPool, BPS_DENOMINATOR - feeBps, BPS_DENOMINATOR);
        payout = mulDiv(userBet, netPool, winningPool);
    }
}
