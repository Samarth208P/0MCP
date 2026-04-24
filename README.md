# 0MCP — Persistent Memory Layer for AI Coding Agents

> *"0MCP is an MCP server that gives your AI coding agent persistent memory on 0G — so every prompt gets smarter than the last, your expertise becomes a tradeable asset, and your agent has a name the whole world can find."*

**ETHGlobal Open Agents 2026** · Solo Project · Samarth Patel, IIT Roorkee

---

## The Problem: Goldfish Memory

Every AI coding session starts from zero. Your agent in Cursor, VS Code, or Windsurf has no memory of:

- The architectural decision you made last Tuesday
- The bug pattern that broke your CI pipeline three times
- The project rules your team spent a week agreeing on

You manually re-paste context into every prompt. You hit token limits. You repeat yourself. The agent is brilliant — but stateless. And when you finally build up real expertise inside your agent — there is no way to share it, find it, or sell it.

**0MCP kills the goldfish. And gives it a name.**

---

## What is 0MCP?

0MCP is a **Model Context Protocol (MCP) server** — a middleware layer that sits between your IDE and your existing AI model (Claude, GPT, Gemini — whatever you already use). It requires zero changes to your workflow.

Every prompt you send is silently enriched with relevant project history pulled from **0G decentralized storage**. Every response is logged back. Over time, your agent gets smarter about *your specific project* — not just language in general.

When that expertise has real value, you can **mint it as a Brain iNFT** — a portable, ownable intelligence asset. And when you want the world to find it, **ENS gives it a human-readable name**: `solidity-auditor.brains.0mcp.eth`.

No new IDE. No new AI model. No subscription. Just memory — with an identity layer and a market for it.

---

## The Core Loop

```
1. You type a prompt in Cursor / VS Code
2. 0MCP intercepts it before the model sees it
3. 0MCP queries 0G KV for relevant project history
   → matched by project ID + keyword overlap + recency
4. Retrieved context is injected into the system prompt
5. Your AI model responds — now with full project memory
6. The response is logged to 0G (append-only, immutable)
7. Next prompt: the loop repeats, now with one more memory
```

Each iteration makes the next one better. The agent compounds.

---

## How Context Retrieval Actually Works

No black-box embeddings. No external API calls. Pure deterministic retrieval:

Every logged entry is tagged with `[project_id, file_path, keywords, timestamp]`.

When a new prompt arrives:

1. Extract keywords from the prompt (lightweight NLP, no model needed)
2. Query 0G KV: match on `project_id` + keyword overlap
3. Rank results by recency × keyword overlap score
4. Inject top N entries into the system prompt as structured context

Retrieval is **transparent and explainable** — you can see exactly what got injected and why. That's a feature, not a limitation.

---

## Storage Architecture

**0G KV Store → Active Memory**
- Mutable, high-speed
- Stores working project context: current rules, recent decisions, active file summaries
- Retrieved on every prompt, scoped per project ID

**0G Log → Immutable Archive**
- Append-only, permanent
- Every interaction, fix, and failure recorded forever
- Powers failure pattern detection and Brain iNFT snapshots
- Fully auditable — every entry has a timestamp and hash

**Why two tiers?** KV = working memory (fast, mutable). Log = long-term memory (permanent, trustless). The same split your brain uses.

---

## Features

### 1. Persistent Cross-Machine Memory

Memory lives on 0G, not your disk. Switch machines mid-feature — your agent picks up exactly where it left off.

### 2. Failure Pattern Logging

When a build fails, 0MCP logs the error signature to 0G Log. Next session, that pattern surfaces in retrieved context. The agent sees it and avoids repeating the mistake — without anyone writing a rule.

### 3. Brain iNFT — Shareable Intelligence (ERC-7857)

This is the feature that makes 0MCP more than a memory tool. It turns accumulated expertise into a **liquid, tradeable asset**.

**The problem it solves:** A senior Solidity auditor who has coded with 0MCP for a month has built something genuinely valuable — thousands of logged interactions, vulnerability patterns, architectural decisions, bug fixes. Today, that expertise dies when they close their laptop. There is no way to share it, sell it, or preserve it.

**How Brain iNFT works:**

```
Step 1 — Snapshot
  All memory entries for a project are exported from 0G KV
  into a portable, signed JSON context bundle.
  Includes: all interactions, top keywords, file references,
  date range, and a metadata summary.

Step 2 — Mint
  The bundle is minted as an ERC-7857 iNFT on 0G Chain.
  The token URI stores the full snapshot on-chain.
  Token ID is returned with a verifiable TX hash.

Step 3 — Share or Rent
  The iNFT is transferred, sold, or rented via ENS name.
  The recipient loads it into their 0MCP instance.
  Their agent now has the full context of the original expert.
```

