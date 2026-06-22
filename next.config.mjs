import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output so the Proxmox container runs `node .next/standalone/server.js`
  // with no need for the full node_modules tree.
  output: "standalone",
  // Pin the tracing root to this project (a parent lockfile would otherwise confuse it).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // The translation core uses Node built-ins (fs, crypto) in route handlers.
  serverExternalPackages: ["fflate", "node-html-parser", "fast-xml-parser"],
};

export default nextConfig;
