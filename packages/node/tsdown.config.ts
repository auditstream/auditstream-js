import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    express: "src/express.ts",
    hono: "src/hono.ts",
    next: "src/next.ts",
    pg: "src/pg.ts",
    "postgres-js": "src/postgres-js.ts",
    "neon-http": "src/neon-http.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
});
