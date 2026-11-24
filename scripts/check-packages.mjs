import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PUBLIC_PACKAGES = ["@auditstream/node", "@auditstream/prisma", "@auditstream/drizzle"];
const packDir = mkdtempSync(join(tmpdir(), "auditstream-pack-"));

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

try {
  for (const pkg of PUBLIC_PACKAGES) {
    console.log(`\n==> Packing ${pkg}`);
    run("pnpm", ["--filter", pkg, "pack", "--pack-destination", packDir]);
  }

  const tarballs = readdirSync(packDir)
    .filter((name) => name.endsWith(".tgz"))
    .sort();

  if (tarballs.length !== PUBLIC_PACKAGES.length) {
    throw new Error(`Expected ${PUBLIC_PACKAGES.length} tarballs, found ${tarballs.length}`);
  }

  for (const file of tarballs) {
    const tarball = join(packDir, file);
    console.log(`\n==> publint ${file}`);
    run("pnpm", ["exec", "publint", "--strict", tarball]);

    console.log(`\n==> attw (esm-only) ${file}`);
    run("pnpm", ["exec", "attw", "--profile", "esm-only", tarball]);
  }

  console.log(`\nAll ${tarballs.length} package tarballs passed publint and attw (esm-only).`);
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
