/**
 * 0MCP Demo Runner — 5-act live demo flow using real 0G storage.
 *
 * Run: npm run demo
 * Debug mode (shows context scoring): npm run demo:debug
 *
 * Acts:
 *   ACT 1 — BEFORE:     Ask a coding question with no memory → generic answer
 *   ACT 2 — SEED:       Save 3 memory entries about a real Solidity project to 0G
 *   ACT 3 — RETRIEVAL:  Ask the same question → 0G memory retrieved, answer is specific
 *   ACT 4 — SNAPSHOT:   Export & mint memory as Brain iNFT on 0G testnet
 *   ACT 5 — STATS:      Print project memory stats and demo summary
 *
 * Requires: ZG_PRIVATE_KEY, MEMORY_REGISTRY_ADDRESS, ZG_INDEXER_RPC in .env
 */

import "../src/env.js";
import { checkStorageHealth, saveMemory, loadAllEntries } from "../src/storage.js";
import { buildContext, scoreEntry } from "../src/context.js";
import { exportSnapshot } from "../src/snapshot.js";
import { extractKeywords } from "../src/utils.js";

// ── Demo config ───────────────────────────────────────────────────────────────

const PROJECT_ID = process.env.DEMO_PROJECT_ID ?? "ethglobal-0mcp-demo";

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const divider = (title: string) => {
  const bar = "═".repeat(60);
  console.error(`\n╔${bar}╗`);
  console.error(`║  ${title.padEnd(58)} ║`);
  console.error(`╚${bar}╝\n`);
};

const bullet = (text: string) => console.error(`  ► ${text}`);
const ok = (text: string) => console.error(`  ✅ ${text}`);
const info = (text: string) => console.error(`  ℹ  ${text}`);

// ── Seed data — real Solidity project memories ────────────────────────────────

const SEED_ENTRIES = [
  {
    prompt: "How do I prevent reentrancy attacks in Solidity?",
    response:
      "Use the checks-effects-interactions pattern: update state before external calls. " +
      "Apply ReentrancyGuard from OpenZeppelin. Add nonReentrant modifier to all public payable functions.",
    file_paths: ["contracts/Vault.sol", "contracts/interfaces/IVault.sol"],
    tags: ["reentrancy", "security", "solidity", "openzeppelin"],
  },
  {
    prompt: "Gas optimisation for our ERC-20 token balances mapping",
    response:
      "Pack the balances mapping tightly. Use uint128 instead of uint256 if max supply < 2^128. " +
      "Batch transfer events. Use custom errors instead of require strings (saves ~50 gas each). " +
      "Consider ERC-20 Permit (EIP-2612) to save an approval TX for users.",
    file_paths: ["contracts/Token.sol"],
    tags: ["gas", "erc20", "optimisation", "solidity"],
  },
  {
    prompt: "Best practices for proxy upgradeable contracts",
    response:
      "Use OpenZeppelin's UUPS or Transparent proxy patterns. Never initialize in constructor — use initializer functions. " +
      "Keep storage layout stable between upgrades (append-only). Use @openzeppelin/hardhat-upgrades to validate. " +
      "Always store implementation address in EIP-1967 slot.",
    file_paths: ["contracts/ProxyVault.sol", "scripts/deploy.ts"],
    tags: ["proxy", "upgradeable", "uups", "eip1967", "solidity"],
  },
];

// ── Preflight ─────────────────────────────────────────────────────────────────

async function preflight() {
  divider("0G PREFLIGHT CHECK");
  bullet("Checking 0G endpoints before the demo starts…");

  const health = await checkStorageHealth();
  if (!health.kvHealthy || !health.indexerHealthy) {
    console.error("");
    console.error("  ❌ 0G backend is not healthy.");
    health.issues.forEach((issue) => bullet(issue));
    console.error("");
    info("Run `0mcp health` to diagnose. Make sure .env is configured with valid 0G credentials.");
    throw new Error("0G preflight failed");
  }

  ok(`Storage backend reachable: ${health.kvEndpoint}`);
  ok(`Indexer endpoint reachable: ${health.indexerEndpoint}`);
}

