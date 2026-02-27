#!/usr/bin/env node

import { runCli } from "./cli/index.js";

void runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
