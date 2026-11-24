import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep @auditstream/node and @auditstream/prisma external so Route Handlers and Server Actions
  // share one Node ESM module instance (and one AsyncLocalStorage store) alongside the global PrismaClient.
  serverExternalPackages: [
    "@auditstream/node",
    "@auditstream/prisma",
    "pg",
    "@prisma/adapter-pg",
    "@prisma/client",
  ],
};

export default nextConfig;