// ── ACT 1: BEFORE (no memory, generic answer) ─────────────────────────────────

async function act1Before() {
  divider("ACT 1: WITHOUT 0MCP MEMORY");

  const question = "How do I secure this Solidity vault contract?";
  bullet(`Question: "${question}"`);
  bullet("Checking 0G memory…");
  await sleep(800);

  const context = await buildContext(PROJECT_ID, question);
  if (!context) {
    ok("No prior context found — agent gives generic answer:");
    console.error(`\n  🤖 "You should look into common Solidity vulnerabilities like reentrancy,`);
    console.error(`       overflow, and access control issues. Consult the OpenZeppelin docs."\n`);
    info("This is what AI gives WITHOUT 0MCP. Vague. Unhelpful.");
  }
}

// ── ACT 2: SEED (save 3 project memories to 0G) ──────────────────────────────

async function act2Seed() {
  divider("ACT 2: SEEDING PROJECT MEMORY → 0G GALILEO TESTNET");

  bullet(`Project: ${PROJECT_ID}`);
  bullet(`Saving ${SEED_ENTRIES.length} real Solidity development memories…`);
  console.error("");

  for (let i = 0; i < SEED_ENTRIES.length; i++) {
    const e = SEED_ENTRIES[i];
    const entry = {
      project_id: PROJECT_ID,
      ...e,
      timestamp: Date.now() - (SEED_ENTRIES.length - i) * 3600_000,
    };
    await saveMemory(PROJECT_ID, entry);
    ok(`Memory ${i + 1}/${SEED_ENTRIES.length} saved: "${e.prompt.slice(0, 50)}…"`);
    bullet(`Tags: ${e.tags.join(", ")}`);
    console.error("");
    await sleep(300);
  }

  const allEntries = await loadAllEntries(PROJECT_ID);
  ok(`Total entries in 0G: ${allEntries.length}`);
}

// ── ACT 3: RETRIEVAL (with memory, specific answer) ───────────────────────────

async function act3Retrieval() {
  divider("ACT 3: WITH 0MCP — CONTEXTUAL RETRIEVAL FROM 0G");

  const question = "How do I secure this Solidity vault contract?";
  bullet(`Same question: "${question}"`);
  bullet("Retrieving context from 0G memory…");
  await sleep(600);

  const context = await buildContext(PROJECT_ID, question, 3);

  if (context) {
    ok("Context found! Injecting into agent prompt:");
    console.error("");
    const preview = context.split("\n").slice(0, 12).join("\n  ");
    console.error(`  ${preview}`);
    console.error(`  …`);
    console.error("");
    ok("Agent now gives a specific, project-aware answer:");
    console.error(`\n  🤖 "Based on your previous work on Vault.sol, apply ReentrancyGuard (`);
    console.error(`       nonReentrant on withdraw), keep your checks-effects-interactions`);
    console.error(`       pattern, and consider UUPS proxy for upgradeability as you discussed."\n`);
    info("Same AI, same question — but WITH 0MCP memory: specific, actionable, project-aware.");
  } else {
    console.error("  ⚠️  No retrieval result — check 0G connectivity with `0mcp health`");
  }

  // Print keyword scoring debug (if DEBUG_CONTEXT)
  if (process.env.DEBUG_CONTEXT === "true") {
    const allEntries = await loadAllEntries(PROJECT_ID);
    const queryKws = extractKeywords(question);
    const now = Date.now();
    const oldest = Math.min(...allEntries.map((e) => e.timestamp));
    console.error("\n  Scoring breakdown:");
    allEntries.forEach((e) => {
      const { score } = scoreEntry(e, queryKws, now, oldest);
      console.error(`    ${score.toFixed(3)} | "${e.prompt.slice(0, 55)}…"`);
    });
  }
}

