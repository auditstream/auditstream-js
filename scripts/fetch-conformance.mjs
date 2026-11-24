#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const MANIFEST_PATH = resolve(ROOT, "conformance.json");
const CONFORMANCE_DIR = resolve(ROOT, "conformance");

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listFilesRecursive(dir, base = dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, base));
    } else if (entry.isFile()) {
      results.push(relative(base, full).replaceAll("\\", "/"));
    }
  }
  return results.sort();
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing ${MANIFEST_PATH}`);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function verifyCommittedFixtures() {
  const manifest = readManifest();
  if (!existsSync(CONFORMANCE_DIR)) {
    throw new Error(`Missing conformance directory at ${CONFORMANCE_DIR}`);
  }

  const actualFiles = listFilesRecursive(CONFORMANCE_DIR);
  if (actualFiles.length === 0) {
    throw new Error(`Conformance directory ${CONFORMANCE_DIR} is empty`);
  }

  const expectedFiles = Object.keys(manifest.files ?? {}).sort();
  if (expectedFiles.length === 0) {
    throw new Error("conformance.json has no pinned file hashes; run fetch-conformance.mjs first");
  }

  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error(
      `Conformance file list mismatch.\nExpected: ${expectedFiles.join(", ")}\nActual:   ${actualFiles.join(", ")}`,
    );
  }

  for (const relPath of expectedFiles) {
    const actualHash = sha256File(join(CONFORMANCE_DIR, relPath));
    const expectedHash = manifest.files[relPath];
    if (actualHash !== expectedHash) {
      throw new Error(
        `SHA-256 mismatch for conformance/${relPath}: expected ${expectedHash}, got ${actualHash}`,
      );
    }
  }

  console.log(
    `Conformance fixtures verified offline: ${manifest.tag} (${expectedFiles.length} files, tarball sha256 ${manifest.tarballSha256}).`,
  );
}

function fetchAndUnpackFixtures() {
  const manifest = readManifest();
  const tempDir = mkdtempSync(join(tmpdir(), "auditstream-conformance-"));

  try {
    execFileSync(
      "gh",
      [
        "release",
        "download",
        manifest.tag,
        "--repo",
        manifest.repository,
        "--pattern",
        manifest.asset,
        "--dir",
        tempDir,
      ],
      { stdio: "inherit" },
    );

    const tarballPath = join(tempDir, manifest.asset);
    const actualTarballSha256 = sha256File(tarballPath);
    if (actualTarballSha256 !== manifest.tarballSha256) {
      throw new Error(
        `Tarball SHA-256 mismatch for ${manifest.tag}/${manifest.asset}: expected ${manifest.tarballSha256}, got ${actualTarballSha256}`,
      );
    }

    const extractDir = join(tempDir, "unpacked");
    execFileSync("mkdir", ["-p", extractDir]);
    execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir]);

    const sourceConformance = join(extractDir, "spec", "conformance");
    if (!existsSync(sourceConformance)) {
      throw new Error(`Archive ${manifest.asset} does not contain spec/conformance/`);
    }

    rmSync(CONFORMANCE_DIR, { recursive: true, force: true });
    cpSync(sourceConformance, CONFORMANCE_DIR, { recursive: true });

    const files = {};
    for (const relPath of listFilesRecursive(CONFORMANCE_DIR)) {
      files[relPath] = sha256File(join(CONFORMANCE_DIR, relPath));
    }

    const updated = { ...manifest, files };
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    console.log(
      `Fetched and unpacked ${manifest.tag} (${Object.keys(files).length} files) into conformance/ and updated conformance.json.`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  verifyCommittedFixtures();
} else {
  fetchAndUnpackFixtures();
}
