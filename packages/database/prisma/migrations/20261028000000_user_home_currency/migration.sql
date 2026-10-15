-- A person's own choice of where they mainly use Kaada, and the default currency that follows from it.
-- Nullable on purpose: existing users have not chosen, and nothing assumes a country for them.
ALTER TABLE "User" ADD COLUMN "homeCountry" CHAR(2);
ALTER TABLE "User" ADD COLUMN "homeCurrency" CHAR(3);

-- The channel action kinds that carry a country choice and a conversion of a received balance.
ALTER TYPE "ChannelActionKind" ADD VALUE IF NOT EXISTS 'SET_COUNTRY';
ALTER TYPE "ChannelActionKind" ADD VALUE IF NOT EXISTS 'CONVERT_CURRENCY';
ALTER TYPE "ChannelActionKind" ADD VALUE IF NOT EXISTS 'KEEP_CURRENCY';