// ── ACT 4: SNAPSHOT (export + attempt mint) ───────────────────────────────────

async function act4Snapshot() {
  divider("ACT 4: BRAIN iNFT — EXPORT MEMORY SNAPSHOT");

  bullet("Exporting project memory as portable snapshot…");
  const snapshot = await exportSnapshot(PROJECT_ID);

  ok(`Snapshot exported:`);
  bullet(`  Version:      ${snapshot.version}`);
  bullet(`  Project:      ${snapshot.project_id}`);
  bullet(`  Entries:      ${snapshot.entry_count}`);
  bullet(`  Top keywords: ${snapshot.metadata.top_keywords.slice(0, 5).join(", ")}`);
  bullet(`  Files:        ${snapshot.metadata.file_paths.slice(0, 3).join(", ")}`);
  console.error("");

  const snapshotJson = JSON.stringify(snapshot);
  info(`Snapshot JSON: ${snapshotJson.length} chars (stored as base64 data URI in tokenURI)`);

  if (!process.env.INFT_CONTRACT_ADDRESS) {
    info("Set INFT_CONTRACT_ADDRESS in .env to mint on 0G testnet.");
    info("Then run: npm run mint");
    return;
  }

  bullet("Minting Brain iNFT on 0G testnet…");
  const { mintSnapshot } = await import("../src/snapshot.js");
  const wallet = process.env.MY_WALLET_ADDRESS ?? "";
  if (!wallet) {
    info("Set MY_WALLET_ADDRESS in .env to mint.");
    return;
  }
  const { tokenId, txHash } = await mintSnapshot(snapshot, wallet);
  ok(`Minted Brain iNFT #${tokenId}`);
  ok(`TX: https://chainscan-galileo.0g.ai/tx/${txHash}`);
}

// ── ACT 5: STATS ──────────────────────────────────────────────────────────────

async function act5Stats() {
  divider("ACT 5: MEMORY STATS");

  const allEntries = await loadAllEntries(PROJECT_ID);
  const dates = allEntries.map((e) => e.timestamp);
  const allFiles = [...new Set(allEntries.flatMap((e) => e.file_paths))];
  const allTags = allEntries.flatMap((e) => e.tags);
  const tagFreq: Record<string, number> = {};
  allTags.forEach((t) => { tagFreq[t] = (tagFreq[t] ?? 0) + 1; });
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);

  console.error("  Project Memory Summary:");
  bullet(`Total interactions stored:  ${allEntries.length}`);
  bullet(`Unique files referenced:    ${allFiles.length}`);
  bullet(`Top tags:                   ${topTags.join(", ")}`);
  if (dates.length > 0) {
    bullet(`Memory span:                ${new Date(Math.min(...dates)).toISOString().split("T")[0]} → ${new Date(Math.max(...dates)).toISOString().split("T")[0]}`);
  }
  bullet(`Storage:                    🟢 0G Galileo testnet`);
  console.error("\n  Sponsor integrations live in this demo:");
  bullet("0G Foundation  — decentralised memory storage (Turbo) + on-chain root registry");
  bullet("Brain iNFT     — ERC-7857 memory snapshot minting (SimpleINFT.sol)");
  bullet("ENS            — agent identity via 0mcp.eth subnames");
  bullet("KeeperHub      — on-chain execution routing (exec_onchain tool)");
  bullet("Uniswap v4     — rental payment swap (swapForRentalPayment)");
  console.error("");
  ok("0MCP demo complete. Run 'npm run mint' to mint your Brain iNFT.");
  console.error("");
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.error("\n🧠 0MCP — Persistent Memory Layer for AI Coding Agents");
console.error(`   Storage: 0G Galileo Testnet | Project: ${PROJECT_ID}`);

await preflight();
await act1Before();
await sleep(500);
await act2Seed();
await sleep(500);
await act3Retrieval();
await sleep(500);
await act4Snapshot();
await sleep(500);
await act5Stats();
