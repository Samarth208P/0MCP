import crypto from "node:crypto";
import { ethers } from "ethers";
import { sendMessage, getLocalPeerKey } from "./axl.js";
import { loadAllEntries, saveMemory } from "./storage.js";
import type { AXLEnvelope, BrainRequestPayload, BrainDeliveryPayload, MemorySnapshot } from "./types.js";

import { loadLocalEnv } from "./env.js";
loadLocalEnv();

const BRAIN_ESCROW_ADDRESS = process.env.MESH_ESCROW_ADDRESS || "0x0000000000000000000000000000000000000000";
const ZG_RPC_URL = process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai";
const ZG_CHAIN_ID = Number(process.env.ZG_CHAIN_ID || "16602");

const BRAIN_ESCROW_ABI = [
  "function getEscrow(bytes32 escrowId) external view returns (tuple(address buyer, address seller, uint256 amountWei, uint8 status, uint256 lockedAt))"
];

export function generateEciesKeypair() {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey("hex"),
    publicKey: ecdh.getPublicKey("hex", "compressed")
  };
}

export function eciesEncrypt(recipientPublicKeyHex: string, dataStr: string): string {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.generateKeys();
  
  const sharedSecret = ecdh.computeSecret(recipientPublicKeyHex, "hex");
  const key = crypto.createHash("sha256").update(sharedSecret).digest();
  
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  
  let ciphertext = cipher.update(dataStr, "utf8", "hex");
  ciphertext += cipher.final("hex");
  
  const authTag = cipher.getAuthTag().toString("hex");
  const ephemeralPubKey = ecdh.getPublicKey("hex", "compressed");
  
  return `${ephemeralPubKey}:${iv.toString("hex")}:${authTag}:${ciphertext}`;
}

export function eciesDecrypt(privateKeyHex: string, encryptedStr: string): string {
  const parts = encryptedStr.split(":");
  if (parts.length !== 4) throw new Error("Invalid ECIES encrypted string format");
  
  const [ephemeralPubKeyHex, ivHex, authTagHex, ciphertextHex] = parts;
  
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(privateKeyHex, "hex");
  
  const sharedSecret = ecdh.computeSecret(ephemeralPubKeyHex, "hex");
  const key = crypto.createHash("sha256").update(sharedSecret).digest();
  
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  
  let plaintext = decipher.update(ciphertextHex, "hex", "utf8");
  plaintext += decipher.final("utf8");
  
  return plaintext;
}

export async function verifyEscrow(
  escrowTx: string,
  expectedBuyer: string,
  sellerAddress: string,
  expectedPriceWei: bigint
): Promise<boolean> {
  if (BRAIN_ESCROW_ADDRESS === "0x0000000000000000000000000000000000000000") {
    console.error("[exchange] MESH_ESCROW_ADDRESS not set. Skipping on-chain verification.");
    return true; 
  }

  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, ZG_CHAIN_ID);
  const escrowContract = new ethers.Contract(BRAIN_ESCROW_ADDRESS, BRAIN_ESCROW_ABI, provider);

  try {
    const escrowId = escrowTx;
    const esc = await escrowContract.getEscrow(escrowId);
    
    if (esc.status !== 1n) {
      console.error(`[exchange] Escrow ${escrowId} is not in Locked status.`);
      return false;
    }
    
    if (esc.buyer.toLowerCase() !== expectedBuyer.toLowerCase()) {
      console.error(`[exchange] Escrow buyer mismatch.`);
      return false;
    }
    
    if (esc.seller.toLowerCase() !== sellerAddress.toLowerCase()) {
      console.error(`[exchange] Escrow seller mismatch.`);
      return false;
    }
    
    if (esc.amountWei < expectedPriceWei) {
      console.error(`[exchange] Escrow amount too low.`);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error(`[exchange] Failed to verify escrow: ${err}`);
    return false;
  }
}

import { exportSnapshot } from "./snapshot.js";
import { resolveBrain } from "./ens.js";
import { signEnvelope } from "./axl.js";

