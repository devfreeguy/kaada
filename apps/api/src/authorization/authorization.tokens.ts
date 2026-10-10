/** The TransactionPinService, or null when wallets are not configured. */
export const TRANSACTION_PIN_SERVICE = Symbol("TRANSACTION_PIN_SERVICE");
/** The AuthorizationSessionService (sessions, links, retiring stale approvals), or null. */
export const AUTHORIZATION_SESSION_SERVICE = Symbol("AUTHORIZATION_SESSION_SERVICE");
/** The PaymentAuthorizationService (PIN entry -> durable approval), or null. */
export const PAYMENT_AUTHORIZATION_SERVICE = Symbol("PAYMENT_AUTHORIZATION_SERVICE");
/** The AuthorizationPolicyService (can an execution proceed under an approval?), or null. */
export const AUTHORIZATION_POLICY_SERVICE = Symbol("AUTHORIZATION_POLICY_SERVICE");
/** The PinEnrollmentService (set or change the PIN with a passkey assertion), or null. */
export const PIN_ENROLLMENT_SERVICE = Symbol("PIN_ENROLLMENT_SERVICE");
