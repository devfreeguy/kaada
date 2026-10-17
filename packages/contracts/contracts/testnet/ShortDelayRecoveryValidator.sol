// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KaadaRecoveryValidator} from "../KaadaRecoveryValidator.sol";

/// TESTNET / TEST ONLY. Identical to KaadaRecoveryValidator except the minimum delay is 10 seconds, so a Celo
/// Sepolia run does not wait 24 hours. It must never be deployed on a production chain.
contract ShortDelayRecoveryValidator is KaadaRecoveryValidator {
    constructor(address relayer) KaadaRecoveryValidator(relayer) {}

    function minDelay() public pure override returns (uint32) {
        return 10;
    }
}
