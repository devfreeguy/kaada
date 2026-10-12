// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ERC-4337 v0.7 packed user operation (the shape Kernel hands to validators).
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

/// ERC-7579 batch element.
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

/// The Kernel v3.3 account functions the recovery batch touches.
interface IKernelCalls {
    function execute(bytes32 execMode, bytes calldata executionCalldata) external payable;
    function changeRootValidator(
        bytes21 rootValidator,
        address hook,
        bytes calldata validatorData,
        bytes calldata hookData
    ) external payable;
    function invalidateNonce(uint32 nonce) external payable;
    function currentNonce() external view returns (uint32);
    /// The account current root validation id: 0x01 || validator address for a validator-type root.
    function rootValidator() external view returns (bytes21);
}

/// The shared, timelocked attestor registry. Recovery validators only READ it.
interface IAttestorRegistry {
    function currentAttestor() external view returns (address);
}
