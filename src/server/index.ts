// Bun HTTP server. Binds HOST:PORT from config (default 0.0.0.0:48217 for in-container
// reachability). Serves the static web UI and the /api/* routes.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.ts";
import { handleApi } from "./routes.ts";
import { buildWeb } from "../web/build.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const webDir = join(serverDir, "..", "web");

const config = loadConfig();

// Build the browser bundle once at startup.
await buildWeb();

const STATIC: Record<string, { path: string; type: string }> = {
  "/": { path: join(webDir, "index.html"), type: "text/html; charset=utf-8" },
  "/index.html": { path: join(webDir, "index.html"), type: "text/html; charset=utf-8" },
  "/style.css": { path: join(webDir, "style.css"), type: "text/css; charset=utf-8" },
  "/app.js": { path: join(webDir, "dist", "app.js"), type: "text/javascript; charset=utf-8" },
};

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    const apiResponse = await handleApi(req, config);
    if (apiResponse) return apiResponse;

    const asset = STATIC[url.pathname];
    if (asset) {
      const file = Bun.file(asset.path);
      if (await file.exists()) {
        return new Response(file, { headers: { "content-type": asset.type } });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`quire-translator listening on http://${config.host}:${server.port}`);
console.log(
  config.providerName === "deepseek"
    ? "Provider: DeepSeek (live). Translation sends book text to DeepSeek."
    : "Provider: fake (no API key set) — zero-cost local dry run.",
);
