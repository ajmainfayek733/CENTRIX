import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone: a minimal server.js plus only the node_modules files the build
  // traced as reachable. The production Docker image ships that folder instead of the full
  // dependency tree, which is what keeps it small and free of dev tooling.
  output: "standalone",

  // Do not advertise the framework and version to every client.
  poweredByHeader: false,
};

export default nextConfig;
