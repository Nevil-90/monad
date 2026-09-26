// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IPyth.sol";

/**
 * @title MockPythOracle
 * @notice TEST-ONLY simulation of Pyth Network price feeds for MonadPulse.
 * @dev Update payloads are NOT signed: each element of updateData is
 *      abi.encode(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, uint64 prevPublishTime).
 *      Never deploy this contract to a network holding real funds.
 */
contract MockPythOracle is IPyth {
    mapping(bytes32 => Price) public prices;

    event PriceUpdated(bytes32 indexed id, int64 price, int32 expo, uint256 publishTime);

    constructor() {
        // Initialize default prices (BTC ~$64,250, ETH ~$2,480, SOL ~$148, MON ~$0.85)
        setPrice(keccak256("BTC/USD"), 6425000000000, 8, -8); // $64,250.00
        setPrice(keccak256("ETH/USD"), 248000000000, 8, -8);  // $2,480.00
        setPrice(keccak256("SOL/USD"), 14800000000, 8, -8);   // $148.00
        setPrice(keccak256("MON/USD"), 85000000, 8, -8);      // $0.8500
    }

    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo) public {
        prices[id] = Price(price, conf, expo, block.timestamp);
        emit PriceUpdated(id, price, expo, block.timestamp);
    }

    function setPriceWithPublishTime(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) public {
        prices[id] = Price(price, conf, expo, publishTime);
        emit PriceUpdated(id, price, expo, publishTime);
    }

    function getPriceUnsafe(bytes32 id) external view override returns (Price memory) {
        return prices[id];
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view override returns (Price memory) {
        Price memory p = prices[id];
        require(p.publishTime > 0, "Feed not initialized");
        require(block.timestamp >= p.publishTime, "Future publish time");
        require(block.timestamp - p.publishTime <= age, "Pyth price feed is stale");
        return p;
    }

    function updatePriceFeeds(bytes[] calldata /* updateData */) external payable override {
        // In mock, accepting updates with optional fee
    }

    function getUpdateFee(bytes[] calldata updateData) public pure override returns (uint256 feeAmount) {
        return updateData.length * 1 wei;
    }

    /**
     * @notice Mirrors Pyth's uniqueness rule: an update matches only if
     * prevPublishTime < minPublishTime <= publishTime <= maxPublishTime.
     */
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable override returns (PriceFeed[] memory priceFeeds) {
        require(msg.value >= getUpdateFee(updateData), "Insufficient fee");
        priceFeeds = new PriceFeed[](priceIds.length);
        for (uint256 i = 0; i < priceIds.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < updateData.length; j++) {
                (bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, uint64 prevPublishTime) =
                    abi.decode(updateData[j], (bytes32, int64, uint64, int32, uint64, uint64));
                if (
                    id == priceIds[i] &&
                    publishTime >= minPublishTime &&
                    publishTime <= maxPublishTime &&
                    prevPublishTime < minPublishTime
                ) {
                    Price memory p = Price(price, conf, expo, publishTime);
                    priceFeeds[i] = PriceFeed(id, p, p);
                    found = true;
                    break;
                }
            }
            require(found, "PriceFeedNotFoundWithinRange");
        }
    }
}
