-- The transaction PIN grows from four to six digits. Every existing hash was made from a four-digit value and can never
-- match a six-digit one; they are removed (development/test wallets only: nothing is in production yet) so that no stale
-- hash lingers and every wallet is simply "no PIN yet" until its owner creates a six-digit PIN. Attempt counters and locks
-- live in the same row and go with it. The audit trail keeps the earlier pin_created / pin_changed events.
DELETE FROM "TransactionPinSecurity";
