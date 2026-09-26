// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPyth
 * @notice Subset of the Pyth Network Oracle EVM interface used by MonadPulse
 */
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory price);
    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);

    /**
     * @notice Verifies signed updates and returns, for each id, the FIRST price published at or after
     * minPublishTime (i.e. publishTime >= minPublishTime and prevPublishTime < minPublishTime),
     * provided publishTime <= maxPublishTime. Reverts if no such update is present.
     * Does not write to the on-chain price store.
     */
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PriceFeed[] memory priceFeeds);
}