**What gets transferred:**
- Every prompt/response pair the original developer had
- All tagged keywords, file paths, and timestamps
- Bug fix patterns and architectural decisions
- The full ranked memory — ready to inject on the next prompt

**MCP tools exposed:**
```
export_snapshot(project_id)     →  full JSON context bundle
mint_brain(snapshot, wallet)    →  { tokenId, txHash, ensName }
load_brain(ensName)             →  loads external brain into context
```

### 4. ENS Identity — Human-Readable Agent Discovery

This is what makes Brain iNFTs findable, trustworthy, and composable.

**The problem:** A Brain iNFT without a name is just `0x7f3a...c91b / Token #42`. Nobody knows what it contains. Nobody can find it. Nobody can trust it.

**With ENS, it becomes:**
```
solidity-auditor.brains.0mcp.eth
uniswap-v4-expert.brains.0mcp.eth
samarth.brains.0mcp.eth
```

**How ENS is used in 0MCP — two distinct mechanisms:**

**A) Agent Identity via ENS Text Records**

Every 0MCP agent instance registers an ENS name. The agent's metadata lives in ENS text records:

```
name          →  "Solidity Security Specialist"
description   →  "847 sessions, Uniswap v4 + audit patterns"
com.0mcp.brain   →  token ID of the minted Brain iNFT
com.0mcp.project →  project identifier
com.0mcp.sessions →  total logged interactions
```

When another developer wants to rent expertise, they resolve `solidity-auditor.brains.0mcp.eth` and get the Brain iNFT address, metadata, and the owner's wallet — directly from ENS. **No marketplace UI needed. ENS is the discovery layer.**

**B) Subnames as Rental Access Tokens**

When someone rents a Brain iNFT, they are issued a subname:

```
renter-alice.solidity-auditor.brains.0mcp.eth
```

Their 0MCP instance resolves that subname to verify active rental access. **The subname is the access token.** No separate access control contract. No centralized list. Just ENS resolution — which is exactly what ENS was built for.

When the rental expires, the subname is revoked. Access gone. Clean, on-chain, verifiable.

**MCP tools exposed:**
```
register_agent(projectId, name)     →  registers agent.name.0mcp.eth
resolve_brain(ensName)              →  { wallet, tokenId, metadata }
issue_rental(brainEns, renterAddr)  →  subname access token
verify_access(subname)              →  { valid, expiresAt }
```

### 5. On-Chain Execution via KeeperHub

When the agent suggests an on-chain action, 0MCP routes it through KeeperHub: smart gas estimation, private RPC routing, full execution audit logs. The gap between "agent decides" and "transaction lands" is closed.

### 6. Payments via Uniswap

Brain rental payments and gas handled via Uniswap API — auto-swap from any token to whatever the transaction requires. Users pay in any token; 0MCP handles the rest.

---

## Architecture

```
┌──────────────────────────────────────┐
│              IDE Layer               │
│   VS Code / Cursor / Windsurf        │
│   (your existing Claude/GPT/Gemini)  │
└─────────────────┬────────────────────┘
                  │  MCP JSON-RPC
                  ▼
┌──────────────────────────────────────┐
│           0MCP Server                │
│                                      │
│  → intercept prompt                  │
│  → query 0G KV (keyword match)       │
│  → inject context into system prompt │
│  → forward to model                  │
│  → log response to 0G Log            │
└──────┬──────────────────┬────────────┘
       │                  │
       ▼                  ▼
┌────────────┐  ┌─────────────────────┐
│  0G KV     │  │  0G Log             │
│  Active    │  │  Immutable archive  │
│  memory    │  │  of all sessions    │
└────────────┘  └─────────────────────┘
       │
       ▼  (Intelligence + Identity Layer)
┌──────────────────────────────────────┐
│                                      │
│  Snapshot + Mint  →  ERC-7857 iNFT  │
│  Agent Identity   →  ENS (0mcp.eth) │
│  Rental Access    →  ENS Subnames   │
│  Brain Discovery  →  ENS Resolution │
│  On-chain Exec    →  KeeperHub      │
│  Payments/Swaps   →  Uniswap API    │
│                                      │
└──────────────────────────────────────┘
```

---

## Real-World Use Cases

