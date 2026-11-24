import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["test/**/*.smoke.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});

export default config;
