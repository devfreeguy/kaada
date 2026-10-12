// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAttestorRegistry} from "./Interfaces.sol";

/// @title TimelockedAttestorRegistry
/// @notice The shared record of WHICH key is Kaada's current recovery attestor. Recovery validators read exactly
///         one thing from it: `currentAttestor()`. Nothing else here is visible to, or can act on, any wallet.
///
/// Two separate identities, with no overlap in power:
///   - ADMIN: proposes, cancels and finalizes attestor rotations, sets the rotation delay, and hands the admin role
///     to a successor in two steps. The admin has NO power over any wallet: this contract holds no reference to a
///     wallet, a validator or a recovery, and calls no other contract. The admin is not the attestor, so it cannot
///     sign or veto a recovery either, unless the same key is deliberately used for both.
///   - ATTESTOR: just the address `currentAttestor()` returns. It has no function here at all, so it cannot rotate
///     itself, instantly or otherwise.
///
/// Rotation is timelocked: propose, wait at least the rotation delay (24 h hard minimum, 72 h by default), then
/// finalize. Until finalized, a proposal changes nothing. Only one proposal can be pending; the admin can cancel it
/// at any time before it is finalized. A rotation has no effect on a pending admin transfer, and an admin transfer
/// has no effect on the attestor or on a pending rotation.
///
/// Not upgradeable. No self-destruct, no delegatecall, no receive/fallback, no way to renounce the admin role.
contract TimelockedAttestorRegistry is IAttestorRegistry {
    // ── errors ────────────────────────────────────────────────────────────────────────────────────
    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error SameAsCurrentAttestor();
    error SameAsCurrentAdmin();
    error RotationPending();
    error NoPendingRotation();
    error RotationNotMatured(uint48 executeAfter);
    error DelayOutOfRange();
    error NoPendingAdminTransfer();

    // ── events: every change is auditable ──────────────────────────────────────────────────────────
    event AttestorRotationProposed(
        address indexed currentAttestor,
        address indexed pendingAttestor,
        uint48 executeAfter,
        uint32 delay,
        uint64 indexed rotationId
    );
    event AttestorRotationCancelled(address indexed pendingAttestor, address indexed by, uint64 indexed rotationId);
    event AttestorRotationFinalized(
        address indexed previousAttestor, address indexed newAttestor, address indexed by, uint64 rotationId
    );
    event RotationDelayChanged(uint32 previousDelay, uint32 newDelay, address indexed by);
    event AdminTransferProposed(address indexed currentAdmin, address indexed proposedAdmin);
    event AdminTransferCancelled(address indexed currentAdmin, address indexed proposedAdmin);
    event AdminTransferAccepted(address indexed previousAdmin, address indexed newAdmin);

    // ── constants ──────────────────────────────────────────────────────────────────────────────────
    /// A rotation delay longer than this is refused (a typo could otherwise lock rotation for years).
    uint32 public constant MAX_ROTATION_DELAY = 30 days;
    /// The default Kaada deploys with.
    uint32 public constant DEFAULT_ROTATION_DELAY = 72 hours;

    // ── state ──────────────────────────────────────────────────────────────────────────────────────
    address public admin;
    address public pendingAdmin;
    address public currentAttestor;
    address public pendingAttestor;
    /// When the pending rotation may be finalized (0 when none is pending).
    uint48 public executeAfter;
    uint32 public rotationDelay;
    /// Counts proposals (for audit); the pending or last proposal id.
    uint64 public rotationCount;

    constructor(address initialAdmin, address initialAttestor, uint32 initialDelay) {
        if (initialAdmin == address(0) || initialAttestor == address(0)) revert ZeroAddress();
        if (initialDelay < minRotationDelay() || initialDelay > MAX_ROTATION_DELAY) revert DelayOutOfRange();
        admin = initialAdmin;
        currentAttestor = initialAttestor;
        rotationDelay = initialDelay;
        emit AdminTransferAccepted(address(0), initialAdmin);
        emit RotationDelayChanged(0, initialDelay, initialAdmin);
        emit AttestorRotationFinalized(address(0), initialAttestor, initialAdmin, 0);
    }

    /// The smallest rotation delay. 24 hours in production.
    function minRotationDelay() public view virtual returns (uint32) {
        return 1 days;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ── attestor rotation ──────────────────────────────────────────────────────────────────────────

    function proposeAttestor(address newAttestor) external onlyAdmin {
        if (newAttestor == address(0)) revert ZeroAddress();
        if (newAttestor == currentAttestor) revert SameAsCurrentAttestor();
        if (pendingAttestor != address(0)) revert RotationPending();
        uint32 delay = rotationDelay;
        uint48 maturity = uint48(block.timestamp + delay);
        pendingAttestor = newAttestor;
        executeAfter = maturity;
        uint64 id = ++rotationCount;
        emit AttestorRotationProposed(currentAttestor, newAttestor, maturity, delay, id);
    }

    function cancelAttestorRotation() external onlyAdmin {
        address pending = pendingAttestor;
        if (pending == address(0)) revert NoPendingRotation();
        delete pendingAttestor;
        delete executeAfter;
        emit AttestorRotationCancelled(pending, msg.sender, rotationCount);
    }

    /// Only at or after `executeAfter`. Clears the proposal, so it can never be finalized twice.
    function finalizeAttestorRotation() external onlyAdmin {
        address pending = pendingAttestor;
        if (pending == address(0)) revert NoPendingRotation();
        uint48 maturity = executeAfter;
        if (block.timestamp < maturity) revert RotationNotMatured(maturity);
        address previous = currentAttestor;
        currentAttestor = pending;
        delete pendingAttestor;
        delete executeAfter;
        emit AttestorRotationFinalized(previous, pending, msg.sender, rotationCount);
    }

    /// Applies to FUTURE proposals only, and cannot be changed while one is pending.
    function setRotationDelay(uint32 newDelay) external onlyAdmin {
        if (pendingAttestor != address(0)) revert RotationPending();
        if (newDelay < minRotationDelay() || newDelay > MAX_ROTATION_DELAY) revert DelayOutOfRange();
        emit RotationDelayChanged(rotationDelay, newDelay, msg.sender);
        rotationDelay = newDelay;
    }

    // ── two-step admin transfer ────────────────────────────────────────────────────────────────────

    function proposeAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        if (newAdmin == admin) revert SameAsCurrentAdmin();
        pendingAdmin = newAdmin;
        emit AdminTransferProposed(msg.sender, newAdmin);
    }

    function cancelAdminTransfer() external onlyAdmin {
        address proposed = pendingAdmin;
        if (proposed == address(0)) revert NoPendingAdminTransfer();
        delete pendingAdmin;
        emit AdminTransferCancelled(msg.sender, proposed);
    }

    /// Called by the proposed admin. The attestor and any pending rotation are untouched.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previous = admin;
        admin = msg.sender;
        delete pendingAdmin;
        emit AdminTransferAccepted(previous, msg.sender);
    }
}
