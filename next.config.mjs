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
  // Browser hardening for the whole app, mirroring the Worker's securityHeaders().
  // The CSP deliberately omits script-src: the app ships inline bootstrap scripts
  // (Next's own, plus the no-flash theme script in layout.tsx), so a script policy
  // needs per-request nonces to be anything but theatre. The directives below are
  // the ones that work without them — clickjacking, base-tag injection and form
  // hijacking are closed off today. Reader HTML stays DOMPurify-sanitized.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
          },
          // Ignored by browsers over plain HTTP, so a LAN deployment is unaffected.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
