// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST ONLY. Stands in for a Kernel account: lets a test call a module "as the account" and holds a
/// settable `currentNonce`. It enforces nothing.
contract MockAccount {
    uint32 public currentNonce = 1;

    function setCurrentNonce(uint32 value) external {
        currentNonce = value;
    }

    /// Calls `target` with msg.sender == this account; returns the raw result (bubbles nothing).
    function forward(address target, bytes calldata data) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call{value: msg.value}(data);
    }

    receive() external payable {}
}
