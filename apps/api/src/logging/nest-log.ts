import { Logger } from "@nestjs/common";

import type { AgentLog } from "../core/agent/ports.js";

/** Adapts the core's structured `log(level, event, fields)` port to the application logger, under the given context. */
export function nestLog(context: string): AgentLog {
  const logger = new Logger(context);
  return (level, event, fields) => {
    const entry = { event, ...fields };
    if (level === "info") logger.log(entry);
    else if (level === "warn") logger.warn(entry);
    else logger.error(entry);
  };
}
