/**
 * 0MCP Server — entrypoint.
 * MCP JSON-RPC server over stdio.
 *
 * Changes from original:
 *   - TxLogger.summary() appended to every tool response that performs on-chain writes.
 *   - TxLogger.clear() called before each tool to prevent cross-tool bleed.
 *   - save_memory response includes both upload + registry TX hashes.
 *   - Error messages are user-friendly with actionable hints.
 *
 * CRITICAL: Never use console.log here. It corrupts the MCP stdio JSON-RPC stream.
 */

import { loadLocalEnv } from "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ethers } from "ethers";

import { saveMemory, loadAllEntries } from "./storage.js";
import { buildContext } from "./context.js";
import { exportSnapshot, mintSnapshot, loadBrain } from "./snapshot.js";
import { registerAgent, resolveBrain, issueRental, verifyAccess, renameAgent } from "./ens.js";
import { TxLogger } from "./txlogger.js";
import { startAxlNode, startReceiveLoop, discoverPeers } from "./axl.js";
import { discoverMeshPeers } from "./discovery.js";
import { handleBrainRequest, handleBrainDelivery, requestBrainMemory } from "./exchange.js";
import { mergeBrains } from "./merger.js";
import { extractDecisionRules, scoreContradiction } from "./analysis.js";
import { runIngestion } from "./ingest.js";
import { generateHealthReport } from "./health.js";

// Ensure environment is loaded before server startup
loadLocalEnv();

// Redirect console.log → console.error to protect MCP stdio channel
console.log = function (...args) { console.error(...args); };

// ── Server init ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "0mcp", version: "1.0.0" });

// ── TOOL 1: get_context ───────────────────────────────────────────────────────

