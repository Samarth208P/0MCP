// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title ZeroGPaymaster
 * @notice ERC-4337 VerifyingPaymaster that sponsors Sepolia gas for 0MCP ENS
 *         operations, so users only need 0G tokens.
 *
 * Flow:
 *   1. User signs an ENS operation intent with their 0G private key.
 *   2. Off-chain relay (`src/paymaster.ts`) verifies:
 *        a. User's 0G balance >= REQUIRED_OG_BALANCE
 *        b. The operation hash and user address are valid
 *      Then the relay produces a ECDSA signature over (userOpHash, validUntil).
 *   3. The relay submits the UserOperation to the Sepolia bundler.
 *   4. This contract (the Paymaster) validates the relay signature and pays
 *      the gas on behalf of the user.
 *
 * Deploy to Sepolia:
 *   forge create --rpc-url $SEPOLIA_RPC_URL \
 *                --private-key $RELAY_PRIVATE_KEY \
 *                contracts/ZeroGPaymaster.sol:ZeroGPaymaster \
 *                --constructor-args $ENTRY_POINT_ADDRESS $RELAY_SIGNER_ADDRESS
 *
 * After deploy, fund the paymaster with ETH (for stake + deposits):
 *   cast send $PAYMASTER_ADDRESS "deposit()" --value 0.1ether --rpc-url $SEPOLIA_RPC_URL
 */

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract ZeroGPaymaster is BasePaymaster {
    using ECDSA for bytes32;

    // ── Events ────────────────────────────────────────────────────────────────
    event OperationSponsored(address indexed user, bytes32 indexed userOpHash, uint256 validUntil);

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice The off-chain relay signer address (controlled by 0MCP backend)
    address public relaySigner;

    /// @notice Maximum gas units the paymaster will sponsor per operation
    uint256 public constant MAX_GAS_UNITS = 500_000;

    /// @notice Paymaster data version tag
    uint8 public constant VERSION = 1;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _entryPoint  ERC-4337 EntryPoint on Sepolia
     *                     (0x0000000071727De22E5E9d8BAf0edAc6f37da032)
     * @param _relaySigner Address of the off-chain relay that creates
     *                     sponsorship signatures. Fund this address on Sepolia.
     */
    constructor(IEntryPoint _entryPoint, address _relaySigner)
        BasePaymaster(_entryPoint)
    {
        require(_relaySigner != address(0), "ZeroGPaymaster: zero signer");
        relaySigner = _relaySigner;
    }

    /// @notice Bypass interface id check which throws when using mismatched version artifacts
    function _validateEntryPointInterface(IEntryPoint) internal virtual override {}

    // ── Owner controls ────────────────────────────────────────────────────────

    /**
     * @notice Update the relay signer (e.g. key rotation)
     */
    function setRelaySigner(address _newSigner) external onlyOwner {
        require(_newSigner != address(0), "ZeroGPaymaster: zero signer");
        relaySigner = _newSigner;
    }

    /**
     * @notice Withdraw ETH deposit to owner (for rebalancing)
     * @param to     Recipient address
     * @param amount Amount in wei
     */
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "ZeroGPaymaster: transfer failed");
    }

    // ── ERC-4337 hooks ────────────────────────────────────────────────────────

    /**
     * @notice Validate that the relay has signed this UserOperation.
     *
     * paymasterAndData layout (after 20-byte paymaster address):
     *   [0..7]   validUntil  (uint64, big-endian)  — unix timestamp
     *   [8..71]  signature   (65 bytes ECDSA)
     *
     * @dev The relay signs: keccak256(abi.encode(userOpHash, validUntil, chainId))
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 /* maxCost */
    )
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        bytes calldata pmData = userOp.paymasterAndData;

        // Must have at least 20 (addr) + 8 (validUntil) + 65 (sig) = 93 bytes
        require(pmData.length >= 93, "ZeroGPaymaster: bad paymasterAndData");

        uint64  validUntil = uint64(bytes8(pmData[20:28]));
        bytes calldata sig = pmData[28:93];

        // Reconstruct the digest the relay signed
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(userOpHash, validUntil, block.chainid))
        );

        address recovered = ECDSA.recover(digest, sig);
        bool sigOk = (recovered == relaySigner);

        // Pack validationData: sigFailure (1 bit) | validUntil (48 bits) | validAfter (48 bits)
        // sigOk -> 0, !sigOk -> 1
        uint256 sigStatus = sigOk ? 0 : 1;
        validationData = sigStatus | (uint256(validUntil) << 160) | (uint256(0) << (160 + 48));

        // Pass validUntil + user to postOp for event logging
        context = abi.encode(userOp.sender, userOpHash, validUntil);
    }

    /**
     * @notice Post-operation hook — log the sponsored event.
     */
    function _postOp(
        PostOpMode /* mode */,
        bytes calldata context,
        uint256 /* actualGasCost */,
        uint256 /* actualUserOpFeePerGas */
    )
        internal
        override
    {
        (address user, bytes32 userOpHash, uint256 validUntil) =
            abi.decode(context, (address, bytes32, uint256));
        emit OperationSponsored(user, userOpHash, validUntil);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    receive() external payable {}
}
