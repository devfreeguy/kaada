// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IInitializable {
    function isInitialized(address smartAccount) external view returns (bool);
}

/// @title KaadaPasskeyValidatorFactory
/// @notice Deterministic EIP-1167 clones of the already-verified ZeroDev WebAuthn (passkey) validator. The factory
///         only creates instances; it never configures, upgrades, owns, funds or calls them (apart from one view).
///
/// WHY PER-CREDENTIAL INSTANCES. The ZeroDev passkey validator keeps ONE key per Kernel account
/// (`isInitialized(account)`, `AlreadyInitialized`). Kernel's `changeRootValidator` to an instance that is already
/// initialized for the account is a silent no-op that keeps the OLD key. So every root credential an account will
/// ever use (initial, recovered, backup, rotated) needs its own never-initialized instance, at an address that can
/// be committed to in advance (the recovery commitment names the new root validator address).
///
/// ADDRESS. instance = CREATE2(this factory, salt, keccak256(EIP-1167 initcode(IMPLEMENTATION))) with
///   salt = keccak256(abi.encode(SALT_DOMAIN, FACTORY_VERSION, account, purpose, credentialCommitment, deploymentSalt))
/// so it commits to: this factory, the exact implementation, the SCOPE (the Kernel account the instance is for), the
/// role, the credential, and an extra caller-chosen salt (a fresh instance for the same credential and role, e.g.
/// after a re-enrolment).
///
/// SCOPE AND THE CREATION-TIME ROOT. A Kernel account's address is derived from its initialization data, which names
/// its root validator, so the very first root instance cannot commit to an account address that depends on it.
/// Therefore `scope` may be address(0) ONLY for PURPOSE_PRIMARY (the creation-time root); the credential and the
/// caller's `deploymentSalt` (a per-wallet value) then make it unique. This is safe because the validator keeps its
/// state per account: sharing an address between accounts never shares a key. Every later role (RECOVERY, BACKUP,
/// ROTATION) must be scoped to a real, non-zero account.
///
/// FRONT-RUNNING. Anyone may deploy any instance, and doing so is harmless and idempotent: a fresh clone has EMPTY
/// storage, and the validator stores its key under `msg.sender` inside `onInstall`. Only the Kernel account itself
/// (running its own installation) can therefore initialize its own entry; no third party can initialize an instance
/// for someone else's account, and the account's key is whatever the account's own root/recovery data installs.
/// Deployment and initialization need NOT be atomic. The only thing an attacker can do is deploy the blank instance
/// early, which the owner wanted deployed anyway.
///
/// The credential commitment in the address is a derivation convention: the validator itself does not check it. The
/// binding that matters is the data the account installs (committed by the recovery validator's root commitment).
///
/// No owner, no admin, no upgrade path, no selfdestruct, no delegatecall of our own, no payable function, no token
/// approvals or transfers.
contract KaadaPasskeyValidatorFactory {
    error ZeroAccount();
    error ZeroCredentialCommitment();
    error InvalidPurpose(uint8 purpose);
    error MalformedValidatorData();
    error ImplementationHasNoCode();
    error ImplementationCodehashMismatch(bytes32 actual, bytes32 expected);
    error CloneFailed();

    /// The instance's role; part of the salt, so one credential can intentionally get distinct instances.
    uint8 public constant PURPOSE_PRIMARY = 0;
    uint8 public constant PURPOSE_RECOVERY = 1;
    uint8 public constant PURPOSE_BACKUP = 2;
    uint8 public constant PURPOSE_ROTATION = 3;

    /// Bump when the derivation or clone code changes: a new version can never collide with an old address.
    uint16 public constant FACTORY_VERSION = 1;
    bytes32 public constant SALT_DOMAIN = keccak256("kaada.passkey-validator-instance");
    bytes32 public constant CREDENTIAL_DOMAIN = keccak256("kaada.passkey-credential");

    enum Status {
        NOT_DEPLOYED,
        DEPLOYED_UNUSED,
        INITIALIZED_FOR_ACCOUNT
    }

    event InstanceDeployed(
        address indexed instance,
        address indexed scope,
        uint8 indexed purpose,
        bytes32 credentialCommitment,
        bytes32 deploymentSalt
    );

    /// The verified ZeroDev passkey validator every instance delegates to (no state of its own is ever used).
    address public immutable IMPLEMENTATION;
    /// Its code hash, checked at construction. The implementation has no SELFDESTRUCT and no DELEGATECALL.
    bytes32 public immutable IMPLEMENTATION_CODEHASH;

    constructor(address implementation, bytes32 expectedCodehash) {
        if (implementation.code.length == 0) revert ImplementationHasNoCode();
        bytes32 actual = implementation.codehash;
        if (actual != expectedCodehash) revert ImplementationCodehashMismatch(actual, expectedCodehash);
        IMPLEMENTATION = implementation;
        IMPLEMENTATION_CODEHASH = actual;
    }

    // ── derivation ─────────────────────────────────────────────────────────────────────────────────

    /// The commitment to a credential, from the exact `onInstall` data the passkey validator takes:
    /// abi.encode((uint256 x, uint256 y), bytes32 authenticatorIdHash). Rejects any other shape and a zero key.
    function credentialCommitment(bytes calldata validatorData) public pure returns (bytes32) {
        if (validatorData.length != 96) revert MalformedValidatorData();
        (uint256 x, uint256 y, bytes32 authenticatorIdHash) = abi.decode(validatorData, (uint256, uint256, bytes32));
        if (x == 0 || y == 0) revert MalformedValidatorData();
        return keccak256(abi.encode(CREDENTIAL_DOMAIN, x, y, authenticatorIdHash));
    }

    function saltFor(address scope, uint8 purpose, bytes32 commitment, bytes32 deploymentSalt)
        public
        pure
        returns (bytes32)
    {
        _checkInputs(scope, purpose, commitment);
        return keccak256(abi.encode(SALT_DOMAIN, FACTORY_VERSION, scope, purpose, commitment, deploymentSalt));
    }

    function predictInstance(address scope, uint8 purpose, bytes32 commitment, bytes32 deploymentSalt)
        public
        view
        returns (address)
    {
        bytes32 salt = saltFor(scope, purpose, commitment, deploymentSalt);
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(_initCode())))))
        );
    }

    // ── preflight ──────────────────────────────────────────────────────────────────────────────────

    function isDeployed(address scope, uint8 purpose, bytes32 commitment, bytes32 deploymentSalt)
        public
        view
        returns (bool)
    {
        return predictInstance(scope, purpose, commitment, deploymentSalt).code.length != 0;
    }

    /// Whether the instance (derived for `scope`) is already initialized for the Kernel `account` that would use it.
    function statusOf(address scope, address account, uint8 purpose, bytes32 commitment, bytes32 deploymentSalt)
        public
        view
        returns (Status)
    {
        if (account == address(0)) revert ZeroAccount();
        address instance = predictInstance(scope, purpose, commitment, deploymentSalt);
        if (instance.code.length == 0) return Status.NOT_DEPLOYED;
        return IInitializable(instance).isInitialized(account)
            ? Status.INITIALIZED_FOR_ACCOUNT
            : Status.DEPLOYED_UNUSED;
    }

    /// False when the instance is already initialized for `account` (it would silently keep the old key).
    function canUseForAccount(
        address scope,
        address account,
        uint8 purpose,
        bytes32 commitment,
        bytes32 deploymentSalt
    ) external view returns (bool) {
        return statusOf(scope, account, purpose, commitment, deploymentSalt) != Status.INITIALIZED_FOR_ACCOUNT;
    }

    // ── deployment ─────────────────────────────────────────────────────────────────────────────────

    /// Deploys the instance if absent; returns it either way (`created` says which). Permissionless and harmless:
    /// the clone starts blank and only a Kernel account itself can initialize its own entry.
    function deploy(address scope, uint8 purpose, bytes32 commitment, bytes32 deploymentSalt)
        external
        returns (address instance, bool created)
    {
        bytes32 salt = saltFor(scope, purpose, commitment, deploymentSalt);
        bytes memory code = _initCode();
        instance = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(code))))));
        if (instance.code.length != 0) return (instance, false);
        address deployed;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (deployed != instance || deployed.code.length == 0) revert CloneFailed();
        emit InstanceDeployed(instance, scope, purpose, commitment, deploymentSalt);
        return (instance, true);
    }

    // ── internals ──────────────────────────────────────────────────────────────────────────────────

    function _checkInputs(address scope, uint8 purpose, bytes32 commitment) private pure {
        if (purpose > PURPOSE_ROTATION) revert InvalidPurpose(purpose);
        if (scope == address(0) && purpose != PURPOSE_PRIMARY) revert ZeroAccount();
        if (commitment == bytes32(0)) revert ZeroCredentialCommitment();
    }

    /// EIP-1167 minimal proxy creation code for IMPLEMENTATION (45-byte runtime, delegatecall passthrough).
    function _initCode() private view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", IMPLEMENTATION, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }
}