server.registerTool(
  "get_context",
  {
    description:
      "CRITICAL PRE-FLIGHT CHECK: Execute at the very beginning of EVERY session. " +
      "Retrieves relevant project memory from 0G decentralised storage. " +
      "Automatically includes drift warnings when past decisions conflict with the current prompt. " +
      "Always call BEFORE answering the user's first question.",
    inputSchema: z.object({
      project_id:    z.string().describe("Unique identifier for the project/workspace"),
      prompt:        z.string().describe("The current user prompt to find relevant context for"),
      max_entries:   z.number().optional().default(5).describe("Max context entries to inject (default 5)"),
      requester_ens: z.string().optional().describe("ENS name of the requester for access verification"),
      include_drift: z.boolean().optional().describe("Include drift/contradiction warnings (default true)"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project_id, prompt, max_entries, requester_ens, include_drift }) => {
    try {
      loadLocalEnv(undefined, project_id);

      if (requester_ens) {
        const access = await verifyAccess(requester_ens);
        if (!access.valid) {
          const brain = await resolveBrain(access.grantedBy || requester_ens).catch(() => null);
          if (!brain || brain.project_id !== project_id) {
            throw new Error(`Unauthorized: ${requester_ens} does not have access to project ${project_id}`);
          }
        }
      }

      // Drift detection is on by default; caller can pass include_drift=false to suppress
      const context = await buildContext(project_id, prompt, max_entries, {
        includeDriftWarnings: include_drift !== false,
      });
      return {
        content: [{
          type: "text" as const,
          text: context || `No prior context found for project: ${project_id}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error retrieving context: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// ── TOOL 2: save_memory ───────────────────────────────────────────────────────

server.registerTool(
  "save_memory",
  {
    description:
      "CRITICAL POST-FLIGHT ACTION: Persist architectural decisions, rules, and key interactions " +
      "to the 0G decentralised network. Call autonomously after any important response — do not " +
      "wait for the user to ask. Future sessions depend on this.",
    inputSchema: z.object({
      project_id: z.string().describe("Unique identifier for the project/workspace"),
      prompt:     z.string().describe("The user's prompt"),
      response:   z.string().describe("The agent's response"),
      file_paths: z.array(z.string()).optional().describe("Files referenced in this interaction"),
      tags:       z.array(z.string()).optional().describe("Keywords or tags for this interaction"),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ project_id, prompt, response, file_paths, tags }) => {
    TxLogger.clear();
    try {
      loadLocalEnv(undefined, project_id);
      const entry = {
        project_id, prompt, response,
        file_paths: file_paths ?? [],
        tags: tags ?? [],
        timestamp: Date.now(),
      };
      const result = await saveMemory(project_id, entry);
      return {
        content: [{
          type: "text" as const,
          text: [
            `✓ Memory saved for project: ${project_id}`,
            ``,
            `0G Storage upload TX:  ${result.txHash}`,
            `  🔗 https://chainscan-galileo.0g.ai/tx/${result.txHash}`,
            `0G Registry update TX: ${result.registryTxHash}`,
            `  🔗 https://chainscan-galileo.0g.ai/tx/${result.registryTxHash}`,
            `Root hash: ${result.rootHash}`,
          ].join("\n"),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Warning: memory could not be saved.\n${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// ── TOOL 3: export_snapshot ───────────────────────────────────────────────────

server.registerTool(
  "export_snapshot",
  {
    description:
      "Export all memory for a project as a portable JSON snapshot. " +
      "First step before minting a Brain iNFT.",
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
      return {
        content: [{ type: "text" as const, text: `Error exporting snapshot: ${err}` }],
      };
    }
  }
);

// ── TOOL 4: mint_brain ────────────────────────────────────────────────────────

server.registerTool(
  "mint_brain",
  {
    description:
      "Mint a memory snapshot as an ERC-7857 Brain iNFT on 0G testnet. " +
      "Returns the token ID, transaction hash, and optional ENS name.",
    inputSchema: z.object({
      project_id: z.string().describe("Project ID to snapshot and mint"),
      wallet:     z.string().describe("Recipient wallet address (0x-prefixed)"),
      ens_name:   z.string().optional().describe("Optional ENS label to register (e.g. 'solidity-auditor')"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ project_id, wallet, ens_name }) => {
    TxLogger.clear();
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
        ensMsg = `\nENS: ${ens_name}.0mcp.eth registered`;
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            `🧠 Brain iNFT minted!${ensMsg}`,
            `Token ID: ${result.tokenId}`,
            `TX: ${result.txHash}`,
            `  🔗 https://chainscan-galileo.0g.ai/tx/${result.txHash}`,
            TxLogger.summary(),
          ].join("\n"),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error minting Brain iNFT: ${err}` }],
      };
    }
  }
);

// ── TOOL 5: load_brain ────────────────────────────────────────────────────────

server.registerTool(
  "load_brain",
  {
    description:
      "Load an external Brain iNFT into context using its ENS name. " +
      "Example: load_brain('solidity-auditor.0mcp.eth')",
    inputSchema: z.object({
      ens_name: z.string().describe("ENS name of the Brain iNFT (e.g. solidity-auditor.0mcp.eth)"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ ens_name }) => {
    try {
      const snapshot = await loadBrain(ens_name);
      return {
        content: [{
          type: "text" as const,
          text: [
            `✓ Brain loaded: ${ens_name}`,
            `Entries: ${snapshot.entry_count}`,
            `Top keywords: ${snapshot.metadata.top_keywords.slice(0, 5).join(", ")}`,
            ``,
            JSON.stringify(snapshot, null, 2),
          ].join("\n"),
        }],
      };
    } catch (err) {
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
      "Register an ENS name for this 0MCP agent on Sepolia testnet. " +
      "Creates agentname.0mcp.eth with metadata text records.",
    inputSchema: z.object({
      project_id:  z.string().describe("Project identifier"),
      name:        z.string().describe("Agent name (e.g. 'solidity-auditor')"),
      description: z.string().optional().describe("Human-readable agent description"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ project_id, name, description }) => {
    TxLogger.clear();
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
        content: [{
          type: "text" as const,
          text: [`✓ Agent registered: ${ensName}`, TxLogger.summary()].join("\n"),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error registering agent: ${err}` }],
      };
    }
  }
);

// ── TOOL 7: rename_agent ──────────────────────────────────────────────────────

server.registerTool(
  "rename_agent",
  {
    description: "Rename an existing Brain's ENS label, transferring all metadata to the new name.",
    inputSchema: z.object({
      old_name:  z.string().describe("Existing ENS label (e.g. 'solidity-auditor.0mcp.eth')"),
      new_label: z.string().describe("New label prefix (e.g. 'new-name')"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ old_name, new_label }) => {
    TxLogger.clear();
    try {
      const ensName = await renameAgent(old_name, new_label);
      return {
        content: [{
          type: "text" as const,
          text: [`✓ Agent renamed to: ${ensName}`, TxLogger.summary()].join("\n"),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error renaming agent: ${err}` }],
      };
    }
  }
);

// ── TOOL 8: resolve_brain ─────────────────────────────────────────────────────

server.registerTool(
  "resolve_brain",
  {
    description: "Resolve an ENS Brain name to its owner wallet, token ID, and metadata.",
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
      return {
        content: [{ type: "text" as const, text: `Error resolving brain: ${err}` }],
      };
    }
  }
);

// ── TOOL 9: issue_rental ──────────────────────────────────────────────────────

server.registerTool(
  "issue_rental",
  {
    description: "Issue a rental subname access token for a Brain iNFT (e.g. renter-alice.brain.0mcp.eth).",
    inputSchema: z.object({
      brain_ens:      z.string().describe("ENS name of the Brain to rent"),
      renter_address: z.string().describe("Wallet address of the renter"),
      duration_days:  z.number().optional().describe("Rental duration in days (default 30)"),
      payment_tx:     z.string().optional().describe("Optional 0G TX hash of the rental payment"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ brain_ens, renter_address, duration_days, payment_tx }) => {
    TxLogger.clear();
    try {
      const subname = await issueRental(brain_ens, renter_address, duration_days, payment_tx);
      return {
        content: [{
          type: "text" as const,
          text: [`✓ Rental issued: ${subname}`, TxLogger.summary()].join("\n"),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error issuing rental: ${err}` }],
      };
    }
  }
);

// ── TOOL 10: verify_access ────────────────────────────────────────────────────

server.registerTool(
  "verify_access",
  {
    description: "Verify rental access via an ENS subname.",
    inputSchema: z.object({
      subname: z.string().describe("ENS subname to verify (e.g. renter-alice.brain.0mcp.eth)"),
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
      return {
        content: [{ type: "text" as const, text: `Error verifying access: ${err}` }],
      };
    }
  }
);



// ── TOOL 13: send_funds ───────────────────────────────────────────────────────

server.registerTool(
  "send_funds",
  {
    description:
      "Transfer tokens on 0G Galileo or Sepolia testnet. " +
      "Use ONLY when the user explicitly asks to send or transfer funds. " +
      "Amount must be in standard decimal format (e.g. '0.01'). Asset must be '0g' or 'eth'.",
    inputSchema: z.object({
      asset:      z.enum(["0g", "eth"]).describe("Asset to send"),
      recipient:  z.string().describe("0x address of the recipient"),
      amount:     z.string().describe("Amount in tokens (e.g. '0.01')"),
      project_id: z.string().optional().describe("Optional project ID to load keys from"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ asset, recipient, amount, project_id }) => {
    TxLogger.clear();
    try {
      if (project_id) loadLocalEnv(undefined, project_id);

      const rpcUrl = asset === "0g"
        ? (process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai")
        : (process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com");
      const pk = process.env.ZG_PRIVATE_KEY ?? "";
      const symbol = asset === "0g" ? "0G" : "ETH";
      const network = asset === "0g" ? "0G Galileo" : "Sepolia";
      const chain   = asset === "0g" ? "0g" : "sepolia" as "0g" | "sepolia";

      if (!pk) throw new Error(`Missing private key for ${asset} in .env`);

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(pk, provider);
      const tx = await wallet.sendTransaction({ to: recipient, value: ethers.parseEther(amount) });
      await tx.wait();

      TxLogger.record({ chain, label: `send ${amount} ${symbol} → ${recipient.slice(0, 10)}…`, txHash: tx.hash, via: "direct" });

      return {
        content: [{
          type: "text" as const,
          text: [
            `✓ Transferred ${amount} ${symbol} to ${recipient} on ${network}`,
            `TX Hash: ${tx.hash}`,
            TxLogger.summary(),
          ].join("\n"),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error transferring funds: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// ── TOOL 11: discover_peers ───────────────────────────────────────────────────

server.tool(
  "discover_peers",
  "Discover 0MCP peers from the registrar-backed peer index. Optionally filter by keyword.",
  {
    keyword: z.string().optional().describe("Keyword to filter by (e.g. 'solidity' or 'smart-contracts')"),
    limit: z.number().optional().describe("Maximum number of peers to return (default 20)"),
  },
  async (input) => {
    try {
      const peers = await discoverMeshPeers({
        keyword: input.keyword,
        limit: input.limit,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(peers, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }] };
    }
  }
);

// ── TOOL 12: request_brain_memory ─────────────────────────────────────────────

server.tool(
  "request_brain_memory",
  "Pay for and import a remote brain's memory into local project.",
  {
    seller_ens: z.string().describe("ENS name of the seller"),
    into_project: z.string().describe("Local project ID to import into"),
  },
  async (input) => {
    try {
      const peers = await discoverPeers([input.seller_ens]);
      if (peers.length === 0) throw new Error("Could not find seller AXL key on ENS");
      
      await requestBrainMemory(input.seller_ens, peers[0].axl_peer_key, input.into_project);
      return {
        content: [{ type: "text", text: `Successfully requested and imported brain from ${input.seller_ens}` }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }] };
    }
  }
);

// ── TOOL 13: merge_brains ─────────────────────────────────────────────────────

server.tool(
  "merge_brains",
  "Merge two brain iNFTs into a new Super-Brain. If owners differ, mints a copy for both.",
  {
    ens_a: z.string().describe("ENS name of first brain"),
    ens_b: z.string().describe("ENS name of second brain"),
    output_label: z.string().describe("ENS label for the new combined brain"),
    criteria: z.array(z.string()).optional().describe("Tags to prioritize during merge"),
  },
  async (input) => {
    try {
      const res = await mergeBrains(input.ens_a, input.ens_b, input.output_label, { criteriaTags: input.criteria });
      return {
        content: [{ type: "text", text: `Merge complete! ${res.synthetic_snapshot.entry_count} entries. New ENS: ${input.output_label}.0mcp.eth` }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }] };
    }
  }
);

// ── TOOL 14: check_drift ──────────────────────────────────────────────────────

server.tool(
  "check_drift",
  "Check whether a prompt contradicts past project decisions. Returns high-confidence conflicts only.",
  {
    project_id: z.string().describe("Project to check rules against"),
    prompt:     z.string().describe("The new prompt or statement to evaluate"),
  },
  async (input) => {
    try {
      loadLocalEnv(undefined, input.project_id);
      const entries = await loadAllEntries(input.project_id);
      const rules = extractDecisionRules(entries);
      const findings = scoreContradiction(input.prompt, rules);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            rules_scanned: rules.length,
            conflicts_found: findings.length,
            findings,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// ── TOOL 15: ingest_repo_state ────────────────────────────────────────────────

server.tool(
  "ingest_repo_state",
  "Auto-ingest git commit history from a repository into project memory. Deduplicates automatically.",
  {
    project_id: z.string().describe("Project to ingest into"),
    repo_path:  z.string().optional().describe("Absolute path to the git repo (defaults to cwd)"),
    since:      z.string().optional().describe("Git ref or date to start from (e.g. HEAD~20)"),
    max_commits: z.number().optional().describe("Max commits to read (default 50)"),
    dry_run:    z.boolean().optional().describe("Preview without writing to storage (default false)"),
  },
  async (input) => {
    try {
      loadLocalEnv(undefined, input.project_id);
      const result = await runIngestion(input.project_id, input.repo_path, {
        since: input.since,
        maxCommits: input.max_commits,
        dryRun: input.dry_run ?? false,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            commits_read:   result.events.length,
            new_events:     result.events.length - result.skipped,
            skipped:        result.skipped,
            entries_saved:  result.saved,
            dry_run:        input.dry_run ?? false,
            sample_entries: result.new_entries.slice(0, 3).map((e) => ({
              prompt: e.prompt.split("\n")[0].slice(0, 80),
              tags:   e.tags,
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// ── TOOL 16: memory_health ────────────────────────────────────────────────────

server.tool(
  "memory_health",
  "Returns a structured health report for a project's memory: entry counts, quality metrics, contradictions, and recommendations.",
  {
    project_id: z.string().describe("Project to audit"),
  },
  async (input) => {
    try {
      loadLocalEnv(undefined, input.project_id);
      const report = await generateHealthReport(input.project_id, false); // no history write from MCP
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("0MCP server running on stdio — ready for IDE connection");
  console.error("Tools: get_context, save_memory, export_snapshot, mint_brain, load_brain, register_agent, rename_agent, resolve_brain, issue_rental, verify_access, send_funds, discover_peers, request_brain_memory, merge_brains");

  if (process.env.AXL_BINARY_PATH || process.env.AXL_PEER_KEY) {
    try {
      await startAxlNode();
      startReceiveLoop(async (envelope) => {
        if (envelope.type === "brain_request") {
          await handleBrainRequest(envelope);
        } else if (envelope.type === "brain_delivery") {
          await handleBrainDelivery(envelope);
        }
      });
    } catch (err) {
      console.error("[axl] Failed to auto-start AXL loop:", err);
    }
  }
}

main().catch(console.error);
