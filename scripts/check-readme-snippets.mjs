#!/usr/bin/env node
/**
 * Extracts every fenced `ts` code block from `packages/*\/README.md` (and root `README.md`)
 * and type-checks it against the built workspace packages (`dist/*.d.mts`) using strict `tsc`.
 * Also verifies that no published package README contains relative Markdown links.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TSC_BIN = resolve(ROOT, "node_modules/.bin/tsc");

const PACKAGE_DIRS = ["node", "prisma", "drizzle"];
const RELATIVE_LINK_RE = /\]\(\.{1,2}\//;

/**
 * Extracts fenced `ts` blocks from a Markdown file.
 * @param {string} markdown
 * @returns {Array<{ index: number; line: number; code: string }>}
 */
function extractTsSnippets(markdown) {
  const lines = markdown.split(/\r?\n/);
  const snippets = [];
  let inFence = false;
  let startLine = 0;
  let buffer = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!inFence) {
      if (/^```ts(?:\s|$)/.test(line.trim())) {
        inFence = true;
        startLine = i + 2;
        buffer = [];
      }
    } else if (/^```\s*$/.test(line.trim())) {
      snippets.push({
        index: snippets.length + 1,
        line: startLine,
        code: buffer.join("\n"),
      });
      inFence = false;
      buffer = [];
    } else {
      buffer.push(line);
    }
  }

  if (inFence) {
    throw new Error(`Unclosed \`\`\`ts fence starting at line ${startLine}`);
  }

  return snippets;
}

/**
 * Rewrites Drizzle 1.x `.comment()` README snippets from user-facing `"drizzle-orm"` imports
 * to the workspace's `"drizzle-orm-v1"` alias so published READMEs stay copy-pasteable while
 * CI type-checks them against Drizzle 1.x.
 * @param {string} pkg
 * @param {string} code
 * @returns {string}
 */
function prepareSnippetCode(pkg, code) {
  if (pkg === "drizzle" && (code.includes("auditComment") || code.includes(".comment("))) {
    return code.replaceAll(
      /(from\s+["'])drizzle-orm(\/[^"']*)?(["'])/g,
      (_match, prefix, subpath = "", quote) => `${prefix}drizzle-orm-v1${subpath}${quote}`,
    );
  }
  return code;
}

/**
 * Writes a minimal Prisma 7 generated client declaration into the scratch directory so
 * `packages/prisma/README.md` can show idiomatic `./generated/prisma/client.js` usage while
 * verifying `auditstream()` against `@prisma/sqlcommenter` and `auditTransaction()` against
 * `@auditstream/prisma`.
 * @param {string} scratchDir
 */
