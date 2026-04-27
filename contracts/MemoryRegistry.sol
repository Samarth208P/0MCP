// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MemoryRegistry
/// @notice Stores the latest 0G Storage root hash for each 0MCP project.
/// @dev Lightweight helper so project memory can live in 0G Storage while the
///      latest root remains discoverable on-chain.
contract MemoryRegistry {
    mapping(bytes32 => string) private _projectRoots;
    mapping(bytes32 => address) private _owners;

    event ProjectRootUpdated(
        bytes32 indexed projectKey,
        string projectId,
        string rootHash,
        address indexed updater
    );

    event ProjectOwnershipTransferred(
        bytes32 indexed projectKey,
        string projectId,
        address indexed oldOwner,
        address indexed newOwner
    );

    modifier onlyProjectOwner(string calldata projectId) {
        bytes32 projectKey = keccak256(bytes(projectId));
        address owner = _owners[projectKey];
        if (owner != address(0)) {
            require(msg.sender == owner, "Only the project owner can update this root.");
        }
        _;
    }

    function setProjectRoot(string calldata projectId, string calldata rootHash) external onlyProjectOwner(projectId) {
        bytes32 projectKey = keccak256(bytes(projectId));
        if (_owners[projectKey] == address(0)) {
            _owners[projectKey] = msg.sender;
            emit ProjectOwnershipTransferred(projectKey, projectId, address(0), msg.sender);
        }
        _projectRoots[projectKey] = rootHash;
        emit ProjectRootUpdated(projectKey, projectId, rootHash, msg.sender);
    }

    function getProjectRoot(string calldata projectId) external view returns (string memory) {
        return _projectRoots[keccak256(bytes(projectId))];
    }

    function getProjectOwner(string calldata projectId) external view returns (address) {
        return _owners[keccak256(bytes(projectId))];
    }

    function transferProjectOwnership(string calldata projectId, address newOwner) external onlyProjectOwner(projectId) {
        bytes32 projectKey = keccak256(bytes(projectId));
        address oldOwner = _owners[projectKey];
        _owners[projectKey] = newOwner;
        emit ProjectOwnershipTransferred(projectKey, projectId, oldOwner, newOwner);
    }
}

