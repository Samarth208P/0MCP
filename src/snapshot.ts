/**
 * Brain iNFT — Snapshot, Mint & Load.
 *
 * Three operations:
 *   exportSnapshot  → pull all 0G memory into a portable JSON bundle
 *   mintSnapshot    → encode bundle as base64 data URI + mint ERC-7857 on 0G testnet
 *   loadBrain       → resolve ENS name → fetch tokenURI → decode snapshot
 *
 * @module snapshot
 */

import { ethers } from "ethers";
import "./env.js";
import { loadAllEntries } from "./storage.js";
import { extractKeywords } from "./utils.js";
import type { MemoryEntry, MemorySnapshot, MintResult } from "./types.js";

// ── Environment ───────────────────────────────────────────────────────────────

const getZgRpcUrl = () => process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const getZgPrivateKey = () => process.env.ZG_PRIVATE_KEY ?? "";
const getInftContractAddress = () => process.env.INFT_CONTRACT_ADDRESS ?? "0xd07059e54017BbF424223cb089ffBC5e2558cF56";
const getZgChainId = () => Number(process.env.ZG_CHAIN_ID ?? "16602");

// Sepolia RPC for ENS resolution
const getSepoliaRpcUrl = () => process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

// ── Minimal ERC-7857 ABI (mint + tokenURI + intelligence) ────────────────────

