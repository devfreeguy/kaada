export const AUTHORIZATION_AUDIT_EVENTS = {
  pinCreated: "authorization.pin_created",
  pinChanged: "authorization.pin_changed",
  pinVerificationFailed: "authorization.pin_verification_failed",
  pinLocked: "authorization.pin_locked",
  pinUnlocked: "authorization.pin_unlocked",
  pinResetRequired: "authorization.pin_reset_required",
  sessionCreated: "authorization.session_created",
  sessionExpired: "authorization.session_expired",
  sessionCancelled: "authorization.session_cancelled",
  paymentAuthorized: "authorization.payment_authorized",
  paymentAuthorizationRejected: "authorization.payment_authorization_rejected",
  paymentAuthorizationConsumed: "authorization.payment_authorization_consumed",
  paymentAuthorizationRevoked: "authorization.payment_authorization_revoked",
} as const;

export { PIN_ATTEMPT_POLICY, PIN_LENGTH, PIN_PATTERN, isValidPinFormat } from "./pin.js";
export type {
  PinAttemptReservation,
  TransactionPinRepository,
  TransactionPinSecurity,
} from "./pin.js";
export { AUTHORIZATION_SESSION_STATUSES, isSessionOpen } from "./session.js";
export type {
  AuthorizationSession,
  AuthorizationSessionRepository,
  AuthorizationSessionStatus,
  NewAuthorizationSession,
} from "./session.js";
export {
  PAYMENT_AUTHORIZATION_STATUSES,
  boundLimits,
  boundsAmountMode,
} from "./payment-authorization.js";
export type {
  AuthorizedBounds,
  AuthorizedRecipient,
  AuthorizedRoute,
  NewPaymentAuthorization,
  PaymentAuthorization,
  PaymentAuthorizationRepository,
  PaymentAuthorizationStatus,
} from "./payment-authorization.js";
export { AUTHORIZATION_VIOLATIONS, validateExecutionAgainstAuthorization } from "./policy.js";
export type { AuthorizationCheck, AuthorizationViolation, ExecutionCandidate } from "./policy.js";
