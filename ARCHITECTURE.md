# 0MCP System Architecture

This document provides a technical map of the **0MCP** (Zero-G Memory Control Protocol) stack. It illustrates how local agent memory is secured, assetized, and traded across the decentralized mesh.

---

## 🗺️ Architectural Map

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#ffffff', 'primaryTextColor': '#000000', 'primaryBorderColor': '#000000', 'lineColor': '#333333', 'secondaryColor': '#f4f4f4', 'tertiaryColor': '#ffffff'}}}%%
graph TD
    classDef box fill:#ffffff,stroke:#000000,stroke-width:2px,color:#000000,font-weight:bold;
    classDef sub fill:#f9f9f9,stroke:#cccccc,stroke-dasharray: 5 5;

    subgraph Local ["Local Environment (Developer Machine)"]
        IDE["Agent IDE (Cursor/VSCode)"]:::box
        MCP["0MCP Server (stdio)"]:::box
        AES["AES-256-GCM Encryption"]:::box
        AXL_BIN["AXL Binary Sidecar"]:::box
    end

    subgraph ZeroG ["0G Foundation Infrastructure"]
        ZG_STOR["0G Storage (KV & Log)"]:::box
        ZG_EVM["0G Galileo (Testnet EVM)"]:::box
        INFT["Brain iNFT (ERC-7857)"]:::box
        REG["Memory Registry"]:::box
    end

    subgraph Ethereum ["Identity & Sovereignty (Sepolia)"]
        ENS["ENS (.0mcp.eth)"]:::box
        PAY["ZeroG Paymaster (Account Abstraction)"]:::box
    end

    subgraph Mesh ["P2P Intelligence Mesh (Gensyn AXL)"]
        P2P["AXL DHT / Peer Discovery"]:::box
        REMOTE["Remote Agent Memories"]:::box
    end

    %% Flows
    IDE <-->|JSON-RPC| MCP
    MCP <-->|Encrypt/Decrypt| AES
    AES <-->|Encrypted Blobs| ZG_STOR
    
    MCP -->|Resolve Identity| ENS
    MCP -->|Update Metadata| REG
    MCP -->|Sponsor Gas| PAY

    MCP <-->|A2A Request| AXL_BIN
    AXL_BIN <-->|Encrypted P2P Tunnel| P2P
    P2P <-->|Memory Trade| REMOTE

    ZG_EVM --- INFT
    ZG_EVM --- REG
    INFT ---|Points to| ZG_STOR

    style Local fill:#f0f7ff,stroke:#005cc5,stroke-width:1px
    style ZeroG fill:#f0fff4,stroke:#22863a,stroke-width:1px
    style Ethereum fill:#fff5f0,stroke:#d73a49,stroke-width:1px
    style Mesh fill:#f5f0ff,stroke:#6f42c1,stroke-width:1px
```

---

## 🛠️ Data Flow Lifecycle

### 1. The Autonomous Save
When an agent reaches a conclusion (e.g., "The production DB uses port 5432"), the **0MCP Server**:
1.  **Encrypts** the message locally using a key derived from the user's `ZG_PRIVATE_KEY`.
2.  **Appends** the entry to the **0G Storage Log**.
3.  **Indexes** the metadata (keywords and timestamp) in the **0G KV store** for rapid retrieval.

### 2. Identity & Gas-Free UX
The **ZeroG Paymaster** on Sepolia monitors interactions. If a user has **$OG tokens** on 0G Galileo, the Paymaster automatically sponsors their **ENS subname registration** and **resolver updates** on Ethereum. This bridges the economy, making the high-throughput 0G network the primary driver for Ethereum identities.

### 3. P2P Memory Trading (Mesh)
Using the **Gensyn AXL** layer:
-   Agents expose a local `/mcp/` endpoint through the AXL sidecar.
-   When `mesh request` is called, a **Conditional Escrow** is opened on 0G Galileo.
-   The memory blob is transferred peer-to-peer over an end-to-end encrypted AXL tunnel.
-   Funds are released once the root hash is verified against the seller's ENS record.

---

## 🏗️ Smart Contract Logic
- **`MemoryRegistry.sol`**: Tracks the `last_root` and `entry_count` for every project ID.
- **`BrainEscrow.sol`**: Manages the locked $OG tokens during AXL P2P handshakes.
- **`MergeRegistry.sol`**: Stores the graph of parent-child relationships for synthetic brains.
