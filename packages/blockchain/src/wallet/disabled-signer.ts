import { KaadaError } from "@kaada/domain";
import type { ExecutionSigner, SignedExecution } from "@kaada/domain";

/**
 * The only ExecutionSigner that exists in this build. It refuses everything, so nothing can be signed
 * until the authorization build supplies a signer that checks the full list of conditions on
 * ExecutionSigner. It holds no key and has no way to obtain one.
 */
export class DisabledExecutionSigner implements ExecutionSigner {
  signValidatedExecution(_executionId: string): Promise<SignedExecution> {
    return Promise.reject(
      new KaadaError(
        "EXECUTION_NOT_ENABLED",
        "EXECUTION_NOT_ENABLED: signing is not available; payment authorization has not been built",
      ),
    );
  }
}
