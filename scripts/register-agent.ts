import "../src/env.js";
import { loadAllEntries } from "../src/storage.js";
import { registerAgent } from "../src/ens.js";

const projectId = process.env.DEMO_PROJECT_ID ?? "ethglobal-0mcp-demo";
const name = process.env.AGENT_ENS_LABEL ?? "solidity-auditor";
const description =
  process.env.AGENT_DESCRIPTION ?? "0MCP Brain agent registered from the local demo";

console.error(`\n🪪 Registering ENS agent for project: ${projectId}`);
console.error(`   Name: ${name}.0mcp.eth`);

const entries = await loadAllEntries(projectId);
const ensName = await registerAgent(projectId, name, {
  name,
  description,
  project_id: projectId,
  sessions: entries.length,
});

console.error(`\n✅ ENS agent registered: ${ensName}`);
console.error("Next steps:");
console.error("- Mint a Brain iNFT and rerun register-agent if you want com.0mcp.brain populated on this name.");
console.error("- Run resolve_brain against the ENS name to confirm the text records.");
