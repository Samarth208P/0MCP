import "../src/env.js";
import { issueRental } from "../src/ens.js";

const brainEns = process.env.BRAIN_ENS_NAME ?? `${process.env.AGENT_ENS_LABEL ?? "solidity-auditor"}.${process.env.ENS_PARENT_NAME ?? "0mcp.eth"}`;
const renter = process.env.RENTER_ADDRESS ?? process.env.MY_WALLET_ADDRESS ?? "";

if (!renter) {
  console.error("❌ Set RENTER_ADDRESS or MY_WALLET_ADDRESS in .env");
  process.exit(1);
}

console.error(`\n🎟️ Issuing rental subname for ${renter}`);
console.error(`   Parent brain: ${brainEns}`);

const subname = await issueRental(brainEns, renter);

console.error(`\n✅ Rental issued: ${subname}`);
