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
- **Demo Video**: [https://youtu.be/6PDRTUzN6gk?si=Jsjxk_ul9pHNjblf](https://youtu.be/6PDRTUzN6gk?si=Jsjxk_ul9pHNjblf)
- **Live Demo (0G Explorer)**: [View Brain iNFT Contract](https://chainscan-galileo.0g.ai/address/0xd07059e54017BbF424223cb089ffBC5e2558cF56)
- **Minted Proof (Token #6)**: [View Transaction](https://chainscan-galileo.0g.ai/tx/0xb67cd2d6c72552cb33284add0f494dbc2da29cde27fed462ce3074ad4e496442)
- **GitHub**: [https://github.com/Samarth208P/0MCP](https://github.com/Samarth208P/0MCP)
- **Architecture**: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Technical Proofs & Verification

### 1. 0G iNFT Proof of Intelligence
Every **Brain iNFT** minted via 0MCP (such as **Token #6**) satisfies the "embedded memory" requirement by storing its state on **0G Storage**.
- **Verification**: Call `tokenURI(6)` on the [Brain iNFT Contract](https://chainscan-galileo.0g.ai/address/0xd07059e54017BbF424223cb089ffBC5e2558cF56).
- **Resolution**: The URI resolves to `0g://af3937011e090182de9a1c1c7d6af397021f2bc3f6de3277ad70c6996098c693`. This root hash is the Merkle root of the agent's encrypted memory blobs.

### 2. AXL Multi-Node Communication
0MCP uses **Gensyn AXL** for true peer-to-peer context trading without centralized brokers:
- **Zero-Broker Architecture**: All communication is routed through the local AXL sidecar. We utilize the `/send` and `/recv` AXL primitives to exchange signed **AXLEnvelopes** containing 0G storage roots.
- **Discovery**: Agents resolve Peer IDs from **ENS text records** (`com.0mcp.axl.peer`). This eliminates hardcoded peer lists or centralized discovery servers.
- **Inter-Node Proof**: Our CLI autonomously spawns the AXL binary as a separate OS process. Communication is strictly inter-node (Node.js <-> AXL binary <-> Mesh <-> AXL binary <-> Node.js), satisfying the "separate node" qualification.
- **Coordination**: The `Mesh Escrow` contract on 0G Galileo ensures atomic swaps of $OG tokens for valid Merkle proofs of the transferred memory.

### 3. ENS Identity & Discovery
ENS is used as the **Decentralized Service Discovery (DSD)** layer:
- **Discoverability**: Instead of hardcoding IPs, agents resolve `[name].0mcp.eth` to find the current 0G storage root and AXL Peer Key.
- **Sovereignty**: Users own their agent's identity as an ENS subname, allowing them to port their "brain" across different IDEs or hosting providers.

---

## Team
- **Samarth Patel** (Solo Developer)
- **Telegram**: [@samarth208p](https://t.me/samarth208p)
- **X**: [@SamPy4X](https://x.com/SamPy4X)
