// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation, IKernelCalls} from "./Interfaces.sol";

/// @title KaadaDeviceKeyValidator
/// @notice An ERC-7579 validator for Kernel v3.3 whose signers are raw P-256 device keys (Secure Enclave, Android
///         Keystore/StrongBox, or a non-extractable WebCrypto key). It exists for users whose devices have no passkey
///         support; it is used exactly like the passkey validator: as the account root (or any) validator.
///
/// SIGNING MODEL (exact). A device key signs, with ECDSA P-256 / SHA-256 (the native "SHA256withECDSA" of every
/// platform keystore), the following 153-byte message:
///
///     payload = "KaadaDeviceKey/v1"      17 bytes ASCII  (domain tag and version)
///            || chainId                   32 bytes big-endian (block.chainid)
///            || validator                 20 bytes (this validator instance)
///            || account                   20 bytes (the Kernel account, msg.sender)
///            || keyId                     32 bytes
///            || userOpHash                32 bytes
///
/// The contract verifies the signature over sha256(payload) with the RIP-7212 precompile at 0x100. The signature in
/// `userOp.signature` is exactly 96 bytes: keyId (32) || r (32) || s (32), with 0 < r < n and 0 < s <= n/2 (low-s).
/// A WebAuthn/passkey signature can never validate here (a different keyspace, a different message) and a device
/// signature can never validate on the passkey validator (its message starts with the domain tag, not an
/// authenticator-data hash).
///
/// KEYS. Every account has its own set of up to MAX_KEYS keys, each identified by a caller-chosen non-zero `keyId`.
/// A key is a P-256 point that must be on the curve; the same point cannot be enrolled twice for one account. All
/// keys of an account are equals: any enrolled key can sign for the account, and so can add or remove the others
/// (through the account's own execution, since only the account may call `addKey`/`removeKey`).
///
/// FINAL KEY. `removeKey` and `onUninstall` revert while this validator is the account's CURRENT ROOT and the removal
/// would leave it with no key (Kernel exposes `rootValidator()`). A batch that first replaces the root and then
/// removes keys is allowed, because by then this validator is no longer the root.
///
/// FRESH INSTANCES. Kernel's `changeRootValidator` to a validator that is already installed for the account does NOT
/// call `onInstall`: the old keys come back to life. A root must therefore always be a never-used instance (deploy it
/// with KaadaPasskeyValidatorFactory using this contract as the implementation). This contract has no immutables and
/// derives its domain from `address(this)`, so it is safe behind an EIP-1167 clone.
///
/// No owner, no admin, no upgrade path, no selfdestruct, no delegatecall, no secp256k1 or software fallback: if the
/// precompile is missing, every signature fails closed.
contract KaadaDeviceKeyValidator {
    // ── errors ──────────────────────────────────────────────────────────────────────────────────────
    error AlreadyInitialized(address account);
    error NotInitialized(address account);
    error BadInstallData();
    error InvalidKeyId();
    error InvalidPublicKey();
    error KeyIdInUse(bytes32 keyId);
    error PublicKeyInUse(bytes32 existingKeyId);
    error UnknownKey(bytes32 keyId);
    error TooManyKeys();
    error CannotRemoveFinalKey();
    error CannotUninstallWhileRoot();

    // ── events ──────────────────────────────────────────────────────────────────────────────────────
    event Installed(address indexed account, bytes32 indexed keyId);
    event Uninstalled(address indexed account);
    event KeyAdded(address indexed account, bytes32 indexed keyId, uint256 x, uint256 y);
    event KeyRemoved(address indexed account, bytes32 indexed keyId);

    // ── constants ───────────────────────────────────────────────────────────────────────────────────
    uint256 public constant VERSION = 1;
    uint256 public constant MAX_KEYS = 16;
    bytes17 public constant DOMAIN_TAG = "KaadaDeviceKey/v1";
    uint256 private constant SIG_VALIDATION_FAILED = 1;
    address private constant P256_VERIFY = address(0x100);

    // NIST P-256 (secp256r1)
    uint256 private constant P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff;
    uint256 private constant B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b;
    uint256 private constant N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    uint256 private constant HALF_N = N / 2;

    struct Key {
        uint256 x;
        uint256 y;
        /// 1-based position in the account key list (0 = absent).
        uint256 slot;
    }

    mapping(address account => mapping(bytes32 keyId => Key)) private _keys;
    mapping(address account => bytes32[]) private _list;
    /// keccak256(x, y) => keyId, so one point cannot be enrolled twice for an account.
    mapping(address account => mapping(bytes32 pointHash => bytes32 keyId)) private _keyOfPoint;

    // ── ERC-7579 module ─────────────────────────────────────────────────────────────────────────────

    /// data = abi.encode(uint256 x, uint256 y, bytes32 keyId): the first key. Same 96-byte shape as the passkey
    /// validator install data.
    function onInstall(bytes calldata data) external {
        if (_list[msg.sender].length != 0) revert AlreadyInitialized(msg.sender);
        if (data.length != 96) revert BadInstallData();
        (uint256 x, uint256 y, bytes32 keyId) = abi.decode(data, (uint256, uint256, bytes32));
        _add(msg.sender, keyId, x, y);
        emit Installed(msg.sender, keyId);
    }

    /// Removes every key of the calling account. Refused while this validator is the account root.
    function onUninstall(bytes calldata) external {
        bytes32[] storage list = _list[msg.sender];
        uint256 length = list.length;
        if (length == 0) revert NotInitialized(msg.sender);
        if (_isRoot(msg.sender)) revert CannotUninstallWhileRoot();
        for (uint256 i = 0; i < length; i++) {
            bytes32 keyId = list[i];
            Key storage key = _keys[msg.sender][keyId];
            delete _keyOfPoint[msg.sender][keccak256(abi.encode(key.x, key.y))];
            delete _keys[msg.sender][keyId];
        }
        delete _list[msg.sender];
        emit Uninstalled(msg.sender);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 1;
    }

    function isInitialized(address account) external view returns (bool) {
        return _list[account].length != 0;
    }

    // ── key administration: only the account itself (every call is keyed by msg.sender) ────────────

    function addKey(bytes32 keyId, uint256 x, uint256 y) external {
        if (_list[msg.sender].length == 0) revert NotInitialized(msg.sender);
        _add(msg.sender, keyId, x, y);
        emit KeyAdded(msg.sender, keyId, x, y);
    }

    function removeKey(bytes32 keyId) external {
        bytes32[] storage list = _list[msg.sender];
        uint256 length = list.length;
        if (length == 0) revert NotInitialized(msg.sender);
        Key storage key = _keys[msg.sender][keyId];
        uint256 slot = key.slot;
        if (slot == 0) revert UnknownKey(keyId);
        if (length == 1 && _isRoot(msg.sender)) revert CannotRemoveFinalKey();

        delete _keyOfPoint[msg.sender][keccak256(abi.encode(key.x, key.y))];
        bytes32 last = list[length - 1];
        if (last != keyId) {
            list[slot - 1] = last;
            _keys[msg.sender][last].slot = slot;
        }
        list.pop();
        delete _keys[msg.sender][keyId];
        emit KeyRemoved(msg.sender, keyId);
    }

    // ── reads ───────────────────────────────────────────────────────────────────────────────────────

    function keyCount(address account) external view returns (uint256) {
        return _list[account].length;
    }

    function keyExists(address account, bytes32 keyId) external view returns (bool) {
        return _keys[account][keyId].slot != 0;
    }

    function keyOf(address account, bytes32 keyId) external view returns (uint256 x, uint256 y) {
        Key storage key = _keys[account][keyId];
        if (key.slot == 0) revert UnknownKey(keyId);
        return (key.x, key.y);
    }

    function keyIds(address account) external view returns (bytes32[] memory) {
        return _list[account];
    }

    /// The exact message a device key signs (see the contract header). Clients build the same bytes.
    function signingPayload(address account, bytes32 keyId, bytes32 userOpHash) public view returns (bytes memory) {
        return abi.encodePacked(DOMAIN_TAG, block.chainid, address(this), account, keyId, userOpHash);
    }

    /// What the precompile verifies the signature against: sha256(signingPayload).
    function signingDigest(address account, bytes32 keyId, bytes32 userOpHash) public view returns (bytes32) {
        return sha256(signingPayload(account, keyId, userOpHash));
    }

    // ── validation ──────────────────────────────────────────────────────────────────────────────────

    /// Kernel calls this with msg.sender == the account. Returns 0 (valid) or 1 (SIG_VALIDATION_FAILED); never
    /// reverts on a bad signature. There is no validity window and no state change.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        payable
        returns (uint256)
    {
        return _verify(msg.sender, userOp.signature, userOpHash) ? 0 : SIG_VALIDATION_FAILED;
    }

    /// ERC-1271 is intentionally unsupported: Kaada authorizes payments with UserOperations only.
    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }

    // ── internals ───────────────────────────────────────────────────────────────────────────────────

    function _add(address account, bytes32 keyId, uint256 x, uint256 y) private {
        if (keyId == bytes32(0)) revert InvalidKeyId();
        if (!_onCurve(x, y)) revert InvalidPublicKey();
        if (_keys[account][keyId].slot != 0) revert KeyIdInUse(keyId);
        bytes32 pointHash = keccak256(abi.encode(x, y));
        bytes32 existing = _keyOfPoint[account][pointHash];
        if (existing != bytes32(0)) revert PublicKeyInUse(existing);
        bytes32[] storage list = _list[account];
        if (list.length >= MAX_KEYS) revert TooManyKeys();
        list.push(keyId);
        _keys[account][keyId] = Key({x: x, y: y, slot: list.length});
        _keyOfPoint[account][pointHash] = keyId;
    }

    function _verify(address account, bytes calldata signature, bytes32 userOpHash) private view returns (bool) {
        if (signature.length != 96) return false;
        bytes32 keyId = bytes32(signature[0:32]);
        uint256 r = uint256(bytes32(signature[32:64]));
        uint256 s = uint256(bytes32(signature[64:96]));
        Key storage key = _keys[account][keyId];
        if (key.slot == 0) return false;
        if (r == 0 || r >= N || s == 0 || s > HALF_N) return false;
        bytes32 digest = signingDigest(account, keyId, userOpHash);
        (bool ok, uint256 result) = _p256(digest, r, s, key.x, key.y);
        return ok && result == 1;
    }

    /// RIP-7212. A chain without the precompile returns success with EMPTY data, which is rejected here.
    function _p256(bytes32 digest, uint256 r, uint256 s, uint256 x, uint256 y)
        private
        view
        returns (bool ok, uint256 result)
    {
        bytes memory input = abi.encode(digest, r, s, x, y);
        address target = P256_VERIFY;
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ok := staticcall(gas(), target, add(input, 0x20), mload(input), 0x00, 0x20)
            size := returndatasize()
            result := mload(0x00)
        }
        if (size != 32) return (false, 0);
    }

    function _onCurve(uint256 x, uint256 y) private pure returns (bool) {
        if (x == 0 || y == 0 || x >= P || y >= P) return false;
        uint256 lhs = mulmod(y, y, P);
        uint256 rhs = addmod(addmod(mulmod(mulmod(x, x, P), x, P), P - mulmod(3, x, P), P), B, P);
        return lhs == rhs;
    }

    /// Is this validator the account current root? (A non-contract or non-Kernel caller reads as "no".)
    function _isRoot(address account) private view returns (bool) {
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeWithSelector(IKernelCalls.rootValidator.selector));
        if (!ok || ret.length != 32) return false;
        return abi.decode(ret, (bytes21)) == bytes21(abi.encodePacked(bytes1(0x01), address(this)));
    }
}