export async function handleBrainRequest(envelope: AXLEnvelope): Promise<void> {
  console.error(`[exchange] Received brain request from ${envelope.from_ens}`);
  
  const payload = envelope.payload as unknown as BrainRequestPayload;
  const sellerEns = payload.requested_ens;
  
  try {
    const brainMeta = await resolveBrain(sellerEns);
    const sellerAddress = brainMeta.wallet;
    if (!sellerAddress) throw new Error("Could not resolve seller wallet");

    const buyerMeta = await resolveBrain(payload.buyer_ens);
    const buyerAddress = buyerMeta.wallet;
    if (!buyerAddress) throw new Error("Could not resolve buyer wallet");

    const sepoliaRpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
    const provider = new ethers.JsonRpcProvider(sepoliaRpc);
    const resolver = await provider.getResolver(sellerEns);
    let expectedPriceWei = 0n;
    if (resolver) {
      const priceStr = await resolver.getText("com.0mcp.axl.price");
      if (priceStr) {
        expectedPriceWei = ethers.parseEther(priceStr);
      }
    }

    const isEscrowValid = await verifyEscrow(payload.escrow_tx, buyerAddress, sellerAddress, expectedPriceWei);
    if (!isEscrowValid) {
      throw new Error("Escrow verification failed");
    }

    console.error(`[exchange] Escrow verified. Encrypting memory for ${payload.buyer_ens}...`);
    const snapshot = await exportSnapshot(brainMeta.project_id);

    const snapshotStr = JSON.stringify(snapshot);
    const encryptedSnapshot = eciesEncrypt(payload.buyer_encryption_pubkey, snapshotStr);

    const deliveryPayload: BrainDeliveryPayload = {
      encrypted_snapshot: encryptedSnapshot,
      root_hash: "0x",
      entry_count: snapshot.entry_count,
      seller_ens: sellerEns
    };

    const myPeerKey = await getLocalPeerKey();
    const deliveryEnvelope = await signEnvelope("brain_delivery", sellerEns, myPeerKey, deliveryPayload as any);

    await sendMessage(envelope.from_peer, deliveryEnvelope);
    console.error(`[exchange] Sent brain delivery to ${envelope.from_ens} (${envelope.from_peer})`);

  } catch (err) {
    console.error(`[exchange] Failed to handle brain request: ${err}`);
  }
}

const pendingRequests = new Map<string, {
  resolve: (snapshot: MemorySnapshot) => void;
  reject: (err: Error) => void;
  privateKey: string;
  timeout: NodeJS.Timeout;
}>();

export async function requestBrainMemory(sellerEns: string, sellerPeerKey: string, intoProject: string): Promise<number> {
  console.error(`[exchange] Requesting memory from ${sellerEns} (${sellerPeerKey})...`);

  const keys = generateEciesKeypair();

  const escrowId = ethers.hexlify(ethers.randomBytes(32));
  console.error(`[exchange] Simulated escrow lock: ${escrowId}`);

  const myEns = process.env.BRAIN_ENS_NAME || "anonymous.0mcp.eth";
  const myPeerKey = await getLocalPeerKey();
  
  const payload: BrainRequestPayload = {
    requested_ens: sellerEns,
    escrow_tx: escrowId,
    buyer_ens: myEns,
    buyer_encryption_pubkey: keys.publicKey
  };

  const envelope = await signEnvelope("brain_request", myEns, myPeerKey, payload as any);

  await sendMessage(sellerPeerKey, envelope);

  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(sellerEns);
      reject(new Error("Timeout waiting for brain_delivery"));
    }, 60000);

    pendingRequests.set(sellerEns, { resolve: resolve as any, reject, privateKey: keys.privateKey, timeout });
  });
}
export async function handleBrainDelivery(envelope: AXLEnvelope): Promise<void> {
  const payload = envelope.payload as unknown as BrainDeliveryPayload;
  const sellerEns = payload.seller_ens;

  const pending = pendingRequests.get(sellerEns);
  if (!pending) {
    console.error(`[exchange] Received unexpected brain delivery from ${sellerEns}`);
    return;
  }

  clearTimeout(pending.timeout);
  pendingRequests.delete(sellerEns);

  try {
    console.error(`[exchange] Decrypting memory from ${sellerEns}...`);
    const plaintext = eciesDecrypt(pending.privateKey, payload.encrypted_snapshot);
    const snapshot = JSON.parse(plaintext) as MemorySnapshot;

    const myEns = process.env.BRAIN_ENS_NAME || "anonymous.0mcp.eth";
    const myPeerKey = await getLocalPeerKey();
    const ackEnvelope = await signEnvelope("brain_ack", myEns, myPeerKey, { received: true });
    await sendMessage(envelope.from_peer, ackEnvelope).catch(e => console.error("Failed to send ack:", e));

    pending.resolve(snapshot);
  } catch (err) {
    pending.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
