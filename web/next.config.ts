import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/**/*": ["./src/generated/prisma/**/*"],
  },
};

export default nextConfig;