**The Junior-to-Senior Bridge**
A first-time hackathon dev resolves `solidity-auditor.brains.0mcp.eth` → rents the Brain → their Cursor agent instantly has the context to flag reentrancy risks they would never have caught.

**Collaborative DAO Memory**
A team mints a shared `common-memory.dao-name.0mcp.eth` Brain. Every time one dev's agent fixes a bug, it's logged. Every teammate's agent learns it on their next session.

**Self-Healing CI/CD**
0MCP logs every failed build pattern. Next session, the agent sees what broke before and avoids it — without anyone writing a rule.

**Cross-Machine Continuity**
Pause mid-feature on desktop. Open laptop on a train. One prompt. The agent already knows exactly what was being built.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Protocol | MCP (Model Context Protocol) JSON-RPC |
| Active Memory | 0G KV Store |
| Immutable Archive | 0G Log |
| AI Compute | 0G dAIOS — no external LLM API needed |
| Brain iNFT | ERC-7857, deployed on 0G Chain |
| Agent Identity | ENS — `*.brains.0mcp.eth` |
| Rental Access Tokens | ENS Subnames |
| On-chain Execution | KeeperHub |
| Payments | Uniswap API |
| Networks | All testnets — $0 cost to run |

---

## The Demo

**Act 1 — Without 0MCP (cold start):**
> Agent asked about a recent architectural decision → no idea → generic answer

**Act 2 — Memory builds:**
> Three past interactions seeded to 0G KV. Keywords extracted. Scores printed to terminal.

**Act 3 — With 0MCP (memory injected):**
> Same prompt → 0MCP retrieves 3 entries from 0G → injects them → agent gives specific answer referencing actual project history

**Act 4 — Brain iNFT minted:**
> `npm run mint` → snapshot exported → minted on 0G testnet → TX hash printed → verifiable on explorer

**Act 5 — ENS identity registered:**
> `npm run register-agent` → `solidity-auditor.brains.0mcp.eth` resolves to the Brain iNFT → another dev loads it via `load_brain("solidity-auditor.brains.0mcp.eth")` → their agent has the expertise

Retrieved context is visible in terminal at every step. No black box.

---

## Running Cost

**$0.** Every component runs on testnet:

- 0G: Newton testnet, free faucet tokens
- 0G dAIOS: on-chain inference, no external API key
- KeeperHub: testnet RPC routing
- Uniswap: Sepolia testnet
- ENS: Sepolia testnet (free registrations)
- Brain iNFT: deployed on 0G testnet

---

## Sponsor Track Eligibility

| Sponsor | Integration | Track |
|---|---|---|
| **0G** | Core storage (KV + Log) + AI compute + iNFT on 0G Chain | Primary |
| **ENS** | Agent identity via text records + subname rental access tokens | 2 tracks |
| **KeeperHub** | Reliable on-chain execution for agent actions | Primary |
| **Uniswap Foundation** | Auto-swap payments for Brain rentals and gas | Primary |
| **Gensyn** | P2P Brain streaming (roadmap) | Roadmap |

**5 prize tracks. Each integration is load-bearing — not decorative.**
The core demo works if any single sponsor layer is removed.

---

## What's Shipping vs. Roadmap

| Feature | Status |
|---|---|
| MCP server + prompt interception | ✅ Shipping |
| 0G KV read/write | ✅ Shipping |
| Keyword-based context retrieval | ✅ Shipping |
| Context injection + response logging | ✅ Shipping |
| Before/after demo with visible retrieval | ✅ Shipping |
| Brain iNFT snapshot + mint (ERC-7857) | ✅ Shipping |
| Load external Brain iNFT into context | ✅ Shipping |
| ENS agent identity + text record metadata | ✅ Shipping |
| ENS subname rental access tokens | ✅ Shipping |
| Brain discovery via ENS resolution | ✅ Shipping |
| KeeperHub on-chain execution routing | ✅ Shipping |
| Uniswap payment flow | ✅ Shipping |
| Brain rental marketplace UI | 🗺️ Roadmap |
| P2P Brain streaming via Gensyn AXL | 🗺️ Roadmap |
| Semantic embedding-based retrieval | 🗺️ Roadmap |
| Brain quality scoring + curation | 🗺️ Roadmap |

---

## Developer

**Samarth Patel**
B.Tech, IIT Roorkee
ETHGlobal Open Agents 2026 — Solo Submission

---

*Built during ETHGlobal Open Agents 2026 · April 24 – May 6*