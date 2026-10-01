import type { NextConfig } from "next";

// Where the dashboard's server forwards /api requests. A deployment that runs the engine next
// to the dashboard builds with NEXT_PUBLIC_API_URL=/api, so the browser only talks to one origin.
const engineUrl = (process.env.ENGINE_URL ?? "http://localhost:4000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  agentRules: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${engineUrl}/:path*` }];
  },
};

export default nextConfig;
