// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST ONLY. Stands in for a Kernel account: lets a test call a module "as the account", holds a settable
/// `currentNonce` and a settable `rootValidator` (so a test can say which validator is the root). It enforces nothing.
contract MockAccount {
    uint32 public currentNonce = 1;
    bytes21 public rootValidator;

    function setCurrentNonce(uint32 value) external {
        currentNonce = value;
    }

    function setRootValidator(bytes21 value) external {
        rootValidator = value;
    }

    /// Calls `target` with msg.sender == this account; returns the raw result (bubbles nothing).
    function forward(address target, bytes calldata data) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call{value: msg.value}(data);
    }

    receive() external payable {}
}
