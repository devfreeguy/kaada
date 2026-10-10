/** The ExecutionPreparationService, or null unless wallets, Textile pricing and a secret key are configured. */
export const EXECUTION_PREPARATION_SERVICE = Symbol("EXECUTION_PREPARATION_SERVICE");
/** Runs preparations in the background and reports how they went. */
export const PREPARATION_TRACKER = Symbol("PREPARATION_TRACKER");
/** Repositories for the execution edge. */
export const EXECUTION_REPOSITORIES = Symbol("EXECUTION_REPOSITORIES");