function writePrismaClientStub(scratchDir) {
  const generatedDir = join(scratchDir, "generated", "prisma");
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    join(generatedDir, "client.d.ts"),
    [
      'import type { PrismaPg } from "@prisma/adapter-pg";',
      'import type { SqlCommenterPlugin } from "@prisma/sqlcommenter";',
      "",
      "export interface PrismaTxClient {",
      "  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;",
      "  invoice: {",
      "    update(args: { where: { id: number }; data: { status: string } }): Promise<unknown>;",
      "  };",
      "}",
      "",
      "export declare class PrismaClient {",
      "  constructor(options?: {",
      "    adapter?: PrismaPg;",
      "    comments?: SqlCommenterPlugin[];",
      "  });",
      '  invoice: PrismaTxClient["invoice"];',
      "  $transaction<T>(",
      "    fn: (tx: PrismaTxClient) => Promise<T>,",
      "    options?: { maxWait?: number; timeout?: number },",
      "  ): Promise<T>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Builds TypeScript `paths` mapping all workspace packages to their built `.d.mts` outputs.
 * @param {string} scratchDir
 */
function buildWorkspacePaths(scratchDir) {
  const pkgRoot = (name) => resolve(ROOT, "packages", name, "dist");
  void scratchDir;
  return {
    "@auditstream/node": [join(pkgRoot("node"), "index.d.mts")],
    "@auditstream/node/express": [join(pkgRoot("node"), "express.d.mts")],
    "@auditstream/node/hono": [join(pkgRoot("node"), "hono.d.mts")],
    "@auditstream/node/next": [join(pkgRoot("node"), "next.d.mts")],
    "@auditstream/prisma": [join(pkgRoot("prisma"), "index.d.mts")],
    "@auditstream/drizzle": [join(pkgRoot("drizzle"), "index.d.mts")],
    "@auditstream/drizzle/pg": [join(pkgRoot("drizzle"), "pg.d.mts")],
    "@auditstream/drizzle/neon-http": [join(pkgRoot("drizzle"), "neon-http.d.mts")],
    "@auditstream/drizzle/postgres-js": [join(pkgRoot("drizzle"), "postgres-js.d.mts")],
  };
}

for (const pkg of PACKAGE_DIRS) {
  const distIndex = resolve(ROOT, "packages", pkg, "dist/index.d.mts");
  if (!existsSync(distIndex)) {
    console.error(`Missing built declarations at ${distIndex}. Run \`pnpm build\` first.`);
    process.exit(1);
  }
}

let totalSnippets = 0;

for (const pkg of PACKAGE_DIRS) {
  const pkgDir = resolve(ROOT, "packages", pkg);
  const readmePath = join(pkgDir, "README.md");
  if (!existsSync(readmePath)) {
    console.error(`Missing ${readmePath}`);
    process.exit(1);
  }

  const markdown = readFileSync(readmePath, "utf8");
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (RELATIVE_LINK_RE.test(lines[i] ?? "")) {
      console.error(`Relative link found in packages/${pkg}/README.md:${i + 1}: ${lines[i]}`);
      process.exit(1);
    }
  }

  const snippets = extractTsSnippets(markdown);
  if (snippets.length === 0) {
    console.error(`No \`\`\`ts snippets found in packages/${pkg}/README.md`);
    process.exit(1);
  }

  const scratchDir = join(pkgDir, ".readme-snippet-check");
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });

  try {
    if (pkg === "prisma") {
      writePrismaClientStub(scratchDir);
    }

    const files = [];
    for (const snippet of snippets) {
      const fileName = `snippet_${String(snippet.index).padStart(2, "0")}_line_${snippet.line}.ts`;
      const filePath = join(scratchDir, fileName);
      // Ensure every snippet is treated as an isolated ES module (supports top-level await).
      const content = `${prepareSnippetCode(pkg, snippet.code)}\nexport {};\n`;
      writeFileSync(filePath, content, "utf8");
      files.push(filePath);
    }

    const tsconfigPath = join(scratchDir, "tsconfig.json");
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            lib: ["ES2023"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            verbatimModuleSyntax: true,
            skipLibCheck: true,
            noEmit: true,
            paths: buildWorkspacePaths(scratchDir),
          },
          files,
        },
        null,
        2,
      ),
      "utf8",
    );

    execFileSync(TSC_BIN, ["-p", tsconfigPath], { stdio: "inherit" });
    totalSnippets += snippets.length;
    console.log(`✓ packages/${pkg}/README.md (${snippets.length} ts snippets type-checked)`);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// Verify root README exists and mentions all three packages.
const rootReadme = readFileSync(resolve(ROOT, "README.md"), "utf8");
for (const name of ["@auditstream/node", "@auditstream/prisma", "@auditstream/drizzle"]) {
  if (!rootReadme.includes(name)) {
    console.error(`Root README.md does not mention ${name}`);
    process.exit(1);
  }
}

// Sanity check that no scratch directory was left behind.
for (const pkg of readdirSync(resolve(ROOT, "packages"))) {
  const leftover = resolve(ROOT, "packages", pkg, ".readme-snippet-check");
  if (existsSync(leftover)) {
    rmSync(leftover, { recursive: true, force: true });
  }
}

console.log(`All ${totalSnippets} README TypeScript snippets passed type-checking.`);
