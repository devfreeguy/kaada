/** The RootCredentialService (which root a wallet has), or null when wallets are not configured. */
export const ROOT_CREDENTIAL_SERVICE = Symbol("ROOT_CREDENTIAL_SERVICE");
/** The RootAdapters (the per-type checks of a root's proof), or null when wallets are not configured. */
export const ROOT_ADAPTERS = Symbol("ROOT_ADAPTERS");
/** The RootProofService (off-chain proofs by the root, e.g. PIN enrolment), or null. */
export const ROOT_PROOF_SERVICE = Symbol("ROOT_PROOF_SERVICE");
/** The RootValidatorDeployer (puts a device-key clone on chain), or null when device-key roots are off. */
export const ROOT_VALIDATOR_DEPLOYER = Symbol("ROOT_VALIDATOR_DEPLOYER");
/** The RootChangeService (rotate the root, enrol a backup), or null unless recovery and device-key infrastructure are configured. */
export const ROOT_CHANGE_SERVICE = Symbol("ROOT_CHANGE_SERVICE");
