---
name: 0mcp-server
description: Use this skill when building the core 0MCP server — the MCP JSON-RPC server that intercepts IDE prompts, calls the context engine, and logs responses. Triggers when asked to create the server entrypoint, register MCP tools, set up stdio transport, or wire together the main request/response loop.
---

# 0MCP Core Server — Build Guide

## What This Skill Builds

The MCP server is the entry point. It is a Node.js process that:
1. Speaks the MCP JSON-RPC protocol over stdio
2. Exposes tools that Cursor/VS Code calls automatically
3. Delegates storage to the 0G skill and retrieval to the context engine skill

## Project Setup (run once)

```bash
mkdir 0mcp && cd 0mcp
npm init -y
npm install @modelcontextprotocol/sdk zod
npm install -D typescript ts-node @types/node
```

### tsconfig.json (required — copy exactly)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

### package.json scripts (add these)
```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "ts-node --esm src/index.ts",
    "start": "node build/index.js"
  }
}
```

## File Structure

```
src/
  index.ts          ← MCP server entrypoint (this skill)
  storage.ts        ← 0G read/write (0g-storage skill)
  context.ts        ← keyword retrieval + injection (context-engine skill)
  snapshot.ts       ← iNFT export (inft-snapshot skill)
  types.ts          ← shared TypeScript types
```

## Core Server Pattern (src/index.ts)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { saveMemory, loadMemory } from "./storage.js";
import { buildContext } from "./context.js";

const server = new McpServer({
  name: "0mcp",
  version: "1.0.0",
});

// TOOL 1: Called by the IDE before every prompt
// Retrieves relevant past context from 0G KV
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
      max_entries: z.number().optional().default(5).describe("Max context entries to return"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project_id, prompt, max_entries }) => {
    try {
      const context = await buildContext(project_id, prompt, max_entries);
      return {
        content: [{ type: "text", text: context }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `No prior context found for project: ${project_id}` }],
      };
    }
  }
);

// TOOL 2: Called by the IDE after every response
// Saves interaction to 0G KV + Log
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
        content: [{ type: "text", text: `Memory saved for project: ${project_id}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Warning: memory could not be saved. Error: ${err}` }],
      };
    }
  }
);

// TOOL 3: Export memory snapshot (for iNFT minting)
server.registerTool(
  "export_snapshot",
  {
    description:
      "Export all memory for a project as a portable JSON snapshot. " +
      "Used as the first step before minting a brain iNFT.",
    inputSchema: z.object({
      project_id: z.string().describe("Project to snapshot"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ project_id }) => {
    const { exportSnapshot } = await import("./snapshot.js");
    const snapshot = await exportSnapshot(project_id);
    return {
      content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // NEVER use console.log in stdio servers — it corrupts JSON-RPC
  console.error("0MCP server running on stdio");
}

main().catch(console.error);
```

## Cursor / VS Code Config

Create `.cursor/mcp.json` in your project root:
```json
{
  "mcpServers": {
    "0mcp": {
      "command": "node",
      "args": ["./build/index.js"],
      "env": {
        "ZG_RPC_URL": "https://evmrpc-testnet.0g.ai",
        "ZG_KV_NODE": "http://3.101.147.150:6789",
        "ZG_PRIVATE_KEY": "your_testnet_private_key"
      }
    }
  }
}
```

## Critical Rules

- NEVER use `console.log()` anywhere in the server — it breaks MCP stdio
- Always use `console.error()` for debug output
- Every tool must return `{ content: [{ type: "text", text: "..." }] }`
- Wrap every tool handler in try/catch — a thrown error crashes the session
- Tool names must be snake_case
- Test with: `npx @modelcontextprotocol/inspector node build/index.js`

## Types File (src/types.ts)

```typescript
export interface MemoryEntry {
  project_id: string;
  prompt: string;
  response: string;
  file_paths: string[];
  tags: string[];
  timestamp: number;
}

export interface ContextResult {
  entries: MemoryEntry[];
  total_found: number;
  injected: number;
}
```

## Definition of Done

- [ ] `npm run build` completes with zero errors
- [ ] MCP Inspector shows `get_context`, `save_memory`, `export_snapshot` tools
- [ ] Cursor can connect and call `get_context` without crashing
- [ ] `save_memory` writes without throwing
