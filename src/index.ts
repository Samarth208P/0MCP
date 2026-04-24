/**
 * 0MCP Server — entrypoint.
 * MCP JSON-RPC server over stdio. Intercepts IDE prompts, enriches with
 * 0G memory, and exposes tools for memory management, iNFT creation, and ENS identity.
 *
 * CRITICAL: Never use console.log here. It corrupts the MCP stdio JSON-RPC stream.
 * Use console.error for ALL debug/info output.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { saveMemory, loadAllEntries } from "./storage.js";
import { buildContext } from "./context.js";
import { exportSnapshot, mintSnapshot, loadBrain } from "./snapshot.js";
import { registerAgent, resolveBrain, issueRental, verifyAccess } from "./ens.js";
import { execOnchain } from "./keeper.js";

// ── Server init ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "0mcp",
  version: "1.0.0",
});

// ── TOOL 1: get_context ───────────────────────────────────────────────────────
// Called by the IDE before every prompt — retrieves relevant past context from 0G KV.

server.registerTool(
  "get_context",
  {
    description:
      "Retrieve relevant project memory from 0G decentralized storage. " +
      "Call this at the start of every coding session or before a complex prompt. " +
      "Returns structured context from past interactions in this project.",
    inputSchema: z.object({
      project_id: z.string().describe("Unique identifier for the project/workspace"),
      prompt: z.string().describe("The current user prompt to find relevant context for"),
      max_entries: z.number().optional().default(5).describe("Max context entries to return (default 5)"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project_id, prompt, max_entries }) => {
    try {
      const context = await buildContext(project_id, prompt, max_entries);
      return {
        content: [
          {
            type: "text" as const,
            text: context || `No prior context found for project: ${project_id}`,
          },
        ],
      };
    } catch (err) {
      console.error(`[0MCP] get_context error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `No prior context found for project: ${project_id}` }],
      };
    }
  }
);

// ── TOOL 2: save_memory ───────────────────────────────────────────────────────
// Called by the IDE after every response — saves interaction to 0G KV + Log.

server.registerTool(
  "save_memory",
  {
    description:
      "Save an interaction (prompt + response + metadata) to 0G decentralized storage. " +
      "Call this after every meaningful agent response. " +
      "This builds the project memory over time.",
    inputSchema: z.object({
      project_id: z.string().describe("Unique identifier for the project/workspace"),
      prompt: z.string().describe("The user's prompt"),
      response: z.string().describe("The agent's response"),
      file_paths: z.array(z.string()).optional().describe("Files referenced in this interaction"),
      tags: z.array(z.string()).optional().describe("Keywords or tags for this interaction"),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ project_id, prompt, response, file_paths, tags }) => {
    try {
      const entry = {
        project_id,
        prompt,
        response,
        file_paths: file_paths ?? [],
        tags: tags ?? [],
        timestamp: Date.now(),
      };
      await saveMemory(project_id, entry);
      return {
        content: [{ type: "text" as const, text: `✓ Memory saved for project: ${project_id}` }],
      };
    } catch (err) {
      console.error(`[0MCP] save_memory error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Warning: memory could not be saved. Error: ${err}` }],
      };
    }
  }
);

// ── TOOL 3: export_snapshot ───────────────────────────────────────────────────
// Exports all memory for a project as a portable JSON snapshot (first step for iNFT).

server.registerTool(
  "export_snapshot",
  {
    description:
      "Export all memory for a project as a portable JSON snapshot. " +
      "Used as the first step before minting a Brain iNFT. " +
      "Returns the full snapshot JSON including all entries and metadata.",
    inputSchema: z.object({
      project_id: z.string().describe("Project ID to snapshot"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ project_id }) => {
    try {
      const snapshot = await exportSnapshot(project_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }],
      };
    } catch (err) {
      console.error(`[0MCP] export_snapshot error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error exporting snapshot: ${err}` }],
      };
    }
  }
);

// ── TOOL 4: mint_brain ────────────────────────────────────────────────────────
// Mints a brain snapshot as an ERC-7857 iNFT on 0G testnet.

server.registerTool(
  "mint_brain",
  {
    description:
      "Mint a memory snapshot as an ERC-7857 Brain iNFT on 0G testnet. " +
      "Returns the token ID and transaction hash.",
    inputSchema: z.object({
      project_id: z.string().describe("Project ID to snapshot and mint"),
      wallet: z.string().describe("Recipient wallet address (0x-prefixed)"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ project_id, wallet }) => {
    try {
      const snapshot = await exportSnapshot(project_id);
      const result = await mintSnapshot(snapshot, wallet);
      return {
        content: [{
          type: "text" as const,
          text: `🧠 Brain iNFT minted!\nToken ID: ${result.tokenId}\nTX: https://chainscan-newton.0g.ai/tx/${result.txHash}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] mint_brain error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error minting Brain iNFT: ${err}` }],
      };
    }
  }
);

// ── TOOL 5: load_brain ────────────────────────────────────────────────────────
// Loads an external Brain iNFT into context via ENS name.

server.registerTool(
  "load_brain",
  {
    description:
      "Load an external Brain iNFT into context using its ENS name. " +
      "Example: load_brain('solidity-auditor.brains.0mcp.eth') " +
      "Fetches the snapshot from the minted token and returns it for context injection.",
    inputSchema: z.object({
      ens_name: z.string().describe("ENS name of the Brain iNFT to load (e.g. solidity-auditor.brains.0mcp.eth)"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ ens_name }) => {
    try {
      const snapshot = await loadBrain(ens_name);
      return {
        content: [{
          type: "text" as const,
          text: `✓ Brain loaded: ${ens_name}\nEntries: ${snapshot.entry_count}\nTop keywords: ${snapshot.metadata.top_keywords.slice(0, 5).join(", ")}\n\n${JSON.stringify(snapshot, null, 2)}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] load_brain error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error loading Brain: ${err}` }],
      };
    }
  }
);

// ── TOOL 6: register_agent ────────────────────────────────────────────────────

server.registerTool(
  "register_agent",
  {
    description:
      "Register an ENS name for this 0MCP agent instance on Sepolia testnet. " +
      "Creates agentname.brains.0mcp.eth with metadata text records.",
    inputSchema: z.object({
      project_id: z.string().describe("Project identifier"),
      name: z.string().describe("Agent name (e.g. 'solidity-auditor' → solidity-auditor.brains.0mcp.eth)"),
      description: z.string().optional().describe("Human-readable agent description"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ project_id, name, description }) => {
    try {
      const entries = await loadAllEntries(project_id);
      const ensName = await registerAgent(project_id, name, {
        name,
        description: description ?? "",
        project_id,
        sessions: entries.length,
      });
      return {
        content: [{ type: "text" as const, text: `✓ Agent registered: ${ensName}` }],
      };
    } catch (err) {
      console.error(`[0MCP] register_agent error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error registering agent: ${err}` }],
      };
    }
  }
);

// ── TOOL 7: resolve_brain ─────────────────────────────────────────────────────

server.registerTool(
  "resolve_brain",
  {
    description:
      "Resolve an ENS Brain name to its owner wallet, token ID, and metadata. " +
      "Example: resolve_brain('solidity-auditor.brains.0mcp.eth')",
    inputSchema: z.object({
      ens_name: z.string().describe("ENS name to resolve"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ ens_name }) => {
    try {
      const meta = await resolveBrain(ens_name);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(meta, null, 2) }],
      };
    } catch (err) {
      console.error(`[0MCP] resolve_brain error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error resolving brain: ${err}` }],
      };
    }
  }
);

// ── TOOL 8: issue_rental ──────────────────────────────────────────────────────
// STUB: Roadmap — requires ENS NameWrapper for subname issuance.

server.registerTool(
  "issue_rental",
  {
    description:
      "[STUB] Issue a rental subname access token for a Brain iNFT. " +
      "e.g. renter-alice.solidity-auditor.brains.0mcp.eth " +
      "Full implementation requires ENS NameWrapper — roadmap.",
    inputSchema: z.object({
      brain_ens: z.string().describe("ENS name of the Brain to rent"),
      renter_address: z.string().describe("Wallet address of the renter"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ brain_ens, renter_address }) => {
    try {
      const subname = await issueRental(brain_ens, renter_address);
      return {
        content: [{ type: "text" as const, text: `✓ Rental issued: ${subname}` }],
      };
    } catch (err) {
      console.error(`[0MCP] issue_rental error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error issuing rental: ${err}` }],
      };
    }
  }
);

// ── TOOL 9: verify_access ─────────────────────────────────────────────────────
// STUB: Roadmap — requires ENS NameWrapper for subname verification.

server.registerTool(
  "verify_access",
  {
    description:
      "[STUB] Verify rental access via an ENS subname. " +
      "Full implementation requires ENS NameWrapper — roadmap.",
    inputSchema: z.object({
      subname: z.string().describe("ENS subname to verify (e.g. renter-alice.solidity-auditor.brains.0mcp.eth)"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ subname }) => {
    try {
      const result = await verifyAccess(subname);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      console.error(`[0MCP] verify_access error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error verifying access: ${err}` }],
      };
    }
  }
);

// ── TOOL 10: exec_onchain ─────────────────────────────────────────────────────

server.registerTool(
  "exec_onchain",
  {
    description:
      "Execute an on-chain action via KeeperHub — smart gas estimation, " +
      "private RPC routing, and full execution audit logs. " +
      "Use when the agent suggests a transaction that needs to land on-chain.",
    inputSchema: z.object({
      target: z.string().describe("Target contract address (0x-prefixed)"),
      calldata: z.string().describe("Hex-encoded calldata for the transaction"),
      value: z.string().optional().describe("ETH value to send in wei (optional)"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ target, calldata, value }) => {
    try {
      const result = await execOnchain(target, calldata, value);
      return {
        content: [{
          type: "text" as const,
          text: `✓ On-chain execution complete\nTX: ${result.txHash}\nGas used: ${result.gasUsed}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] exec_onchain error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error executing on-chain: ${err}` }],
      };
    }
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("0MCP server running on stdio — ready for IDE connection");
  console.error(`Tools registered: get_context, save_memory, export_snapshot, mint_brain, load_brain, register_agent, resolve_brain, issue_rental, verify_access, exec_onchain`);
}

main().catch(console.error);
