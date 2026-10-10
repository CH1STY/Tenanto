import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a minimal, self-contained server build (.next/standalone) so the
  // production Docker image only ships the runtime files it actually needs.
  output: "standalone",
  experimental: {
    // Month image uploads and building imports (which embed base64 images)
    // can exceed the 1 MB default, so allow a larger server-action body.
    serverActions: { bodySizeLimit: "32mb" },
  },
};

export default nextConfig;
