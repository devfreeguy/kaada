-- The browser channel as an identity type. ChannelType already had WEB; IdentityType did not, so a WEB conversation had no
-- account to attach to. Its only user today is the development agent playground.
--
-- Additive and safe: no existing row changes, and nothing reads WEB unless the playground is enabled. Because Identity is
-- unique on (type, externalId), a WEB identity can never collide with or resolve to a TELEGRAM account.
ALTER TYPE "IdentityType" ADD VALUE IF NOT EXISTS 'WEB';
