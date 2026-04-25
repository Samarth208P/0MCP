import { ethers } from "ethers";
import fs from "node:fs";

async function main() {
  const rpc = "https://ethereum-sepolia-rpc.publicnode.com";
  const pk = "0x19b9d3e8ce6b9e49bcfc679d947e3b69a9979e7789b3367d01688b868f465a8a";
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);

  // Read ABI and bytecode from forge out
  const artData = fs.readFileSync("out/ZeroMCPRegistrar.sol/ZeroMCPRegistrar.json", "utf8");
  const artifact = JSON.parse(artData);
  const abi = artifact.abi;
  const bytecode = artifact.bytecode.object || artifact.bytecode;

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  
  console.log("Deploying ZeroMCPRegistrar...");
  const contract = await factory.deploy(
    "0x0635513f179D50A207757E05759CbD106d7dFcE8", 
    "0xe89f0a3481ecc91e548f0d7018b8cfc48f0015aab09c7e82a6f1e73f6e463f5e", 
    "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5"
  );
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  
  console.log(`Deployed to: ${address}`);

  // Now, call NameWrapper to set approval
  console.log("Setting approval on NameWrapper...");
  const wrapperAbi = ["function setApprovalForAll(address operator, bool approved) external"];
  const nameWrapper = new ethers.Contract("0x0635513f179D50A207757E05759CbD106d7dFcE8", wrapperAbi, wallet);
  
  const tx = await nameWrapper.setApprovalForAll(address, true);
  await tx.wait();
  console.log(`Approval set! TX: ${tx.hash}`);

  // Auto-inject into .env
  let env = fs.readFileSync(".env", "utf8");
  env += `\nSUBNAME_REGISTRAR_ADDRESS=${address}\n`;
  fs.writeFileSync(".env", env);
  console.log("Added SUBNAME_REGISTRAR_ADDRESS to .env");
}

main().catch(console.error);
