// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TESTNET PROTOTYPE (Celo Sepolia). Not audited. It proves ONE thing: a Kernel v3.3 validator that holds the
/// `execute` selector can still be limited, by its own validateUserOp, to a single exact recovery batch.
///
/// The only batch it will validate is, byte for byte (the whole userOp.callData is rebuilt and compared):
///   execute(MODE_BATCH, abi.encode([
///     Execution(account, 0, changeRootValidator(<committed root id, hook, validator data, hook data>)),
///     Execution(account, 0, invalidateNonce(account.currentNonce() + 1))
///   ]))
/// and only for an unexpired, matured, uncancelled recovery that two signatures authorised:
/// the recovery key (from the Recovery Code) and the attestor.

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

interface IKernelCalls {
    function execute(bytes32 execMode, bytes calldata executionCalldata) external payable;
    function changeRootValidator(bytes21 rootValidator, address hook, bytes calldata validatorData, bytes calldata hookData)
        external
        payable;
    function invalidateNonce(uint32 nonce) external payable;
    function currentNonce() external view returns (uint32);
}

contract RecoveryValidatorProbe {
    error AlreadyInitialized(address account);
    error NotInitialized(address account);
    error BadConfig();
    error NotAccount();
    error NotAttestor();
    error RecoveryActive();
    error NoPendingRecovery();
    error BadSignature();
    error Expired();
    error WrongSender();
    error NotTheCommittedBatch();

    event RecoveryInitiated(address indexed account, bytes32 commitment, uint48 executeAfter, uint64 nonce);
    event RecoveryCancelled(address indexed account, address by);
    event RecoveryConsumed(address indexed account, bytes32 commitment);

    struct Config {
        address recoveryKey;
        address attestor;
        uint32 delay;
        uint64 nonce;
        bool installed;
    }

    struct Pending {
        bytes32 commitment;
        uint48 executeAfter;
        bool active;
    }

    bytes32 internal constant MODE_BATCH = 0x0100000000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant INITIATE_TYPEHASH =
        keccak256("Initiate(address account,uint256 nonce,bytes32 commitment,uint256 deadline)");

    /// Production: a constant 24 hours. A constructor argument here so the probe can use seconds.
    uint32 public immutable MIN_DELAY;

    mapping(address => Config) public configs;
    mapping(address => Pending) public pendings;

    constructor(uint32 minDelay) {
        MIN_DELAY = minDelay;
    }

    // ── ERC-7579 module surface ──────────────────────────────────────────────────────────────────

    function onInstall(bytes calldata data) external payable {
        Config storage c = configs[msg.sender];
        if (c.installed) revert AlreadyInitialized(msg.sender);
        (address recoveryKey, address attestor, uint32 delay) = abi.decode(data, (address, address, uint32));
        if (recoveryKey == address(0) || attestor == address(0) || delay < MIN_DELAY) revert BadConfig();
        c.recoveryKey = recoveryKey;
        c.attestor = attestor;
        c.delay = delay;
        c.installed = true;
    }

    function onUninstall(bytes calldata) external payable {
        delete configs[msg.sender];
        delete pendings[msg.sender];
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 1;
    }

    function isInitialized(address account) external view returns (bool) {
        return configs[account].installed;
    }

    /// Recovery never signs messages for the account.
    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }

    // ── recovery lifecycle ───────────────────────────────────────────────────────────────────────

    function commitmentOf(
        address account,
        bytes21 rootId,
        address hook,
        bytes memory validatorData,
        bytes memory hookData
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(account, rootId, hook, keccak256(validatorData), keccak256(hookData)));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("KaadaRecovery"), keccak256("1"), block.chainid, address(this)));
    }

    function initiateDigest(address account, uint256 nonce, bytes32 commitment, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(INITIATE_TYPEHASH, account, nonce, commitment, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// Anyone may submit; authority is the two signatures over the commitment. The preimage (root id, hook,
    /// validator data, hook data) is revealed only in the recovery batch and checked against this commitment.
    function initiate(address account, bytes32 commitment, uint256 deadline, bytes calldata sigRecovery, bytes calldata sigAttestor)
        external
    {
        Config storage c = configs[account];
        if (!c.installed) revert NotInitialized(account);
        if (pendings[account].active) revert RecoveryActive();
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = initiateDigest(account, c.nonce, commitment, deadline);
        if (_recover(digest, sigRecovery) != c.recoveryKey) revert BadSignature();
        if (_recover(digest, sigAttestor) != c.attestor) revert BadSignature();
        uint48 executeAfter = uint48(block.timestamp + c.delay);
        pendings[account] = Pending({commitment: commitment, executeAfter: executeAfter, active: true});
        emit RecoveryInitiated(account, commitment, executeAfter, c.nonce);
    }

    /// The account itself (a root-signed operation) cancels.
    function cancel() external {
        _cancel(msg.sender, msg.sender);
    }

    /// The attestor may veto. It can never approve or complete anything.
    function attestorCancel(address account) external {
        if (msg.sender != configs[account].attestor) revert NotAttestor();
        _cancel(account, msg.sender);
    }

    function _cancel(address account, address by) internal {
        if (!pendings[account].active) revert NoPendingRecovery();
        delete pendings[account];
        configs[account].nonce += 1;
        emit RecoveryCancelled(account, by);
    }

    // ── the exact batch ──────────────────────────────────────────────────────────────────────────

    function validateUserOp(PackedUserOperation calldata userOp, bytes32) external payable returns (uint256) {
        address account = msg.sender;
        if (userOp.sender != account) revert WrongSender();
        Pending memory p = pendings[account];
        if (!p.active) revert NoPendingRecovery();

        // The committed parameters are read back out of the calldata, then the WHOLE calldata is rebuilt
        // from them and compared. Any extra call, changed target/value/selector, different mode, or even a
        // non-canonical ABI encoding fails the comparison.
        bytes calldata cd = userOp.callData;
        if (cd.length < 4 || bytes4(cd[:4]) != IKernelCalls.execute.selector) revert NotTheCommittedBatch();
        (bytes32 mode, bytes memory executionCalldata) = abi.decode(cd[4:], (bytes32, bytes));
        if (mode != MODE_BATCH) revert NotTheCommittedBatch();
        Execution[] memory given = abi.decode(executionCalldata, (Execution[]));
        if (given.length != 2) revert NotTheCommittedBatch();
        (bytes21 rootId, address hook, bytes memory validatorData, bytes memory hookData) = _rootArgs(given[0].callData);
        if (commitmentOf(account, rootId, hook, validatorData, hookData) != p.commitment) revert NotTheCommittedBatch();

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
        bytes memory rebuilt = abi.encodeCall(IKernelCalls.execute, (MODE_BATCH, abi.encode(expected)));
        if (keccak256(rebuilt) != keccak256(cd)) revert NotTheCommittedBatch();

        // One shot: consumed in validation, so the same recovery can never validate twice. (The nonce
        // invalidation inside the batch also voids this module, so a replay fails at the account.)
        delete pendings[account];
        configs[account].nonce += 1;
        emit RecoveryConsumed(account, p.commitment);

        // validAfter = executeAfter: the EntryPoint refuses the operation before it is matured. No
        // block.timestamp read in validation.
        return uint256(p.executeAfter) << 208;
    }

    function _rootArgs(bytes memory data)
        internal
        pure
        returns (bytes21 rootId, address hook, bytes memory validatorData, bytes memory hookData)
    {
        if (data.length < 4) revert NotTheCommittedBatch();
        bytes4 selector;
        assembly {
            selector := mload(add(data, 32))
        }
        if (selector != IKernelCalls.changeRootValidator.selector) revert NotTheCommittedBatch();
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = data[i + 4];
        }
        (rootId, hook, validatorData, hookData) = abi.decode(args, (bytes21, address, bytes, bytes));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        // low-s only (no malleable twin)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
