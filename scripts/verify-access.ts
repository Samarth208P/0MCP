import "../src/env.js";
import { verifyAccess } from "../src/ens.js";

const subname =
  process.env.RENTAL_SUBNAME ??
  `renter-${(process.env.RENTER_ADDRESS ?? process.env.MY_WALLET_ADDRESS ?? "").slice(2, 10).toLowerCase()}.${process.env.BRAIN_ENS_NAME ?? `${process.env.AGENT_ENS_LABEL ?? "solidity-auditor"}.${process.env.ENS_PARENT_NAME ?? "0mcp.eth"}`}`;

if (!subname || subname.startsWith("renter-.")) {
  console.error("❌ Set RENTAL_SUBNAME or RENTER_ADDRESS/MY_WALLET_ADDRESS in .env");
  process.exit(1);
}

console.error(`\n🔎 Verifying access for ${subname}`);
const result = await verifyAccess(subname);
console.error(JSON.stringify(result, null, 2));
