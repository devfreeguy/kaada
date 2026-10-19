import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { createRepositories } from "@kaada/database";
import type { Database } from "@kaada/database";

import { DATABASE } from "../database/database.module.js";
import { errorText } from "../logging/error-text.js";

/** The tokens every supported flow starts from (the seed's core stablecoins). If these are missing, nothing can be priced. */
const CORE_SYMBOLS = ["USDT", "USDC", "cNGN", "CELO"] as const;

/**
 * At startup, checks that the reference data the agent depends on is really in the database, and says so in the log if it is
 * not. A database that was migrated but never seeded makes every asset "not supported" ("I don't support USDT yet"), which looks
 * like a bug in the agent. This turns that into one line that names the cause and the command that fixes it.
 */
@Injectable()
export class ReferenceDataCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger("ReferenceData");

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const assets = createRepositories(this.database).assets;
      const present: string[] = [];
      const missing: string[] = [];
      for (const symbol of CORE_SYMBOLS) {
        const found = await assets.findBySymbol(symbol);
        (found.length > 0 ? present : missing).push(symbol);
      }
      if (missing.length === CORE_SYMBOLS.length) {
        this.logger.error({
          event: "reference_data.not_seeded",
          missing,
          effect:
            "Every asset lookup fails, so the agent answers 'I don't support <token> yet' for any token, and no rate or payment can be priced",
          fix: "Seed the reference data once: docker run --rm --network alpha --env-file /opt/apps/kaada/.env ghcr.io/devfreeguy/kaada-migrator:<tag> db seed (see deploy/README.md, 'First deploy')",
        });
      } else if (missing.length > 0) {
        this.logger.warn({
          event: "reference_data.incomplete",
          present,
          missing,
          effect: `The agent cannot resolve ${missing.join(", ")}`,
          fix: "Run the seed again (it is idempotent): db seed",
        });
      } else {
        this.logger.log({ event: "reference_data.ok", assetsChecked: [...CORE_SYMBOLS] });
      }
    } catch (error) {
      this.logger.error({
        event: "reference_data.check_failed",
        reason: errorText(error),
        effect: "Could not read the asset registry; asset lookups will probably fail too",
      });
    }
  }
}
