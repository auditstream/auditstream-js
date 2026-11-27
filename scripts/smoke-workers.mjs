#!/usr/bin/env node
/**
 * Cloudflare Workers smoke test: bundles packages/node/smoke/workers/worker.mjs (which imports
 * the built packages/node/dist) and runs it with `workerd test` once per documented
 * configuration. Run `pnpm build` first, or use `pnpm test:workers`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsdown";

const require = createRequire(import.meta.url);
const workerd = require("workerd");

const ROOT = resolve(import.meta.dirname, "..");
const NODE_PKG_DIR = resolve(ROOT, "packages/node");
const ENTRY = resolve(NODE_PKG_DIR, "smoke/workers/worker.mjs");

const CONFIGURATIONS = [
  {
    name: "nodejs_als flag, compatibility date 2024-01-01",
    date: "2024-01-01",
    flags: ["nodejs_als"],
    expectNodeGlobals: false,
  },
  {
    name: "compatibility date 2026-08-04, no flags",
    date: "2026-08-04",
    flags: [],
    expectNodeGlobals: true,
  },
];

function capnpConfig(bundle, date, flags, expectNodeGlobals) {
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (services = [(name = "main", worker = .worker)]);

const worker :Workerd.Worker = (
  modules = [(name = "worker", esModule = embed ${JSON.stringify(bundle)})],
  compatibilityDate = ${JSON.stringify(date)},
  compatibilityFlags = [${flags.map((flag) => JSON.stringify(flag)).join(", ")}],
  bindings = [
    (name = "SELF", service = "main"),
    (name = "EXPECT_NODE_GLOBALS", text = ${JSON.stringify(String(expectNodeGlobals))}),
  ],
);
`;
}

function assertNodeDistBuilt() {
  const pkgJson = JSON.parse(readFileSync(join(NODE_PKG_DIR, "package.json"), "utf8"));
  for (const [subpath, target] of Object.entries(pkgJson.exports ?? {})) {
    const entryRel = typeof target === "string" ? target : target?.default;
    if (!entryRel || !existsSync(resolve(NODE_PKG_DIR, entryRel))) {
      throw new Error(
        `packages/node/dist is missing ${subpath} (${entryRel ?? "unconfigured"}); run \`pnpm build\` first.`,
      );
    }
  }
}

assertNodeDistBuilt();

const outDir = mkdtempSync(join(tmpdir(), "auditstream-workers-"));
const failed = [];
try {
  await build({
    cwd: ROOT,
    entry: { worker: ENTRY },
    outDir,
    format: "esm",
    platform: "neutral",
    config: false,
    tsconfig: false,
    dts: false,
    logLevel: "warn",
    deps: { neverBundle: [/^node:/], alwaysBundle: [/^(?!node:)/] },
    outputOptions: { codeSplitting: false },
  });
  const bundles = readdirSync(outDir).filter((file) => /\.m?js$/.test(file));
  if (bundles.length !== 1 || !/^worker\.m?js$/.test(bundles[0])) {
    throw new Error(`Expected single worker bundle in ${outDir}, found: ${bundles.join(", ")}`);
  }
  const [bundle] = bundles;

  for (const { name, date, flags, expectNodeGlobals } of CONFIGURATIONS) {
    const configPath = join(outDir, "config.capnp");
    writeFileSync(configPath, capnpConfig(bundle, date, flags, expectNodeGlobals));
    console.log(`\n==> workerd ${workerd.version}: ${name}`);
    const { status, signal, error } = spawnSync(workerd.default, ["test", configPath], {
      stdio: "inherit",
      timeout: 60_000,
    });
    if (error !== undefined) {
      console.error(`Failed to run workerd (${name}): ${error.message}`);
      failed.push(name);
      break;
    }
    if (signal !== null) {
      console.error(`workerd terminated by signal ${signal} (${name})`);
      failed.push(name);
      if (signal === "SIGINT") break;
      continue;
    }
    if (status !== 0) {
      failed.push(name);
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
}

if (failed.length > 0) {
  console.error(`\nCloudflare Workers smoke test failed: ${failed.join("; ")}`);
  process.exit(1);
}
console.log(`\nCloudflare Workers smoke test passed (${CONFIGURATIONS.length} configurations).`);
