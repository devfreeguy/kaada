-- Quotes and routes are bound to the intent revision they were built for. A price or route made for
-- revision N is never valid for any other revision; nothing is inferred from "the latest intent".
-- Existing rows (none in practice) are given revision 1, then the default is dropped so every new
-- row must state its revision.

ALTER TABLE "Quote" ADD COLUMN "intentRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Quote" ALTER COLUMN "intentRevision" DROP DEFAULT;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_intentRevision_positive" CHECK ("intentRevision" >= 1);

ALTER TABLE "Route" ADD COLUMN "intentRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Route" ALTER COLUMN "intentRevision" DROP DEFAULT;
ALTER TABLE "Route" ADD CONSTRAINT "Route_intentRevision_positive" CHECK ("intentRevision" >= 1);

CREATE INDEX "Route_intentId_intentRevision_status_idx" ON "Route"("intentId", "intentRevision", "status");
