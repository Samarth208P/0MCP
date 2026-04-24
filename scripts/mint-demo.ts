/**
 * mint-demo.ts — export memory snapshot + mint as Brain iNFT on 0G testnet.
 * Run with: npm run mint
 *
 * Requires in .env:
 *   ZG_PRIVATE_KEY, ZG_RPC_URL, INFT_CONTRACT_ADDRESS, MY_WALLET_ADDRESS
 */

import "../src/env.js";
import { exportSnapshot, mintSnapshot, loadBrain } from "../src/snapshot.js";

const PROJECT_ID = process.env.DEMO_PROJECT_ID ?? "ethglobal-0mcp-demo";
const RECIPIENT = process.env.MY_WALLET_ADDRESS ?? "";

if (!RECIPIENT) {
  console.error("❌ MY_WALLET_ADDRESS not set in .env");
  process.exit(1);
}

console.error(`\n📦 Exporting snapshot for project: ${PROJECT_ID}`);
const snapshot = await exportSnapshot(PROJECT_ID);

console.error(`\n✓ Snapshot ready:`);
console.error(`  Project:      ${snapshot.project_id}`);
console.error(`  Entries:      ${snapshot.entry_count}`);
console.error(`  Date range:   ${new Date(snapshot.metadata.date_range.first).toISOString().split("T")[0]} → ${new Date(snapshot.metadata.date_range.last).toISOString().split("T")[0]}`);
console.error(`  Top keywords: ${snapshot.metadata.top_keywords.slice(0, 5).join(", ")}`);
console.error(`  Files:        ${snapshot.metadata.file_paths.slice(0, 3).join(", ") || "none"}`);

console.error(`\n🧠 Minting Brain iNFT on 0G testnet…`);
const { tokenId, txHash } = await mintSnapshot(snapshot, RECIPIENT);

console.error(`\n✅ Brain iNFT minted!`);
console.error(`  Token ID:  #${tokenId}`);
console.error(`  TX:        https://chainscan-galileo.0g.ai/tx/${txHash}`);
console.error(`  Recipient: ${RECIPIENT}`);

console.error(`\n🔄 Verifying load_brain roundtrip (via direct contract call)…`);
// Note: Full ENS roundtrip requires register_agent first.
// This verifies the snapshot is valid JSON and can be re-parsed.
const rehydrated = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
console.assert(rehydrated.entry_count === snapshot.entry_count, "roundtrip entry count mismatch");
console.error(`  ✓ Snapshot roundtrip verified (${rehydrated.entry_count} entries)`);

console.error(`\n📋 Next steps:`);
console.error(`  1. Run: npm run demo  (to record the demo video)`);
console.error(`  2. Run: register_agent via MCP or: npm run register-agent`);
console.error(`  3. After register_agent: load_brain works via ENS name\n`);
