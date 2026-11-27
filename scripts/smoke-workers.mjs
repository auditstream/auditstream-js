#!/usr/bin/env node
/**
 * Cloudflare Workers smoke test: bundles packages/node/smoke/workers/worker.mjs (which imports
 * the built packages/node/dist) and runs it with `workerd test` once per documented
 * configuration. Run `pnpm build` first, or use `pnpm test:workers`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsdown";

const require = createRequire(import.meta.url);
const workerd = require("workerd");

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = resolve(ROOT, "packages/node/smoke/workers/worker.mjs");

const CONFIGURATIONS = [
  {
    name: "nodejs_als flag, compatibility date 2024-01-01",
    date: "2024-01-01",
    flags: ["nodejs_als"],
  },
  { name: "compatibility date 2026-08-04, no flags", date: "2026-08-04", flags: [] },
];

function capnpConfig(bundle, date, flags) {
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (services = [(name = "main", worker = .worker)]);

const worker :Workerd.Worker = (
  modules = [(name = "worker", esModule = embed ${JSON.stringify(bundle)})],
  compatibilityDate = ${JSON.stringify(date)},
  compatibilityFlags = [${flags.map((flag) => JSON.stringify(flag)).join(", ")}],
  bindings = [(name = "SELF", service = "main")],
);
`;
}

if (!existsSync(resolve(ROOT, "packages/node/dist/hono.mjs"))) {
  throw new Error("packages/node/dist is missing; run `pnpm build` first.");
}

const outDir = mkdtempSync(join(tmpdir(), "auditstream-workers-"));
const failed = [];
try {
  await build({
    entry: { worker: ENTRY },
    outDir,
    format: "esm",
    platform: "neutral",
    config: false,
    tsconfig: false,
    dts: false,
    logLevel: "warn",
    deps: { neverBundle: [/^node:/], alwaysBundle: [/^(?!node:)/] },
  });
  const bundle = readdirSync(outDir).find((file) => /^worker\.m?js$/.test(file));
  if (bundle === undefined) {
    throw new Error(`Bundle not found in ${outDir}`);
  }

  for (const { name, date, flags } of CONFIGURATIONS) {
    const configPath = join(outDir, "config.capnp");
    writeFileSync(configPath, capnpConfig(bundle, date, flags));
    console.log(`\n==> workerd ${workerd.version}: ${name}`);
    const { status, error } = spawnSync(workerd.default, ["test", configPath], {
      stdio: "inherit",
    });
    if (error !== undefined || status !== 0) {
      failed.push(name);
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failed.length > 0) {
  console.error(`\nCloudflare Workers smoke test failed: ${failed.join("; ")}`);
  process.exit(1);
}
console.log(`\nCloudflare Workers smoke test passed (${CONFIGURATIONS.length} configurations).`);
