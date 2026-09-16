import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Do not generate AGENTS.md and CLAUDE.md in the project.
  agentRules: false,
};

export default nextConfig;
