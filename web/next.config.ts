import type { NextConfig } from "next";

// Local development keeps one .env at the repo root. Variables already set, as on Vercel, win.
try {
  process.loadEnvFile("../.env");
} catch {
  // No root .env: fine on Vercel and for the demo provider.
}

const nextConfig: NextConfig = {
  agentRules: false,
  // The engine lives in the server workspace as TypeScript.
  transpilePackages: ["@relay/server"],
  // PGlite loads its WebAssembly from its own package folder, and pg has optional native bits.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default nextConfig;
