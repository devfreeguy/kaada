/** The recovery runtime (flow, finalizer, configuration), or null when RECOVERY_ENABLED is not true. */
export const RECOVERY_RUNTIME = Symbol("RECOVERY_RUNTIME");

/**
 * Production attestor signer: `(kmsKeyId) => AttestorSigner`, installed by the deployment (an AWS/GCP KMS or HSM adapter built
 * on `createExternalSigner`). Absent by design: with RECOVERY_ATTESTOR_SIGNER=kms and no factory, startup FAILS rather than
 * fall back to a key file.
 */
export const ATTESTOR_SIGNER_FACTORY = Symbol("ATTESTOR_SIGNER_FACTORY");
