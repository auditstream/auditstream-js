import { defineConfig, type PrismaConfigInternal } from "prisma/config";

const config: PrismaConfigInternal = defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.APP_URL ?? "postgresql://localhost:5432/unused",
  },
});

export default config;
