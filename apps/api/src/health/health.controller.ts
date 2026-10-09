import { Controller, Get, Inject, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { Database } from "@kaada/database";

import { DATABASE } from "../database/database.module.js";

export interface HealthResponse {
  status: "ok";
  uptime: number;
  timestamp: string;
}

export interface ReadinessResponse {
  status: "ok";
  database: "up";
}

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** Liveness: the process is up. Never touches the database. */
  @Get()
  check(): HealthResponse {
    return {
      status: "ok",
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: the database answers. */
  @Get("ready")
  async ready(): Promise<ReadinessResponse> {
    try {
      await this.database.ping();
    } catch (error) {
      this.logger.warn(`Database readiness check failed: ${(error as Error).name}`);
      throw new ServiceUnavailableException({ status: "unavailable", database: "down" });
    }
    return { status: "ok", database: "up" };
  }
}
