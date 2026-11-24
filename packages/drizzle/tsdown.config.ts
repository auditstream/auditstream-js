import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    pg: "src/pg.ts",
    "neon-http": "src/neon-http.ts",
    "postgres-js": "src/postgres-js.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
});
