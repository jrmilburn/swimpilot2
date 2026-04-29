import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/*": ["./src/generated/prisma/**/*"],
    "/api/**/*": ["./src/generated/prisma/**/*"],
  },
};

export default nextConfig;
