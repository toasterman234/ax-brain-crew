import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["mermaid"],
  serverExternalPackages: ["@ax-llm/ax"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
