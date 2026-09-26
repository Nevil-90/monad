// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SignedPriceOracle
 * @notice Verifies price reports signed off-chain by a fixed set of oracle nodes, in the public data
 * package format used by RedStone's free gateway (redstone-primary-prod). Independent implementation:
 * no RedStone library code is used.
 *
 * A report covers one feed at one timestamp. Its signed message is
 *
 *   dataFeedId (bytes32) | value (uint256, 8 decimals) | timestampMs (6 bytes) | 32 (4 bytes) | 1 (3 bytes)
 *
 * and each node signs keccak256(message) directly (no Ethereum message prefix).
 *
 * Trust model: a price is accepted only when at least `signerThreshold` distinct authorised nodes
 * signed a report for the exact timestamp asked for; the price used is the median of their values.
 * The signer set can only change through a public proposal that takes effect after
 * ORACLE_CHANGE_DELAY, so users see any change coming and can stop betting before it applies.
 */
abstract contract SignedPriceOracle {
    struct SignedPrice {
        uint256 value;       // 8-decimal fixed point, as signed
        uint256 timestampMs; // report timestamp in milliseconds, as signed
        bytes signature;     // 65 bytes: r | s | v
    }

    struct SignerProposal {
        address[] signers;
        uint256 threshold;
        uint256 eta;         // earliest time the proposal can be applied; 0 = none pending
    }

    uint256 public constant MAX_ORACLE_SIGNERS = 16;
    uint256 public constant ORACLE_CHANGE_DELAY = 2 days;
    uint256 private constant SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address[] private _oracleSigners;
    mapping(address => uint256) private _signerSlot; // index + 1; 0 = not authorised
    uint256 public signerThreshold;
    SignerProposal private _proposal;

    event OracleSignersProposed(address[] signers, uint256 threshold, uint256 eta);
    event OracleSignersUpdated(address[] signers, uint256 threshold);
    event OracleSignersProposalCancelled();

    function oracleSigners() external view returns (address[] memory) {
        return _oracleSigners;
    }

    function pendingOracleSigners() external view returns (address[] memory signers, uint256 threshold, uint256 eta) {
        return (_proposal.signers, _proposal.threshold, _proposal.eta);
    }

    function _validateSigners(address[] memory signers, uint256 threshold) internal pure {
        require(signers.length > 0 && signers.length <= MAX_ORACLE_SIGNERS, "Invalid signer count");
        // A strict majority must agree, so no minority of nodes can set a price on its own
        require(threshold * 2 > signers.length && threshold <= signers.length, "Invalid signer threshold");
        for (uint256 i = 0; i < signers.length; i++) {
            require(signers[i] != address(0), "Zero signer");
            for (uint256 j = 0; j < i; j++) {
                require(signers[i] != signers[j], "Duplicate signer");
            }
        }
    }

    function _setSigners(address[] memory signers, uint256 threshold) internal {
        _validateSigners(signers, threshold);
        for (uint256 i = 0; i < _oracleSigners.length; i++) {
            _signerSlot[_oracleSigners[i]] = 0;
        }
        _oracleSigners = signers;
        for (uint256 i = 0; i < signers.length; i++) {
            _signerSlot[signers[i]] = i + 1;
        }
        signerThreshold = threshold;
        emit OracleSignersUpdated(signers, threshold);
    }

    function _proposeSigners(address[] calldata signers, uint256 threshold) internal {
        _validateSigners(signers, threshold);
        _proposal.signers = signers;
        _proposal.threshold = threshold;
        _proposal.eta = block.timestamp + ORACLE_CHANGE_DELAY;
        emit OracleSignersProposed(signers, threshold, _proposal.eta);
    }

    function _applySigners() internal {
        require(_proposal.eta != 0, "No pending signer change");
        require(block.timestamp >= _proposal.eta, "Signer change still timelocked");
        address[] memory signers = _proposal.signers;
        uint256 threshold = _proposal.threshold;
        delete _proposal;
        _setSigners(signers, threshold);
    }

    function _cancelSignerProposal() internal {
        require(_proposal.eta != 0, "No pending signer change");
        delete _proposal;
        emit OracleSignersProposalCancelled();
    }

    /**
     * @dev Verifies `reports` for `feedId` at exactly `timestampMs` and returns the median value
     * (8 decimals). Every report must carry that timestamp and a valid signature from a distinct
     * authorised signer, and there must be at least `signerThreshold` of them.
     */
    function _verifiedMedian(
        bytes32 feedId,
        uint256 timestampMs,
        SignedPrice[] calldata reports
    ) internal view returns (uint256 median) {
        uint256 n = reports.length;
        require(n >= signerThreshold, "Not enough oracle signatures");
        require(n <= MAX_ORACLE_SIGNERS, "Too many reports");

        uint256[] memory values = new uint256[](n);
        uint256 seen;
        for (uint256 i = 0; i < n; i++) {
            SignedPrice calldata r = reports[i];
            require(r.timestampMs == timestampMs, "Report not at pinned timestamp");
            require(r.value > 0, "Non-positive oracle price");

            bytes32 digest = keccak256(
                abi.encodePacked(feedId, r.value, uint48(r.timestampMs), uint32(32), uint24(1))
            );
            uint256 slot = _signerSlot[_recover(digest, r.signature)];
            require(slot != 0, "Signer not authorised");
            uint256 bit = 1 << (slot - 1);
            require(seen & bit == 0, "Duplicate oracle signer");
            seen |= bit;

            // Insertion sort (n <= 16)
            uint256 v = r.value;
            uint256 j = i;
            while (j > 0 && values[j - 1] > v) {
                values[j] = values[j - 1];
                j--;
            }
            values[j] = v;
        }
        median = n % 2 == 1 ? values[n / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        require(sig.length == 65, "Bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Bad signature v");
        // Reject the malleable high-s twin of a valid signature
        require(uint256(s) <= SECP256K1_HALF_N, "Bad signature s");
        signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "Bad signature");
    }
}
