// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title SimpleINFT — ERC-7857 inspired Brain iNFT for 0MCP
/// @notice Stores an immutable memory snapshot URI on-chain.
///         Metadata URI is a base64-encoded JSON snapshot (no IPFS required).
/// @dev Deploy to 0G Galileo testnet (chain ID 16602) via Foundry:
///      forge create --rpc-url $ZG_RPC_URL --private-key $ZG_PRIVATE_KEY src/SimpleINFT.sol:SimpleINFT
contract SimpleINFT is ERC721 {
    /// @dev Token ID counter (starts at 0)
    uint256 private _tokenIdCounter;

    /// @dev Maps token ID to its immutable metadata URI (base64 data URI)
    mapping(uint256 => string) private _metadataURIs;

    /// @notice Emitted when a new Brain iNFT is minted
    event SnapshotMinted(
        uint256 indexed tokenId,
        address indexed owner,
        string metadataURI
    );

    constructor() ERC721("0MCP Brain", "BRAIN") {}

    /// @notice Mint a new Brain iNFT with an immutable metadata URI
    /// @param to Recipient address (owner of the new token)
    /// @param metadataURI Base64-encoded data URI of the memory snapshot JSON
    /// @return tokenId The newly minted token ID
    function mint(address to, string calldata metadataURI)
        external
        returns (uint256 tokenId)
    {
        tokenId = _tokenIdCounter++;
        _safeMint(to, tokenId);
        _metadataURIs[tokenId] = metadataURI;
        emit SnapshotMinted(tokenId, to, metadataURI);
    }

    /// @notice Returns the metadata URI for a token
    /// @param tokenId The token whose URI to return
    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        _requireOwned(tokenId);
        return _metadataURIs[tokenId];
    }

    /// @notice ERC-7857 compatibility stub — identifies this as an intelligence NFT
    /// @return Human-readable description of the intelligence type
    function intelligence() external pure returns (string memory) {
        return "0MCP Brain iNFT - persistent AI coding agent memory (ERC-7857 compatible)";
    }
}
