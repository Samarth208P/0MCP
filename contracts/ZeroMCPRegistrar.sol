// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Interface for the ENS NameWrapper to create subnodes.
 */
interface INameWrapper {
    function setSubnodeRecord(
        bytes32 parentNode,
        string calldata label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node);
}

/**
 * @title ZeroMCPRegistrar
 * @dev A permissionless subname registrar for the 0MCP ecosystem.
 * Any user can call `register` to claim a subname under 0mcp.eth.
 * Requirements: The owner of 0mcp.eth MUST approve this contract 
 * using `setApprovalForAll(ZeroMCPRegistrar, true)` on the NameWrapper.
 */
contract ZeroMCPRegistrar {
    INameWrapper public immutable nameWrapper;
    bytes32 public immutable parentNode; 
    address public immutable publicResolver;

    event SubnameRegistered(string label, address owner);

    /**
     * @param _nameWrapper Address of ENS NameWrapper on Sepolia
     * @param _parentNode The namehash of the domain (e.g., namehash of "0mcp.eth")
     * @param _publicResolver Address of the ENS Public Resolver
     */
    constructor(address _nameWrapper, bytes32 _parentNode, address _publicResolver) {
        nameWrapper = INameWrapper(_nameWrapper);
        parentNode = _parentNode;
        publicResolver = _publicResolver;
    }

    /**
     * @dev Allows anyone to register an unclaimed subname.
     */
    function register(string calldata label, address newOwner) external {
        // Expiry is hardcoded to a safe future block for demo. In prod, it inherits the parent's expiry.
        uint64 demoExpiry = 2524608000; // Jan 1, 2050

        nameWrapper.setSubnodeRecord(
            parentNode,
            label,
            newOwner,
            publicResolver,
            0, // ttl
            0, // fuses (none locked)
            demoExpiry
        );

        emit SubnameRegistered(label, newOwner);
    }
}
