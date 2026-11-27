import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const PUBLIC_DIRS = ["packages/node", "packages/prisma", "packages/drizzle"];

let importedSubpaths = 0;
let ranSmokeFiles = 0;

for (const dir of PUBLIC_DIRS) {
  const pkgDir = resolve(root, dir);
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const exportsMap = pkgJson.exports ?? {};

  for (const [subpath, target] of Object.entries(exportsMap)) {
    const entryRel = typeof target === "string" ? target : target?.default;
    if (!entryRel) {
      throw new Error(`Missing default export entry for ${pkgJson.name} (${subpath})`);
    }
    const entryUrl = pathToFileURL(resolve(pkgDir, entryRel)).href;
    const mod = await import(entryUrl);
    if (Object.keys(mod).length === 0) {
      throw new Error(`Empty module exported for ${pkgJson.name} (${subpath})`);
    }
    importedSubpaths += 1;
    console.log(`ok: ${pkgJson.name}${subpath === "." ? "" : subpath.slice(1)}`);
  }
}

const packagesDir = resolve(root, "packages");
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const smokeDir = join(packagesDir, entry.name, "smoke");
  if (!existsSync(smokeDir)) continue;

  const files = readdirSync(smokeDir, { withFileTypes: true })
    .filter((fileEntry) => fileEntry.isFile() && fileEntry.name.endsWith(".mjs"))
    .map((fileEntry) => fileEntry.name)
    .sort();
  for (const file of files) {
    const smokeUrl = pathToFileURL(join(smokeDir, file)).href;
    await import(smokeUrl);
    ranSmokeFiles += 1;
    console.log(`smoke ok: packages/${entry.name}/smoke/${file}`);
  }
}

console.log(
  `\nRuntime smoke checks passed (${importedSubpaths} subpaths, ${ranSmokeFiles} smoke files).`,
);
