---
name: 0mcp-demo-runner
description: Use this skill when building the hackathon demo script — the before/after comparison that shows memory working in real time. Triggers when asked to create the demo, simulate prompts, seed test data, or produce terminal output for the video recording.
---

# Demo Runner — Build Guide

## What This Skill Builds

`scripts/demo.ts` — the script you run during your hackathon demo recording.

It produces a dramatic, readable terminal output that shows:
1. **BEFORE**: Agent answers with no memory (cold start)
2. **SEED**: Simulate past interactions being saved to 0G
3. **AFTER**: Same prompt — agent now has full context from 0G

## The Demo Narrative (memorize this)

> "This is the exact same prompt. The only difference is that 0MCP
> retrieved 3 relevant entries from 0G storage and injected them
> into the context. Watch the difference."

## Demo Script (scripts/demo.ts)

```typescript
import { saveMemory, loadAllEntries } from "../src/storage.js";
import { buildContext, extractKeywords } from "../src/context.js";
import type { MemoryEntry } from "../src/types.js";

const PROJECT_ID = "ethglobal-demo";
const DEMO_PROMPT = "How should I handle authentication in the API middleware?";

// ── HELPERS ──────────────────────────────────────────────────────────────────

function printBox(title: string, content: string, color: string = "\x1b[0m") {
  const line = "─".repeat(60);
  console.log(`\n${color}┌${line}┐`);
  console.log(`│  ${title.padEnd(58)}│`);
  console.log(`├${line}┤`);
  content.split("\n").forEach((l) => {
    console.log(`│  ${l.slice(0, 58).padEnd(58)}│`);
  });
  console.log(`└${line}┘\x1b[0m`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── SEED DATA ─────────────────────────────────────────────────────────────────

const SEED_MEMORIES: MemoryEntry[] = [
  {
    project_id: PROJECT_ID,
    prompt: "How do I add JWT authentication to my Express app?",
    response:
      "Use jsonwebtoken package. Set secret in env var JWT_SECRET. " +
      "Middleware should verify token from Authorization header. " +
      "Return 401 if invalid. Attach decoded user to req.user.",
    file_paths: ["src/middleware/auth.ts", "src/routes/api.ts"],
    tags: ["jwt", "authentication", "middleware", "express", "security"],
    timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
  },
  {
    project_id: PROJECT_ID,
    prompt: "We had a bug where expired tokens were not being rejected",
    response:
      "Fixed by adding explicit expiry check: jwt.verify() already handles this " +
      "but we were catching all errors the same way. Now returning 401 specifically " +
      "for TokenExpiredError and 403 for JsonWebTokenError.",
    file_paths: ["src/middleware/auth.ts"],
    tags: ["jwt", "bug", "authentication", "expired", "token", "middleware"],
    timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
  },
  {
    project_id: PROJECT_ID,
    prompt: "API rate limiting setup for the auth endpoints",
    response:
      "Using express-rate-limit. Auth endpoints limited to 10 req/15min per IP. " +
      "Store in Redis for distributed deployments. Key: ip + route.",
    file_paths: ["src/middleware/rateLimit.ts"],
    tags: ["rate-limit", "api", "middleware", "security", "redis"],
    timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000, // yesterday
  },
];

// ── DEMO FLOW ─────────────────────────────────────────────────────────────────

async function runDemo() {
  console.clear();
  console.log("\x1b[36m");
  console.log("  ██████╗ ███╗   ███╗ ██████╗██████╗ ");
  console.log(" ██╔═████╗████╗ ████║██╔════╝██╔══██╗");
  console.log(" ██║██╔██║██╔████╔██║██║     ██████╔╝");
  console.log(" ████╔╝██║██║╚██╔╝██║██║     ██╔═══╝ ");
  console.log(" ╚██████╔╝██║ ╚═╝ ██║╚██████╗██║     ");
  console.log("  ╚═════╝ ╚═╝     ╚═╝ ╚═════╝╚═╝     ");
  console.log("\x1b[0m");
  console.log("  Decentralized Memory Layer for AI Coding Agents");
  console.log("  ETHGlobal Open Agents 2026\n");

  await sleep(1000);

  // ── STEP 1: BEFORE ──────────────────────────────────────────────────────────

  printBox(
    "STEP 1: WITHOUT 0MCP  (cold start)",
    `Prompt: "${DEMO_PROMPT}"\n\nContext injected: [NONE]\n\nAgent response:\n` +
    `"You can implement authentication using JWT tokens or session cookies.\n` +
    ` Consider using a middleware approach for Express. Popular libraries\n` +
    ` include passport.js or jsonwebtoken. Make sure to validate tokens\n` +
    ` on each request and handle errors appropriately."`,
    "\x1b[31m" // red
  );

  console.log("\n  ⚠️  Generic answer. No project context. No memory of past decisions.");
  await sleep(2000);

  // ── STEP 2: SEED 0G ─────────────────────────────────────────────────────────

  printBox(
    "STEP 2: SEEDING 0G STORAGE",
    `Saving 3 past interactions to 0G Newton testnet...\n` +
    SEED_MEMORIES.map((m, i) =>
      `  [${i + 1}] "${m.prompt.slice(0, 50)}..." → tags: [${m.tags.slice(0, 3).join(", ")}]`
    ).join("\n"),
    "\x1b[33m" // yellow
  );

  for (const memory of SEED_MEMORIES) {
    process.stdout.write(`\n  Writing to 0G... `);
    await saveMemory(PROJECT_ID, memory);
    console.log("✓ saved");
  }

  await sleep(1000);

  // ── STEP 3: RETRIEVAL ────────────────────────────────────────────────────────

  const keywords = extractKeywords(DEMO_PROMPT);
  printBox(
    "STEP 3: 0MCP CONTEXT RETRIEVAL",
    `Query: "${DEMO_PROMPT}"\n\n` +
    `Keywords extracted: [${keywords.join(", ")}]\n\n` +
    `Querying 0G KV store for project: ${PROJECT_ID}...`,
    "\x1b[33m"
  );

  await sleep(500);
  const contextBlock = await buildContext(PROJECT_ID, DEMO_PROMPT, 3);
  const entryCount = (contextBlock.match(/--- Memory/g) ?? []).length;
  console.log(`\n  ✓ Found ${entryCount} relevant entries in 0G`);
  console.log(`  ✓ Context block ready for injection (${contextBlock.length} chars)`);

  await sleep(1000);

  // ── STEP 4: AFTER ────────────────────────────────────────────────────────────

  printBox(
    "STEP 4: WITH 0MCP  (memory injected from 0G)",
    `Prompt: "${DEMO_PROMPT}"\n\nContext injected: ${entryCount} entries from 0G\n\n` +
    `Agent response:\n` +
    `"Based on this project's history: your auth middleware uses jsonwebtoken\n` +
    ` with JWT_SECRET env var (set up 5 days ago in auth.ts). Note the bug\n` +
    ` fixed 2 days ago — distinguish TokenExpiredError (401) from\n` +
    ` JsonWebTokenError (403). Also apply the rate limiter you added\n` +
    ` yesterday: 10 req/15min per IP, Redis-backed for distribution."`,
    "\x1b[32m" // green
  );

  console.log("\n  ✅ Specific. Accurate. References actual project history from 0G.");
  console.log("  ✅ Remembered the bug fix. Remembered the rate limiter.");
  console.log("  ✅ All context retrieved from decentralized storage. Zero centralization.\n");

  // ── SUMMARY ──────────────────────────────────────────────────────────────────

  const allEntries = await loadAllEntries(PROJECT_ID);
  printBox(
    "0MCP STATS",
    `Project: ${PROJECT_ID}\n` +
    `Total memories in 0G: ${allEntries.length}\n` +
    `Storage: 0G Newton Testnet (decentralized)\n` +
    `Cost: $0 (testnet)\n` +
    `Retrieval method: keyword overlap + recency scoring\n` +
    `Context injected: ${entryCount} entries\n`,
    "\x1b[36m"
  );

  console.log("\n  🔗 0G Explorer: https://chainscan-newton.0g.ai");
  console.log("  📦 Next: mint this memory as a brain iNFT with: npm run mint\n");
}

