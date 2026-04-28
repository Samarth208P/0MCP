// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title BrainEscrow
/// @notice Minimal escrow for off-chain P2P memory exchange via 0MCP + Gensyn AXL.
/// @dev Buyers lock native 0G (OG) tokens. Sellers claim upon buyer confirmation or timeout.
contract BrainEscrow {
    enum EscrowStatus { None, Locked, Released, Refunded }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amountWei;
        EscrowStatus status;
        uint256 lockedAt;
    }

    mapping(bytes32 => Escrow) public escrows;

    /// @notice 1 hour timeout for seller to claim if buyer refuses to confirm
    uint256 public constant TIMEOUT = 3600;

    event PaymentLocked(bytes32 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount);
    event PaymentReleased(bytes32 indexed escrowId, address indexed seller, uint256 amount);
    event PaymentRefunded(bytes32 indexed escrowId, address indexed buyer, uint256 amount);

    /// @notice Locks native OG tokens for a seller
    /// @param escrowId Unique ID (usually keccak256(abi.encode(buyer, seller, timestamp, nonce)))
    /// @param seller Address of the agent providing the memory
    function lockPayment(bytes32 escrowId, address seller) external payable {
        require(msg.value > 0, "Amount must be > 0");
        require(escrows[escrowId].status == EscrowStatus.None, "Escrow ID already exists");
        require(seller != address(0), "Invalid seller address");
        require(seller != msg.sender, "Cannot buy from yourself");

        escrows[escrowId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amountWei: msg.value,
            status: EscrowStatus.Locked,
            lockedAt: block.timestamp
        });

        emit PaymentLocked(escrowId, msg.sender, seller, msg.value);
    }

    /// @notice Buyer confirms they received the data over AXL and releases funds to seller
    /// @param escrowId ID of the locked escrow
    function confirmDelivery(bytes32 escrowId) external {
        Escrow storage esc = escrows[escrowId];
        require(esc.status == EscrowStatus.Locked, "Escrow not locked");
        require(msg.sender == esc.buyer, "Only buyer can confirm delivery");

        esc.status = EscrowStatus.Released;
        uint256 amount = esc.amountWei;

        (bool success, ) = esc.seller.call{value: amount}("");
        require(success, "Transfer failed");

        emit PaymentReleased(escrowId, esc.seller, amount);
    }

    /// @notice If buyer disappears, seller can claim after timeout
    /// @param escrowId ID of the locked escrow
    function claimTimeout(bytes32 escrowId) external {
        Escrow storage esc = escrows[escrowId];
        require(esc.status == EscrowStatus.Locked, "Escrow not locked");
        require(msg.sender == esc.seller, "Only seller can claim timeout");
        require(block.timestamp >= esc.lockedAt + TIMEOUT, "Timeout not reached");

        esc.status = EscrowStatus.Released;
        uint256 amount = esc.amountWei;

        (bool success, ) = esc.seller.call{value: amount}("");
        require(success, "Transfer failed");

        emit PaymentReleased(escrowId, esc.seller, amount);
    }

    /// @notice If seller never delivers, buyer can refund after timeout
    /// @param escrowId ID of the locked escrow
    function refund(bytes32 escrowId) external {
        Escrow storage esc = escrows[escrowId];
        require(esc.status == EscrowStatus.Locked, "Escrow not locked");
        require(msg.sender == esc.buyer, "Only buyer can refund");
        require(block.timestamp >= esc.lockedAt + TIMEOUT, "Timeout not reached");

        esc.status = EscrowStatus.Refunded;
        uint256 amount = esc.amountWei;

        (bool success, ) = esc.buyer.call{value: amount}("");
        require(success, "Refund failed");

        emit PaymentRefunded(escrowId, esc.buyer, amount);
    }

    /// @notice Get escrow details
    function getEscrow(bytes32 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }
}
