/** The ExecutionPreparationService, or null unless wallets, Textile pricing and a secret key are configured. */
export const EXECUTION_PREPARATION_SERVICE = Symbol("EXECUTION_PREPARATION_SERVICE");
/** Runs preparations in the background and reports how they went. */
export const PREPARATION_TRACKER = Symbol("PREPARATION_TRACKER");
/** Repositories for the execution edge. */
export const EXECUTION_REPOSITORIES = Symbol("EXECUTION_REPOSITORIES");
/** The Kernel/bundler adapter, or null unless EXECUTION_ENABLED and everything it needs is configured. */
export const KERNEL_EXECUTION_PORT = Symbol("KERNEL_EXECUTION_PORT");
/** Root (passkey) actions: wallet deployment and permission installation. Null unless execution is enabled. */
export const ROOT_ACTION_SERVICE = Symbol("ROOT_ACTION_SERVICE");
/** Carries an authorized payment out. Null unless execution is enabled. */
export const EXECUTION_RUNNER = Symbol("EXECUTION_RUNNER");
/** Background runs and the last outcome of each. */
export const RUN_TRACKER = Symbol("RUN_TRACKER");
