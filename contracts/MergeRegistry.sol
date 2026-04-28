// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MergeRegistry
/// @notice Records the lineage of 0MCP Brains when they are merged.
contract MergeRegistry {
    struct MergeRecord {
        string parentA;
        string parentB;
        string syntheticEns;
        uint256[] newTokenIds;
        string rootHash;
        uint256 timestamp;
        address creator;
    }

    /// @dev Mapping from ENS name to list of merge records it is involved in
    mapping(string => MergeRecord[]) private _mergeHistory;
    
    /// @dev Also track by synthetic ENS for easy lookup
    mapping(string => MergeRecord) public syntheticToMerge;

    event BrainsMerged(
        string indexed parentA,
        string indexed parentB,
        string indexed syntheticEns,
        uint256[] tokenIds,
        string rootHash
    );

    /// @notice Record a new brain merge
    /// @param parentA ENS name of first parent
    /// @param parentB ENS name of second parent
    /// @param syntheticEns ENS name of the new combined brain
    /// @param newTokenIds Token IDs minted for the new brain (1 or 2 copies)
    /// @param rootHash 0G Storage root hash for the combined memory
    function recordMerge(
        string calldata parentA,
        string calldata parentB,
        string calldata syntheticEns,
        uint256[] calldata newTokenIds,
        string calldata rootHash
    ) external {
        MergeRecord memory record = MergeRecord({
            parentA: parentA,
            parentB: parentB,
            syntheticEns: syntheticEns,
            newTokenIds: newTokenIds,
            rootHash: rootHash,
            timestamp: block.timestamp,
            creator: msg.sender
        });

        // Store history for parents and the new synthetic brain
        _mergeHistory[parentA].push(record);
        _mergeHistory[parentB].push(record);
        _mergeHistory[syntheticEns].push(record);
        
        syntheticToMerge[syntheticEns] = record;

        emit BrainsMerged(parentA, parentB, syntheticEns, newTokenIds, rootHash);
    }

    /// @notice Get all merge history involving a specific ENS name
    function getMergeHistory(string calldata ensName) external view returns (MergeRecord[] memory) {
        return _mergeHistory[ensName];
    }
}
