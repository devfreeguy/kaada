// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockedAttestorRegistry} from "../TimelockedAttestorRegistry.sol";

/// TESTNET / TEST ONLY. Identical to TimelockedAttestorRegistry except the minimum rotation delay is 10 seconds, so
/// a Celo Sepolia run does not wait a day. It must never be deployed on a production chain.
contract ShortDelayAttestorRegistry is TimelockedAttestorRegistry {
    constructor(address initialAdmin, address initialAttestor, uint32 initialDelay)
        TimelockedAttestorRegistry(initialAdmin, initialAttestor, initialDelay)
    {}

    function minRotationDelay() public pure override returns (uint32) {
        return 10;
    }
}
