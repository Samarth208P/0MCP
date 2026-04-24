---
name: 0mcp-inft-snapshot
description: Use this skill when building the memory snapshot and iNFT minting feature — exporting project memory to a JSON bundle and minting it as an ERC-7857 iNFT on 0G testnet. Triggers when asked to implement exportSnapshot, mintINFT, or anything touching the iNFT contract or snapshot file format.
---

# iNFT Memory Snapshot — Build Guide

## What This Skill Builds

`src/snapshot.ts` — the feature that turns accumulated project memory into a portable, ownable asset.

Two steps:
1. **Export**: Pull all memory from 0G KV → bundle into a signed JSON file
2. **Mint**: Deploy that bundle as an ERC-7857 iNFT on 0G testnet

For the hackathon: step 1 must work perfectly. Step 2 is a bonus — even a mock mint is fine.

## Install

```bash
npm install ethers
```

## Snapshot Format

```typescript
// The canonical snapshot format — keep this stable
export interface MemorySnapshot {
  version: "1.0";
  project_id: string;
  exported_at: number;           // Unix ms timestamp
  entry_count: number;
  entries: MemoryEntry[];
  metadata: {
    top_keywords: string[];      // Most frequent keywords across all entries
    date_range: {
      first: number;
      last: number;
    };
    file_paths: string[];        // All unique files referenced
  };
}
```

## Full Snapshot Module (src/snapshot.ts)

```typescript
import { ethers } from "ethers";
import { loadAllEntries } from "./storage.js";
import { extractKeywords } from "./context.js";
import type { MemoryEntry } from "./types.js";

export interface MemorySnapshot {
  version: "1.0";
  project_id: string;
  exported_at: number;
  entry_count: number;
  entries: MemoryEntry[];
  metadata: {
    top_keywords: string[];
    date_range: { first: number; last: number };
    file_paths: string[];
  };
}

// ── EXPORT ───────────────────────────────────────────────────────────────────

export async function exportSnapshot(project_id: string): Promise<MemorySnapshot> {
  const entries = await loadAllEntries(project_id);

  if (entries.length === 0) {
    throw new Error(`No memory found for project: ${project_id}`);
  }

  // Compute top keywords across all entries
  const allText = entries
    .map((e) => `${e.prompt} ${e.response} ${e.tags.join(" ")}`)
    .join(" ");
  const keywordFreq: Record<string, number> = {};
  extractKeywords(allText).forEach((kw) => {
    keywordFreq[kw] = (keywordFreq[kw] ?? 0) + 1;
  });
  const topKeywords = Object.entries(keywordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([kw]) => kw);

  // Collect unique file paths
  const filePaths = [...new Set(entries.flatMap((e) => e.file_paths))];

  const timestamps = entries.map((e) => e.timestamp);

  return {
    version: "1.0",
    project_id,
    exported_at: Date.now(),
    entry_count: entries.length,
    entries,
    metadata: {
      top_keywords: topKeywords,
      date_range: {
        first: Math.min(...timestamps),
        last: Math.max(...timestamps),
      },
      file_paths: filePaths,
    },
  };
}

// ── MINT (ERC-7857 iNFT) ─────────────────────────────────────────────────────

// Minimal ERC-7857 ABI — just the mint function
const INFT_ABI = [
  "function mint(address to, string calldata metadataURI) external returns (uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

// 0G testnet iNFT contract — deploy your own or use community one
// For hackathon: deploy the SimpleINFT.sol below first
const INFT_CONTRACT_ADDRESS = process.env.INFT_CONTRACT_ADDRESS ?? "";

export async function mintSnapshot(
  snapshot: MemorySnapshot,
  recipientAddress: string
): Promise<{ tokenId: string; txHash: string }> {
  if (!INFT_CONTRACT_ADDRESS) {
    throw new Error("INFT_CONTRACT_ADDRESS env var not set. Deploy SimpleINFT.sol first.");
  }

  const provider = new ethers.JsonRpcProvider(process.env.ZG_RPC_URL!);
  const signer = new ethers.Wallet(process.env.ZG_PRIVATE_KEY!, provider);
  const contract = new ethers.Contract(INFT_CONTRACT_ADDRESS, INFT_ABI, signer);

  // For hackathon: store snapshot as base64 data URI (no IPFS needed)
  const snapshotJson = JSON.stringify(snapshot);
  const base64 = Buffer.from(snapshotJson).toString("base64");
  const metadataURI = `data:application/json;base64,${base64}`;

  const tx = await contract.mint(recipientAddress, metadataURI);
  const receipt = await tx.wait();

  // Extract tokenId from Transfer event
  const transferEvent = receipt.logs
    .map((log: { topics: string[]; data: string }) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e: { name: string } | null) => e?.name === "Transfer");

  const tokenId = transferEvent?.args?.tokenId?.toString() ?? "unknown";

  return { tokenId, txHash: receipt.hash };
}
```

## Simple iNFT Contract (deploy this to 0G testnet)

Save as `contracts/SimpleINFT.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title SimpleINFT — ERC-7857 inspired intelligence NFT for 0MCP
/// @notice Stores a memory snapshot URI on-chain. Minimal implementation for hackathon.
contract SimpleINFT is ERC721 {
    uint256 private _tokenIdCounter;
    mapping(uint256 => string) private _metadataURIs;

    event SnapshotMinted(
        uint256 indexed tokenId,
        address indexed owner,
        string metadataURI
    );

    constructor() ERC721("0MCP Brain", "BRAIN") {}

    function mint(address to, string calldata metadataURI)
        external
        returns (uint256 tokenId)
    {
        tokenId = _tokenIdCounter++;
        _safeMint(to, tokenId);
        _metadataURIs[tokenId] = metadataURI;
        emit SnapshotMinted(tokenId, to, metadataURI);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        return _metadataURIs[tokenId];
    }
}
```

Deploy with Hardhat or Remix to 0G testnet (chain ID: 16600).
After deploying, set `INFT_CONTRACT_ADDRESS` in your `.env`.

## Demo Script for the Mint

```typescript
// scripts/mint-demo.ts — run this during the demo
import { exportSnapshot, mintSnapshot } from "../src/snapshot.js";

const PROJECT_ID = "demo-project";
const MY_ADDRESS = process.env.MY_WALLET_ADDRESS!;

const snapshot = await exportSnapshot(PROJECT_ID);
console.log(`\n📦 Snapshot ready:`);
console.log(`  Project: ${snapshot.project_id}`);
console.log(`  Entries: ${snapshot.entry_count}`);
console.log(`  Top keywords: ${snapshot.metadata.top_keywords.slice(0, 5).join(", ")}`);

const { tokenId, txHash } = await mintSnapshot(snapshot, MY_ADDRESS);
console.log(`\n🧠 Brain iNFT minted!`);
console.log(`  Token ID: ${tokenId}`);
console.log(`  TX: https://chainscan-newton.0g.ai/tx/${txHash}`);
```

## Definition of Done

- [ ] `exportSnapshot("my-project")` returns valid JSON with all entries
- [ ] Snapshot includes correct metadata (keywords, date range, file paths)
- [ ] `SimpleINFT.sol` deploys to 0G testnet without errors
- [ ] `mintSnapshot` completes and returns a real TX hash
- [ ] TX is visible on 0G testnet explorer
