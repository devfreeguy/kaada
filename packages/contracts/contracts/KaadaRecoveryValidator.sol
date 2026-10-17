// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation, Execution, IKernelCalls} from "./Interfaces.sol";

/// @title KaadaRecoveryValidator
/// @notice A Kernel v3.3 (ERC-7579) validator that can do exactly one thing: rotate a wallet's ROOT validator and
///         invalidate every older validator/permission, atomically, after a timelocked, Recovery-Code-signed recovery.
///
/// What it can NEVER do: move funds, approve, swap, call any third party, install modules, or grant itself
/// anything. It holds Kernel's `execute` selector (a batch needs it), and its `validateUserOp` therefore accepts
/// ONLY this exact `userOp.callData` — rebuilt byte for byte from the committed parameters and compared by hash:
///
///   execute(MODE_BATCH, abi.encode([
///     Execution(account, 0, changeRootValidator(committed rootId, hook, validatorData, hookData)),
///     Execution(account, 0, invalidateNonce(account.currentNonce() + 1))
///   ]))
///
/// STARTING a recovery needs two independent things, and neither is enough alone:
///   1. the signature of the recovery key (derived client-side from the user's Recovery Code) over the exact new root, and
///   2. the transaction coming from the ONE configured recovery relayer (`RELAYER`, immutable).
/// The relayer is Kaada's submission gate, not an authority: it can only forward a signature it was handed, so a compromised
/// relayer cannot recover a wallet (it cannot produce the Recovery Code signature) and a Recovery Code holder cannot call
/// `initiate` themselves (they are not the relayer). The relayer submits only after Kaada has checked the registered email and
/// the authenticator-app code OFF-CHAIN; this contract never sees those two and does not pretend to verify them.
///
/// The relayer has no other power: it cannot cancel, approve or complete anything. The account's own root can `cancel()` at any
/// time before the batch executes, directly, with no relayer involved, and the timelock (24 h hard floor) gives it the time to.
/// If the relayer is unavailable nobody can start a recovery: the design chooses safety over availability.
///
/// After a successful recovery this validator is VOIDED for the account (config deleted, the recovery key can
/// never be installed again, and Kernel's own invalidateNonce makes the old installation unusable). The new root
/// must install a fresh configuration with a NEW recovery key.
///
/// Not upgradeable. No owner. No admin. No external state is read. Replacing the relayer key means deploying a new validator
/// (the relayer address is immutable) and re-arming recovery on the wallets that should use it.
contract KaadaRecoveryValidator {
    // ── errors ────────────────────────────────────────────────────────────────────────────────────
    error AlreadyInitialized(address account);
    error NotInitialized(address account);
    error BadConfig();
    error NotRelayer();
    error RecoveryKeyAlreadyUsed();
    error RecoveryActive();
    error NoPendingRecovery();
    error BadSignature();
    error Expired();
    error WrongSender();
    error NotTheCommittedBatch();
    error InvalidRoot();

    // ── events (every state change is auditable) ───────────────────────────────────────────────────
    event Installed(address indexed account, address recoveryKey, uint32 delay);
    event Uninstalled(address indexed account);
    event RecoveryKeyChanged(address indexed account, address newRecoveryKey);
    event DelayChanged(address indexed account, uint32 newDelay);
    event RecoveryInitiated(address indexed account, uint64 indexed nonce, bytes32 commitment, uint48 executeAfter);
    /// The committed new root, for audit and for notifications.
    event RecoveryRootCommitted(
        address indexed account,
        uint64 indexed nonce,
        bytes21 rootId,
        address hook,
        bytes32 validatorDataHash,
        bytes32 hookDataHash
    );
    event RecoveryCancelled(address indexed account, uint64 indexed nonce);
    event RecoveryConsumed(address indexed account, uint64 indexed nonce, bytes32 commitment);

    // ── types ──────────────────────────────────────────────────────────────────────────────────────
    struct Config {
        address recoveryKey;
        uint32 delay;
        bool installed;
    }

    struct Pending {
        bytes32 commitment;
        uint48 executeAfter;
        bool active;
    }

    /// The new root, as committed. Hashes only: the preimages are revealed in the recovery batch itself.
    struct RootCommitment {
        bytes21 rootId; // 0x01 || validator address
        address hook;
        bytes32 validatorDataHash;
        bytes32 hookDataHash;
    }

    // ── constants ──────────────────────────────────────────────────────────────────────────────────
    bytes32 internal constant MODE_BATCH = 0x0100000000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant INITIATE_TYPEHASH = keccak256(
        "Initiate(address account,uint256 nonce,bytes21 rootId,address hook,bytes32 validatorDataHash,bytes32 hookDataHash,uint256 deadline)"
    );
    /// secp256k1n / 2: only low-s signatures (no malleable twin).
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// The ONLY address that may call `initiate`: Kaada's recovery relayer. Immutable, so no admin can swap it.
    address public immutable RELAYER;

    // ── state, all keyed by account (ERC-4337 associated storage) ──────────────────────────────────
    mapping(address account => Config) public configs;
    mapping(address account => Pending) public pendings;
    /// Monotonic per account; never reset, so signatures can never be replayed across (re)installations.
    mapping(address account => uint64) public recoveryNonce;
    /// A recovery key that has been consumed by a completed recovery can never be installed again.
    mapping(address account => mapping(address key => bool)) public usedRecoveryKeys;

    constructor(address relayer) {
        if (relayer == address(0)) revert BadConfig();
        RELAYER = relayer;
    }

    /// The smallest delay a wallet may configure. 24 hours in production.
    function minDelay() public view virtual returns (uint32) {
        return 1 days;
    }

    // ── ERC-7579 module surface ────────────────────────────────────────────────────────────────────

    /// data = abi.encode(address recoveryKey, uint32 delay). Called by the account (msg.sender).
    function onInstall(bytes calldata data) external payable {
        Config storage c = configs[msg.sender];
        if (c.installed) revert AlreadyInitialized(msg.sender);
        (address recoveryKey, uint32 delay) = abi.decode(data, (address, uint32));
        if (recoveryKey == address(0) || delay < minDelay()) revert BadConfig();
        if (usedRecoveryKeys[msg.sender][recoveryKey]) revert RecoveryKeyAlreadyUsed();
        c.recoveryKey = recoveryKey;
        c.delay = delay;
        c.installed = true;
        emit Installed(msg.sender, recoveryKey, delay);
    }

    function onUninstall(bytes calldata) external payable {
        delete configs[msg.sender];
        delete pendings[msg.sender];
        emit Uninstalled(msg.sender);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 1; // validator
    }

    function isInitialized(address account) external view returns (bool) {
        return configs[account].installed;
    }

    /// A recovery validator never signs messages for the account.
    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }

    // ── configuration (the account itself only: a root-signed operation) ───────────────────────────

    function setRecoveryKey(address newRecoveryKey) external {
        Config storage c = configs[msg.sender];
        if (!c.installed) revert NotInitialized(msg.sender);
        if (pendings[msg.sender].active) revert RecoveryActive();
        if (newRecoveryKey == address(0) || usedRecoveryKeys[msg.sender][newRecoveryKey]) revert BadConfig();
        c.recoveryKey = newRecoveryKey;
        emit RecoveryKeyChanged(msg.sender, newRecoveryKey);
    }

    function setDelay(uint32 newDelay) external {
        Config storage c = configs[msg.sender];
        if (!c.installed) revert NotInitialized(msg.sender);
        if (pendings[msg.sender].active) revert RecoveryActive();
        if (newDelay < minDelay()) revert BadConfig();
        c.delay = newDelay;
        emit DelayChanged(msg.sender, newDelay);
    }

    // ── recovery lifecycle ─────────────────────────────────────────────────────────────────────────

    function commitmentOf(address account, RootCommitment memory root) public pure returns (bytes32) {
        return keccak256(abi.encode(account, root.rootId, root.hook, root.validatorDataHash, root.hookDataHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("KaadaRecovery"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// The digest the recovery key signs. chainId and this contract are in the domain; account, recovery nonce, new
    /// validator id, hook, validator-data hash and hook-data hash are in the message.
    function initiateDigest(address account, uint64 nonce, RootCommitment memory root, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                INITIATE_TYPEHASH,
                account,
                uint256(nonce),
                root.rootId,
                root.hook,
                root.validatorDataHash,
                root.hookDataHash,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// Only the configured relayer may submit, and only with the recovery key's signature. Starts the timelock.
    function initiate(address account, RootCommitment calldata root, uint256 deadline, bytes calldata sigRecovery)
        external
    {
        if (msg.sender != RELAYER) revert NotRelayer();
        Config storage c = configs[account];
        if (!c.installed) revert NotInitialized(account);
        if (pendings[account].active) revert RecoveryActive();
        if (block.timestamp > deadline) revert Expired();
        _checkRoot(root.rootId);

        uint64 nonce = recoveryNonce[account];
        if (_recover(initiateDigest(account, nonce, root, deadline), sigRecovery) != c.recoveryKey) {
            revert BadSignature();
        }
        _open(account, root, nonce, c.delay);
    }

    function _open(address account, RootCommitment calldata root, uint64 nonce, uint32 delay) internal {
        bytes32 commitment = commitmentOf(account, root);
        uint48 executeAfter = uint48(block.timestamp + delay);
        pendings[account] = Pending({commitment: commitment, executeAfter: executeAfter, active: true});
        emit RecoveryInitiated(account, nonce, commitment, executeAfter);
        emit RecoveryRootCommitted(
            account, nonce, root.rootId, root.hook, root.validatorDataHash, root.hookDataHash
        );
    }

    /// The account itself (a root-signed operation) cancels a pending recovery. Nobody else can.
    function cancel() external {
        address account = msg.sender;
        if (!pendings[account].active) revert NoPendingRecovery();
        delete pendings[account];
        uint64 nonce = recoveryNonce[account]++;
        emit RecoveryCancelled(account, nonce);
    }

    // ── the exact batch ────────────────────────────────────────────────────────────────────────────

    /// Kernel calls this as `msg.sender == account`. The signature field is ignored: authority was established
    /// at `initiate`, and anyone may relay the matured, committed batch.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32) external payable returns (uint256) {
        address account = msg.sender;
        if (userOp.sender != account) revert WrongSender();
        Pending memory p = pendings[account];
        if (!p.active) revert NoPendingRecovery();

        _verifyBatch(account, userOp.callData, p.commitment);

        // One shot, consumed during validation. The recovery key is burnt and the configuration deleted: this
        // validator is void for the account until the NEW root installs a NEW recovery key.
        uint64 nonce = recoveryNonce[account]++;
        usedRecoveryKeys[account][configs[account].recoveryKey] = true;
        delete pendings[account];
        delete configs[account];
        emit RecoveryConsumed(account, nonce, p.commitment);

        // validAfter = executeAfter: the EntryPoint refuses the operation before maturity (no TIMESTAMP read in
        // validation, as ERC-4337 requires).
        return uint256(p.executeAfter) << 208;
    }

    /// Reverts unless `cd` is EXACTLY the committed recovery batch for `account`.
    function _verifyBatch(address account, bytes calldata cd, bytes32 committed) internal view {
        if (cd.length < 4 || bytes4(cd[:4]) != IKernelCalls.execute.selector) revert NotTheCommittedBatch();
        (bytes32 mode, bytes memory executionCalldata) = abi.decode(cd[4:], (bytes32, bytes));
        if (mode != MODE_BATCH) revert NotTheCommittedBatch();
        Execution[] memory given = abi.decode(executionCalldata, (Execution[]));
        if (given.length != 2) revert NotTheCommittedBatch();

        // The committed parameters are read out of call 1, hashed, and compared with the commitment...
        (bytes21 rootId, address hook, bytes memory validatorData, bytes memory hookData) =
            _rootArgs(given[0].callData);
        if (
            commitmentOf(
                account,
                RootCommitment({
                    rootId: rootId,
                    hook: hook,
                    validatorDataHash: keccak256(validatorData),
                    hookDataHash: keccak256(hookData)
                })
            ) != committed
        ) revert NotTheCommittedBatch();

        // ...then the WHOLE calldata is rebuilt from them and must match byte for byte: any extra call, changed
        // target/value/selector/argument, other mode or non-canonical ABI encoding fails here.
        Execution[] memory expected = new Execution[](2);
        expected[0] = Execution({
            target: account,
            value: 0,
            callData: abi.encodeCall(IKernelCalls.changeRootValidator, (rootId, hook, validatorData, hookData))
        });
        expected[1] = Execution({
            target: account,
            value: 0,
            callData: abi.encodeCall(IKernelCalls.invalidateNonce, (IKernelCalls(account).currentNonce() + 1))
        });
        if (keccak256(abi.encodeCall(IKernelCalls.execute, (MODE_BATCH, abi.encode(expected)))) != keccak256(cd)) {
            revert NotTheCommittedBatch();
        }
    }

    // ── internals ──────────────────────────────────────────────────────────────────────────────────

    /// The new root must be a VALIDATOR-type id (0x01) naming a contract, and never this module itself.
    function _checkRoot(bytes21 rootId) internal view {
        if (bytes1(rootId) != 0x01) revert InvalidRoot();
        address validator = address(bytes20(rootId << 8));
        if (validator == address(0) || validator == address(this) || validator.code.length == 0) revert InvalidRoot();
    }

    function _rootArgs(bytes memory data)
        internal
        pure
        returns (bytes21 rootId, address hook, bytes memory validatorData, bytes memory hookData)
    {
        if (data.length < 4) revert NotTheCommittedBatch();
        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(data, 32))
        }
        if (selector != IKernelCalls.changeRootValidator.selector) revert NotTheCommittedBatch();
        (rootId, hook, validatorData, hookData) = abi.decode(_dropSelector(data), (bytes21, address, bytes, bytes));
    }

    /// A copy of `data` without its first four bytes.
    function _dropSelector(bytes memory data) internal pure returns (bytes memory out) {
        uint256 length = data.length - 4;
        out = new bytes(length);
        assembly ("memory-safe") {
            let src := add(data, 36)
            let dst := add(out, 32)
            for { let i := 0 } lt(i, length) { i := add(i, 32) } { mstore(add(dst, i), mload(add(src, i))) }
        }
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
