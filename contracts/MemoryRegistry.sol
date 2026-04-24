// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MemoryRegistry
/// @notice Stores the latest 0G Storage root hash for each 0MCP project.
/// @dev Lightweight helper so project memory can live in 0G Storage while the
///      latest root remains discoverable on-chain.
contract MemoryRegistry {
    mapping(bytes32 => string) private _projectRoots;

    event ProjectRootUpdated(
        bytes32 indexed projectKey,
        string projectId,
        string rootHash,
        address indexed updater
    );

    function setProjectRoot(string calldata projectId, string calldata rootHash) external {
        bytes32 projectKey = keccak256(bytes(projectId));
        _projectRoots[projectKey] = rootHash;
        emit ProjectRootUpdated(projectKey, projectId, rootHash, msg.sender);
    }

    function getProjectRoot(string calldata projectId) external view returns (string memory) {
        return _projectRoots[keccak256(bytes(projectId))];
    }
}
