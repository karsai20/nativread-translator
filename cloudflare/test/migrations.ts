import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url).pathname;

/**
 * Applies every migration in filename order. Listing them by hand meant a new
 * migration was tested only if someone remembered to add it in two places.
 */
export async function applyMigrations(database: Database): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    database.exec(await Bun.file(join(MIGRATIONS_DIR, file)).text());
  }
}