const INFT_ABI = [
  "function mint(address to, string calldata metadataURI) external returns (uint256 tokenId)",
  "function tokenURI(uint256 tokenId) external view returns (string memory)",
  "function intelligence() external view returns (string memory)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

// ── EXPORT ────────────────────────────────────────────────────────────────────

/**
 * Exports all memory for a project into a portable MemorySnapshot bundle.
 * Computes top keywords by frequency across all entries.
 * Throws if the project has no saved entries.
 *
 * @param project_id - Project identifier
 * @returns A complete MemorySnapshot ready for minting or sharing
 */
export async function exportSnapshot(project_id: string): Promise<MemorySnapshot> {
  const entries = await loadAllEntries(project_id);

  if (entries.length === 0) {
    throw new Error(`No memory found for project: ${project_id}. Save some interactions first.`);
  }

  // Compute keyword frequency across all entries
  const allText = entries
    .map((e: MemoryEntry) => `${e.prompt} ${e.response} ${e.tags.join(" ")}`)
    .join(" ");

  const keywordFreq: Record<string, number> = {};
  extractKeywords(allText).forEach((kw) => {
    keywordFreq[kw] = (keywordFreq[kw] ?? 0) + 1;
  });

  const topKeywords = Object.entries(keywordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([kw]) => kw);

  // Unique file paths across all entries
  const filePaths = [...new Set(entries.flatMap((e: MemoryEntry) => e.file_paths))];
  const timestamps = entries.map((e: MemoryEntry) => e.timestamp);

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

// ── MINT ──────────────────────────────────────────────────────────────────────

/**
 * Mints a MemorySnapshot as an ERC-7857 Brain iNFT on 0G testnet.
 * The full snapshot is encoded as a base64 data URI stored on-chain (no IPFS needed).
 *
 * Requires:
 *   - INFT_CONTRACT_ADDRESS set (deploy SimpleINFT.sol via Foundry first)
 *   - ZG_PRIVATE_KEY set with testnet OG tokens
 *
 * @param snapshot - The MemorySnapshot to mint
 * @param recipientAddress - Wallet that receives the NFT
 * @returns Token ID and transaction hash
 */
export async function mintSnapshot(
  snapshot: MemorySnapshot,
  recipientAddress: string
): Promise<MintResult> {
  if (!getInftContractAddress()) {
    throw new Error(
      "INFT_CONTRACT_ADDRESS is not set. Deploy contracts/SimpleINFT.sol via Foundry first."
    );
  }
  if (!getZgPrivateKey()) {
    throw new Error("ZG_PRIVATE_KEY is not set in environment.");
  }

  const provider = new ethers.JsonRpcProvider(getZgRpcUrl(), getZgChainId());
  const signer = new ethers.Wallet(getZgPrivateKey(), provider);
  const contract = new ethers.Contract(getInftContractAddress(), INFT_ABI, signer);

  // Encode snapshot as base64 data URI — no IPFS, no external dependency
  const snapshotJson = JSON.stringify(snapshot);
  const base64 = Buffer.from(snapshotJson).toString("base64");
  const metadataURI = `data:application/json;base64,${base64}`;

  console.error(`[snapshot] Minting to ${recipientAddress} on 0G testnet (chain ${getZgChainId()})…`);
  console.error(`[snapshot] Snapshot: ${snapshot.entry_count} entries, URI length: ${metadataURI.length} chars`);

  const tx = await (contract.mint as (to: string, uri: string) => Promise<ethers.ContractTransactionResponse>)(
    recipientAddress,
    metadataURI
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Transaction receipt is null — mint may have failed");

  // Extract tokenId from Transfer event
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const transferLog = receipt.logs.find((log) => log.topics[0] === transferTopic);
  const tokenId = transferLog
    ? BigInt(transferLog.topics[3]).toString()
    : "unknown";

  console.error(`[snapshot] ✓ Minted token #${tokenId} | TX: ${receipt.hash}`);

  return { tokenId, txHash: receipt.hash };
}

// ── LOAD ──────────────────────────────────────────────────────────────────────

/**
 * Loads an external Brain iNFT into context by ENS name.
 *
 * Resolution flow:
 *   1. Resolve ENS name → get com.0mcp.brain text record (tokenId) + contract address
 *   2. Call tokenURI(tokenId) on the iNFT contract (0G testnet)
 *   3. Decode base64 data URI → JSON → MemorySnapshot
 *
 * @param ensName - ENS name (e.g. 'solidity-auditor.0mcp.eth')
 * @returns The loaded MemorySnapshot ready for context injection
 */
export async function loadBrain(ensName: string): Promise<MemorySnapshot> {
  // Step 1: Resolve ENS on Sepolia to get token ID and contract address
  const sepoliaProvider = new ethers.JsonRpcProvider(getSepoliaRpcUrl());

  const resolver = await sepoliaProvider.getResolver(ensName);
  if (!resolver) {
    throw new Error(`ENS name not found: ${ensName}. Is it registered on Sepolia?`);
  }

  const tokenIdStr = await resolver.getText("com.0mcp.brain");
  const contractAddr = await resolver.getText("com.0mcp.contract");

  if (!tokenIdStr) {
    throw new Error(`No com.0mcp.brain text record set on ${ensName}. Run register_agent first.`);
  }

  const resolvedContract = contractAddr || getInftContractAddress();
  if (!resolvedContract) {
    throw new Error(
      "No contract address: set INFT_CONTRACT_ADDRESS env or com.0mcp.contract text record on ENS."
    );
  }

  // Step 2: Fetch tokenURI from the iNFT contract on 0G testnet
  const zgProvider = new ethers.JsonRpcProvider(getZgRpcUrl(), getZgChainId());
  const contract = new ethers.Contract(resolvedContract, INFT_ABI, zgProvider);

  const tokenId = BigInt(tokenIdStr);
  const uri = await (contract.tokenURI as (id: bigint) => Promise<string>)(tokenId);

  if (!uri) throw new Error(`tokenURI is empty for token #${tokenIdStr}`);

  // Step 3: Decode base64 data URI
  // Format: data:application/json;base64,<base64>
  const base64Match = uri.match(/^data:application\/json;base64,(.+)$/);
  if (!base64Match) {
    throw new Error(`Unexpected tokenURI format from ${ensName}: ${uri.slice(0, 80)}`);
  }

  const json = Buffer.from(base64Match[1], "base64").toString("utf-8");
  const snapshot = JSON.parse(json) as MemorySnapshot;

  console.error(
    `[snapshot] ✓ Brain loaded: ${ensName} → token #${tokenIdStr} | ${snapshot.entry_count} entries`
  );

  return snapshot;
}
