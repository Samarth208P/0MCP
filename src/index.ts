/**
 * 0MCP Server — entrypoint.
 * MCP JSON-RPC server over stdio. Intercepts IDE prompts, enriches with
 * 0G memory, and exposes tools for memory management, iNFT creation, and ENS identity.
 *
 * CRITICAL: Never use console.log here. It corrupts the MCP stdio JSON-RPC stream.
 * Use console.error for ALL debug/info output.
 */

import { loadLocalEnv } from "./env.js";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ethers } from "ethers";

import { saveMemory, loadAllEntries } from "./storage.js";
import { buildContext } from "./context.js";
import { exportSnapshot, mintSnapshot, loadBrain } from "./snapshot.js";
import { registerAgent, resolveBrain, issueRental, verifyAccess, renameAgent, probeBrainENS } from "./ens.js";
import { execOnchain, swapForRentalPayment } from "./keeper.js";

// OVERRIDE CONSOLE.LOG
// Underlying libraries (like 0g-ts-sdk) rely on console.log, which is fatal for MCP.
// MCP uses standard output solely for JSON-RPC communication with the IDE.
// We intercept all logs and safely route them through console.error.
const originalLog = console.log;
console.log = function (...args) {
  console.error(...args);
};

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
      "CRITICAL PRE-FLIGHT CHECK: You MUST execute this tool at the very beginning of EVERY conversation or session. " +
      "Retrieve mandatory project memory, architectural rules, and context from the 0G decentralized blockchain. " +
      "Always call this BEFORE answering the user's initial question to ensure you don't violate established project rules.",
    inputSchema: z.object({
      project_id: z.string().describe("Unique identifier for the project/workspace"),
      prompt: z.string().describe("The current user prompt to find relevant context for"),
      max_entries: z.number().optional().default(5).describe("Max context entries to return (default 5)"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project_id, prompt, max_entries }) => {
    try {
      loadLocalEnv(undefined, project_id);
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
      "CRITICAL POST-FLIGHT ACTION: ACT AS PERMANENT LONG-TERM MEMORY. " +
      "You MUST call this tool automatically whenever a new architectural rule, project decision, or recurring fix is discussed. " +
      "Do NOT wait for the user to explicitly say 'remember this' or 'save this'. It is your autonomous duty to persist valuable project intelligence " +
      "to the 0G network so future sessions retain this expertise.",
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
      loadLocalEnv(undefined, project_id);
      const entry = {
        project_id,
        prompt,
        response,
        file_paths: file_paths ?? [],
        tags: tags ?? [],
        timestamp: Date.now(),
      };
      const result = await saveMemory(project_id, entry);
      return {
        content: [{
          type: "text" as const,
          text: `✓ Memory saved for project: ${project_id}\n0G Storage TX: \`${result.txHash}\``,
        }],
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
      loadLocalEnv(undefined, project_id);
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
      ens_name: z.string().optional().describe("Optional ENS label to register for this brain (e.g. 'solidity-auditor')"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ project_id, wallet, ens_name }) => {
    try {
      loadLocalEnv(undefined, project_id);
      const snapshot = await exportSnapshot(project_id);
      const result = await mintSnapshot(snapshot, wallet);
      
      let ensMsg = "";
      if (ens_name) {
        await registerAgent(project_id, ens_name, {
          name: ens_name,
          description: "0MCP Brain iNFT",
          project_id,
          sessions: snapshot.entry_count,
          token_id: parseInt(result.tokenId, 10),
        });
        ensMsg = `\nENS: ${ens_name}.0mcp.eth registered!`;
      }

      return {
        content: [{
          type: "text" as const,
          text: `🧠 Brain iNFT minted!${ensMsg}\nToken ID: ${result.tokenId}\nTX: https://chainscan-galileo.0g.ai/tx/${result.txHash}`,
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
      "Example: load_brain('solidity-auditor.0mcp.eth') " +
      "Fetches the snapshot from the minted token and returns it for context injection.",
    inputSchema: z.object({
      ens_name: z.string().describe("ENS name of the Brain iNFT to load (e.g. solidity-auditor.0mcp.eth)"),
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
      "Creates agentname.0mcp.eth with metadata text records.",
    inputSchema: z.object({
      project_id: z.string().describe("Project identifier"),
      name: z.string().describe("Agent name (e.g. 'solidity-auditor' → solidity-auditor.0mcp.eth)"),
      description: z.string().optional().describe("Human-readable agent description"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ project_id, name, description }) => {
    try {
      loadLocalEnv(undefined, project_id);
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

// ── TOOL 6.5: rename_agent ───────────────────────────────────────────────────

server.registerTool(
  "rename_agent",
  {
    description:
      "Rename an existing Agent's ENS Brain label. Ensure the new name is unique. " +
      "It transfers all existing metadata to the new ENS label.",
    inputSchema: z.object({
      old_name: z.string().describe("The existing ENS label (e.g. 'solidity-auditor.0mcp.eth')"),
      new_label: z.string().describe("The new label you want (just the prefix, e.g. 'new-name' for new-name.0mcp.eth)"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ old_name, new_label }) => {
    try {
      const ensName = await renameAgent(old_name, new_label);
      return {
        content: [{ type: "text" as const, text: `✓ Agent successfully renamed to: ${ensName}` }],
      };
    } catch (err) {
      console.error(`[0MCP] rename_agent error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error renaming agent: ${err}` }],
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
      "Example: resolve_brain('solidity-auditor.0mcp.eth')",
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
      "Issue a rental subname access token for a Brain iNFT. " +
      "e.g. renter-alice.solidity-auditor.0mcp.eth",
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
      "Verify rental access via an ENS subname.",
    inputSchema: z.object({
      subname: z.string().describe("ENS subname to verify (e.g. renter-alice.solidity-auditor.0mcp.eth)"),
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

// ── TOOL 11: pay_brain_rental ─────────────────────────────────────────────────

server.registerTool(
  "pay_brain_rental",
  {
    description:
      "Execute a Uniswap v4 auto-swap for an agent rental payment, and route it " +
      "through KeeperHub for MEV protection. Use this to handle Brain rental payments.",
    inputSchema: z.object({
      token_in: z.string().describe("Address of the token to swap from"),
      token_out: z.string().describe("Address of the token to swap to (recipient's preferred token)"),
      amount_in: z.string().describe("Exact input amount in the token's smallest unit (e.g. wei/mwei)"),
      recipient: z.string().describe("Wallet address that receives the output tokens"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ token_in, token_out, amount_in, recipient }) => {
    try {
      const result = await swapForRentalPayment(token_in, token_out, amount_in, recipient);
      return {
        content: [{
          type: "text" as const,
          text: `✓ Rental payment swap complete\nTX: ${result.txHash}\nGas used: ${result.gasUsed}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] pay_brain_rental error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error executing rental payment swap: ${err}` }],
      };
    }
  }
);
// ── TOOL 12: send_funds ─────────────────────────────────────────────────────────

server.registerTool(
  "send_funds",
  {
    description:
      "Transfer tokens on 0G Galileo Testnet or Sepolia Testnet. " +
      "Use this ONLY when the user explicitly asks you to send or transfer funds. " +
      "Amount must be in standard decimal format (e.g. '0.01'). " +
      "Asset must be '0g' or 'eth'.",
    inputSchema: z.object({
      asset: z.enum(["0g", "eth"]).describe("The asset to send (0g or eth)"),
      recipient: z.string().describe("The 0x address of the recipient"),
      amount: z.string().describe("The amount in tokens (e.g., '0.01')"),
      project_id: z.string().optional().describe("Optional project ID to load keys from"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ asset, recipient, amount, project_id }) => {
    try {
      if (project_id) {
        loadLocalEnv(undefined, project_id);
      }
      let rpcUrl = "";
      let pk = "";
      let symbol = "";
      let network = "";

      if (asset === "0g") {
        rpcUrl = process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
        pk = process.env.ZG_PRIVATE_KEY ?? "";
        symbol = "0G";
        network = "0G Galileo";
      } else {
        rpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
        pk = process.env.ENS_PRIVATE_KEY ?? process.env.ZG_PRIVATE_KEY ?? "";
        symbol = "ETH";
        network = "Sepolia";
      }

      if (!pk) throw new Error(`Missing private key for ${asset} in .env`);

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(pk, provider);

      console.error(`[0MCP] AI initiating transfer of ${amount} ${symbol} to ${recipient} on ${network}...`);
      const tx = await wallet.sendTransaction({
        to: recipient,
        value: ethers.parseEther(amount),
      });
      console.error(`[0MCP] Transfer TX submitted: ${tx.hash}`);
      await tx.wait();

      return {
        content: [{
          type: "text" as const,
          text: `✓ Successfully transferred ${amount} ${symbol} to ${recipient} on ${network}\nTX Hash: ${tx.hash}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] send_funds error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error transferring funds: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);
// Background ENS registration moved to `cli.ts` during initialization.


async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("0MCP server running on stdio — ready for IDE connection");
  console.error(`Tools registered: get_context, save_memory, export_snapshot, mint_brain, load_brain, register_agent, resolve_brain, issue_rental, verify_access, exec_onchain, pay_brain_rental, send_funds`);

  // ENS registration has been moved to `0mcp init` to avoid running on-chain commands strictly in the background.
}

main().catch(console.error);
