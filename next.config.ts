import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Month image uploads and building imports (which embed base64 images)
    // can exceed the 1 MB default, so allow a larger server-action body.
    serverActions: { bodySizeLimit: "32mb" },
  },
};

export default nextConfig;
