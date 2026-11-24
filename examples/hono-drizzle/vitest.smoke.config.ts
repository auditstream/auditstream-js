import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["test/**/*.smoke.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

export default config;
