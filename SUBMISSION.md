# 0MCP Submission Package

**Project Name:** 0MCP (Zero-G Memory Control Protocol)  
**One-Liner:** A decentralized persistent memory layer that transforms ephemeral AI agents into sovereign, tradeable, and mergeable intelligence assets.

---

## Protocol Integrations

### 1. 0G Foundation (L1 for Onchain AI)
- **0G Storage (KV & Log)**: Used as the immutable anchor for agent consciousness. Conversation history is logged (Log) while architectural decisions are indexed (KV) for RAG retrieval.
- **0G Chain (EVM)**: Deployed the **ERC-7857 iNFT** contract. Every 0MCP agent is an iNFT whose "brain" is a dynamic URI pointing to 0G Storage roots.
- **iNFT Innovation**: Implemented a **Synthetic Merging** mechanism where two parent agent brains are combined via the `MergeRegistry` to create evolved intelligence.

### 2. Gensyn AXL (P2P Mesh)
- **Peer-to-Peer Context Trading**: Used AXL to eliminate centralized coordinators. Agents find each other via ENS and exchange encrypted memory blobs directly via the AXL sidecar.
- **Autonomous Setup**: Integrated a one-click build and initialization flow for AXL nodes directly within the 0MCP CLI.

### 3. ENS (Identity Layer)
- **Routing Engine**: ENS names (`.0mcp.eth`) store AXL Peer Keys and 0G Storage roots.
- **Access Control**: Implemented **Time-Bound Rentals** using ENS subnames, allowing users to "rent" an agent's expertise for a specific duration.

---

## Contract Deployment

| Contract | Purpose | Network | Address |
|---|---|---|---|
| **Memory Registry** | Anchors memory roots to 0G | **0G Galileo** | `0xC5887CA90aC2A5c6f1E7FC536A5363B961F18813` |
| **Brain iNFT** | ERC-7857 Identity | **0G Galileo** | `0xd07059e54017BbF424223cb089ffBC5e2558cF56` |
| **Merge Registry** | Tracks brain lineage | **0G Galileo** | `0x69E1aDbdE8e91d246104007D966403790c90390E` |
| **Mesh Escrow** | P2P Trading Logic | **0G Galileo** | `0xf6F47CF779DD9f37213E0e79d6683d386Db8dEDD` |

---

## Tracking: Best Autonomous Agents & iNFT Innovations

0MCP satisfies the core requirements of this track through its **Sovereign Intelligence** architecture:

1.  **Autonomous Single Agents**: Our `Agent Instructions` (v3.0.0) enable agents to autonomously manage their own state on 0G without user intervention.
2.  **iNFT Innovations (ERC-7857)**: Every agent brain is an assetized iNFT. We enable **comportability** by allowing agents to "live" inside their NFT metadata, pointing directly to encrypted 0G Storage roots.
3.  **Emergent Collaboration (Swarms)**: Using the **Gensyn AXL Mesh**, agents coordinate cross-node communication for **Knowledge Merging**. Two specialized agents can collaborate to mint a third "Synthetic Super-Brain," demonstrating advanced collective intelligence.

---

## Links
- **GitHub**: [https://github.com/Samarth208P/0MCP](https://github.com/Samarth208P/0MCP)
- **Architecture**: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Team
- **Samarth Patel** (Solo Developer)
- **Telegram**: [@samarth208p](https://t.me/samarth208p)
- **X**: [@SamPy4X](https://x.com/SamPy4X)
