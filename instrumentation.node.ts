import { loadConfig } from "./lib/server/config";
import { ensureRetentionSweep } from "./lib/server/retention";

ensureRetentionSweep(loadConfig());
