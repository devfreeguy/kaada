-- The checkpoint is a deposit-detection aid (what the last check saw, to tell a new deposit from an announced one), never a balance.
ALTER TABLE "WalletBalanceCheckpoint" RENAME TO "WalletDepositCheckpoint";
ALTER TABLE "WalletDepositCheckpoint" RENAME COLUMN "balances" TO "observed";
ALTER TABLE "WalletDepositCheckpoint" RENAME CONSTRAINT "WalletBalanceCheckpoint_pkey" TO "WalletDepositCheckpoint_pkey";
ALTER TABLE "WalletDepositCheckpoint" RENAME CONSTRAINT "WalletBalanceCheckpoint_userId_fkey" TO "WalletDepositCheckpoint_userId_fkey";
ALTER TABLE "WalletDepositCheckpoint" RENAME CONSTRAINT "WalletBalanceCheckpoint_version_check" TO "WalletDepositCheckpoint_version_check";
ALTER INDEX "WalletBalanceCheckpoint_chainId_address_key" RENAME TO "WalletDepositCheckpoint_chainId_address_key";
ALTER INDEX "WalletBalanceCheckpoint_userId_idx" RENAME TO "WalletDepositCheckpoint_userId_idx";
