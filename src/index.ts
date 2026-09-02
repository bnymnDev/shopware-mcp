#!/usr/bin/env node
import { main } from "./cli.js";
import { logger } from "./logger.js";

main().catch((error: unknown) => {
  logger.error("fatal", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