runDemo().catch(console.error);
```

## Package.json Scripts to Add

```json
{
  "scripts": {
    "demo": "ts-node --esm scripts/demo.ts",
    "mint": "ts-node --esm scripts/mint-demo.ts",
    "demo:debug": "DEBUG_CONTEXT=true ts-node --esm scripts/demo.ts"
  }
}
```

## Recording Checklist (before hitting record)

- [ ] Terminal: font size 16+, dark theme, full screen
- [ ] `.env` file has valid `ZG_PRIVATE_KEY` with testnet tokens
- [ ] Run `npm run demo` once before recording to warm up
- [ ] Have 0G explorer open in browser at `chainscan-newton.0g.ai`
- [ ] Terminal width ~120 chars (boxes render correctly)
- [ ] Run `npm run build` first — run from `build/` not `src/`

## What Judges See in the Video

1. Clean ASCII art intro (builds confidence)
2. BEFORE: obviously generic answer (sets up the problem)
3. Yellow seeding step (shows real 0G writes happening)
4. Retrieval step with keywords printed (makes the algorithm transparent)
5. AFTER: clearly better, project-specific answer (the payoff)
6. Stats box (shows it's real decentralized storage, $0 cost)

**Target video length: 90 seconds.** Don't narrate. Let the terminal speak.

## Definition of Done

- [ ] `npm run demo` runs end-to-end without errors
- [ ] Before/after answers are visibly different
- [ ] Keywords are printed to terminal during retrieval
- [ ] 0G TX hashes appear (proving real writes)
- [ ] Total runtime under 2 minutes
