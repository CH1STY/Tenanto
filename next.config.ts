import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Allow month attachment uploads (optimized images can exceed the 1 MB default).
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
