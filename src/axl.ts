import { spawn, ChildProcess } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import type { AXLEnvelope, MeshPeer } from "./types.js";
import { loadLocalEnv } from "./env.js";

loadLocalEnv();

let axlProcess: ChildProcess | null = null;

function getAxlUrl(): string {
  return process.env.AXL_HTTP_URL || "http://127.0.0.1:9002";
}

function getAxlBinaryPath(): string {
  return process.env.AXL_BINARY_PATH || "axl";
}

/**
 * Ensures node-config.json and private.pem exist in the axl directory.
 * Derives private.pem from AXL_PRIVATE_KEY in .env.
 */
export async function ensureAxlConfig(): Promise<string> {
  const axlDir = path.dirname(getAxlBinaryPath());
  const configPath = path.join(axlDir, "node-config.json");
  const keyPath = path.join(axlDir, "private.pem");

  // 1. Write private.pem if missing but key exists in env
  const pkHex = process.env.AXL_PRIVATE_KEY;
  if (!fs.existsSync(keyPath) && pkHex) {
    console.error("[axl] 🔑 Generating private.pem (PKCS#8 Ed25519) from AXL_PRIVATE_KEY...");
    const rawKey = pkHex.replace("0x", "");
    
    // PKCS#8 wrapper for Ed25519
    const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const keyBuf = Buffer.from(rawKey, "hex");
    
    const pkcs8 = Buffer.concat([prefix, keyBuf]);
    const b64 = pkcs8.toString("base64");
    
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
    fs.writeFileSync(keyPath, pem);
  }

  // 2. Generate node-config.json if missing
  if (!fs.existsSync(configPath)) {
    console.error("[axl] 📝 Generating default node-config.json...");
    const defaultConfig = {
      PrivateKeyPath: "private.pem",
      Peers: [
        "tls://axl-seed.0mcp.eth:9001", // Placeholder seed
        "tls://167.99.137.200:9001"    // Public community bootstrap node
      ],
      Listen: ["tls://0.0.0.0:9001"],
      HttpListen: "127.0.0.1:9002"
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  return configPath;
}

/**
 * Spawns the AXL binary in the background if it's not already running.
 */
export async function startAxlNode(): Promise<void> {
  if (axlProcess) return;

  // Check if it's already running on the port
  try {
    const topo = await fetch(`${getAxlUrl()}/topology`);
    if (topo.ok) {
      console.error("[axl] 🟢 AXL node is already running in the background.");
      return;
    }
  } catch (err) {
    // Expected to fail if not running
  }

  const binaryPath = getAxlBinaryPath();
  if (binaryPath !== "axl" && !fs.existsSync(binaryPath)) {
    throw new Error(`AXL binary not found at ${binaryPath}. Please build it in the /axl folder first.`);
  }

  const configPath = await ensureAxlConfig();
  console.error(`[axl] 🚀 Starting AXL node with config: ${configPath}...`);
  
  // We run from the axl directory so relative paths in config work
  const axlDir = path.dirname(binaryPath);
  axlProcess = spawn(path.basename(binaryPath), ["-config", "node-config.json"], {
    cwd: axlDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });

  axlProcess.on("error", (err) => {
    console.error(`[axl] ❌ Failed to start AXL binary: ${err.message}`);
    console.error(`[axl]    Please make sure 'axl' is installed and in your PATH, or set AXL_BINARY_PATH.`);
  });

  axlProcess.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[axl] ⚠️ AXL node exited with code ${code}`);
    }
    axlProcess = null;
  });

  // Wait a moment for it to bind to the port
  await new Promise((resolve) => setTimeout(resolve, 2000));
  
  try {
    const peerKey = await getLocalPeerKey();
    console.error(`[axl] ✅ AXL node started successfully. Peer Key: ${peerKey}`);
  } catch (err) {
    console.error(`[axl] ⚠️ AXL node started but cannot connect to HTTP API at ${getAxlUrl()}.`);
  }
}

/**
 * Stops the AXL binary if it was started by this process.
 */
export function stopAxlNode(): void {
  if (axlProcess) {
    console.error("[axl] 🛑 Stopping AXL node...");
    axlProcess.kill("SIGINT");
    axlProcess = null;
  }
}

/**
 * Fetches the local AXL peer key from the running AXL node.
 */
export async function getLocalPeerKey(): Promise<string> {
  const res = await fetch(`${getAxlUrl()}/topology`);
  if (!res.ok) throw new Error(`Failed to get AXL topology: ${res.statusText}`);
  const data = await res.json() as { our_public_key: string };
  return data.our_public_key;
}

/**
 * Signs an AXL envelope payload using the configured ZG_PRIVATE_KEY.
 */
export async function signEnvelope(
  type: string,
  from_ens: string,
  from_peer: string,
  payload: Record<string, unknown>
): Promise<AXLEnvelope> {
  const pk = process.env.ZG_PRIVATE_KEY;
  if (!pk) throw new Error("ZG_PRIVATE_KEY is not set. Cannot sign AXL envelope.");
  
  const wallet = new ethers.Wallet(pk);
  const timestamp = Date.now();
  const nonce = ethers.hexlify(ethers.randomBytes(16));
  
  const message = JSON.stringify({ type, from_ens, timestamp, nonce, payload });
  const signature = await wallet.signMessage(message);

  return {
    type: type as any,
    from_ens,
    from_peer,
    timestamp,
    nonce,
    payload,
    signature
  };
}

/**
 * Verifies the signature of an incoming AXL envelope.
 * Returns the recovered Ethereum address of the signer.
 */
export function verifyEnvelope(envelope: AXLEnvelope): string {
  const message = JSON.stringify({
    type: envelope.type,
    from_ens: envelope.from_ens,
    timestamp: envelope.timestamp,
    nonce: envelope.nonce,
    payload: envelope.payload
  });
  
  return ethers.verifyMessage(message, envelope.signature);
}

/**
 * Sends an AXL envelope to a specific peer.
 */
export async function sendMessage(peerKey: string, envelope: AXLEnvelope): Promise<void> {
  const res = await fetch(`${getAxlUrl()}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-To-Peer-Id": peerKey
    },
    body: JSON.stringify(envelope)
  });
  
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to send AXL message: ${res.status} ${errText}`);
  }
}

/**
 * Starts a background loop to receive and handle AXL messages.
 */
export function startReceiveLoop(handler: (envelope: AXLEnvelope) => Promise<void>): void {
  const interval = parseInt(process.env.AXL_LISTEN_INTERVAL_MS || "2000", 10);
  
  console.error(`[axl] 🎧 Listening for incoming AXL messages...`);
  
  setInterval(async () => {
    try {
      const res = await fetch(`${getAxlUrl()}/recv`);
      if (res.status === 204) {
        // No messages
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      
      const text = await res.text();
      if (!text) return;
      
      const envelope = JSON.parse(text) as AXLEnvelope;
      
      // We don't block the loop on the handler
      handler(envelope).catch(err => {
        console.error(`[axl] ❌ Error handling message: ${err}`);
      });
      
    } catch (err) {
      // Avoid spamming the console on connection refused if node goes down
      if (err instanceof Error && !err.message.includes("ECONNREFUSED")) {
        console.error(`[axl] ⚠️ Receive loop error: ${err}`);
      }
    }
  }, interval);
}

/**
 * Discovers peers on the AXL mesh by resolving ENS records.
 */
export async function discoverPeers(ensNames: string[]): Promise<MeshPeer[]> {
  const sepoliaRpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const provider = new ethers.JsonRpcProvider(sepoliaRpc);
  
  const peers: MeshPeer[] = [];

  for (const name of ensNames) {
    try {
      const resolver = await provider.getResolver(name);
      if (!resolver) continue;

      const axlPeer = await resolver.getText("com.0mcp.axl.peer");
      if (!axlPeer) continue;

      const expertiseRaw = await resolver.getText("com.0mcp.axl.expertise");
      const priceRaw = await resolver.getText("com.0mcp.axl.price");

      peers.push({
        ens_name: name,
        axl_peer_key: axlPeer,
        expertise: expertiseRaw ? expertiseRaw.split(",").map(s => s.trim()) : [],
        price_og: priceRaw || "0",
        last_seen: Date.now()
      });
    } catch (err) {
      console.error(`[axl] Failed to resolve peer ${name}: ${err}`);
    }
  }

  return peers;
}
