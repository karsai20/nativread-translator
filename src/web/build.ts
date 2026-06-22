// Bundles the browser entry (app.ts) to dist/app.js. Run at server startup and via
// `bun run build:web`.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(fileURLToPath(import.meta.url));

export async function buildWeb(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(webDir, "app.ts")],
    outdir: join(webDir, "dist"),
    target: "browser",
    minify: false,
    naming: "[name].js",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Web build failed");
  }
}

if (import.meta.main) {
  await buildWeb();
  console.log("Web bundle built -> src/web/dist/app.js");
}
