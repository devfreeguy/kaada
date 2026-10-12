// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAttestorRegistry} from "../Interfaces.sol";

/// TEST ONLY. A registry whose attestor anyone can set.
contract MockAttestorRegistry is IAttestorRegistry {
    address public attestor;

    function setAttestor(address value) external {
        attestor = value;
    }
}
