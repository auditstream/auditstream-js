import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  type AuditContext,
  AuditstreamError,
  decodeScope,
  encodeScope,
  tagSql,
} from "../src/index.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MANIFEST_PATH = resolve(REPO_ROOT, "conformance.json");
const CONFORMANCE_DIR = resolve(REPO_ROOT, "conformance");

interface ConformanceManifest {
  specVersion: string;
  repository: string;
  tag: string;
  asset: string;
  tarballSha256: string;
  files: Record<string, string>;
}

interface EncodeCase {
  name: string;
  description: string;
  input: { actor: Record<string, unknown> };
  expected:
    | { canonical_json: string; encoded: string; comment: string }
    | { error: "invalid_actor" | "invalid_context" | "payload_too_large" };
}

interface DecodeCase {
  name: string;
  description: string;
  input: { sql: string };
  expected: {
    actor: Record<string, unknown> | null;
    context: Record<string, unknown> | null;
    actor_source: "comment" | "invalid" | null;
  };
}

interface PrecedenceCase {
  name: string;
  description: string;
}

function listFilesRecursive(dir: string, base: string = dir): string[] {
  const results: string[] = [];
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

function splitActorAndContext(raw: Record<string, unknown>): {
  actor: Actor;
  context?: AuditContext;
} {
  const { context, ...actorRest } = raw;
  return context === undefined
    ? { actor: actorRest as unknown as Actor }
    : { actor: actorRest as unknown as Actor, context: context as AuditContext };
}

const SKIPPED_PRECEDENCE_REASON =
  "precedence across set_config, comment, and JWT is resolved inside PostgreSQL triggers; covered by engine integration suite";

describe("Spec 0.1.1 conformance fixtures", () => {
  it("conformance directory is non-empty and matches every SHA-256 pinned in conformance.json", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    expect(existsSync(CONFORMANCE_DIR)).toBe(true);

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ConformanceManifest;
    expect(manifest.specVersion).toBe("0.1.1");
    expect(manifest.tag).toBe("spec-v0.1.1");
    expect(manifest.tarballSha256).toMatch(/^[a-f0-9]{64}$/);

    const actualFiles = listFilesRecursive(CONFORMANCE_DIR);
    const expectedFiles = Object.keys(manifest.files).sort();
    expect(actualFiles.length).toBeGreaterThan(0);
    expect(actualFiles).toEqual(expectedFiles);

    for (const relPath of expectedFiles) {
      const digest = createHash("sha256")
        .update(readFileSync(join(CONFORMANCE_DIR, relPath)))
        .digest("hex");
      expect(digest, `hash mismatch for conformance/${relPath}`).toBe(manifest.files[relPath]);
    }
  });

  it("passes every transport/encode.json case (with globalThis.Buffer removed)", () => {
    const fixture = JSON.parse(
      readFileSync(join(CONFORMANCE_DIR, "transport/encode.json"), "utf8"),
    ) as { spec: string; cases: EncodeCase[] };
    expect(fixture.spec).toBe("0.1.0");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);

    const originalBuffer = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, "Buffer");
    try {
      for (const testCase of fixture.cases) {
        const scope = splitActorAndContext(testCase.input.actor);
        if ("encoded" in testCase.expected) {
          const encoded = encodeScope(scope);
          expect(encoded, testCase.name).toBe(testCase.expected.encoded);
          expect(tagSql("SELECT 1", scope), testCase.name).toBe(
            `SELECT 1 ${testCase.expected.comment}`,
          );
        } else {
          expect(() => encodeScope(scope), testCase.name).toThrowError(AuditstreamError);
        }
      }
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });

  it("passes every transport/decode.json case (with globalThis.Buffer removed)", () => {
    const fixture = JSON.parse(
      readFileSync(join(CONFORMANCE_DIR, "transport/decode.json"), "utf8"),
    ) as { spec: string; cases: DecodeCase[] };
    expect(fixture.spec).toBe("0.1.0");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);

    const originalBuffer = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, "Buffer");
    try {
      for (const testCase of fixture.cases) {
        const decoded = decodeScope(testCase.input.sql);
        expect(decoded.actorSource, testCase.name).toBe(testCase.expected.actor_source);
        expect(decoded.actor, testCase.name).toEqual(testCase.expected.actor);
        expect(decoded.context, testCase.name).toEqual(testCase.expected.context);
      }
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });

  it("records explicit named skips for transport/precedence.json (database-side responsibility)", () => {
    const fixture = JSON.parse(
      readFileSync(join(CONFORMANCE_DIR, "transport/precedence.json"), "utf8"),
    ) as { spec: string; cases: PrecedenceCase[] };
    expect(fixture.spec).toBe("0.1.0");
    expect(fixture.cases.length).toBeGreaterThan(0);

    const skipped = new Map<string, string>();
    for (const testCase of fixture.cases) {
      skipped.set(testCase.name, SKIPPED_PRECEDENCE_REASON);
    }

    expect(skipped.size).toBe(fixture.cases.length);
    for (const testCase of fixture.cases) {
      expect(skipped.get(testCase.name)).toBe(SKIPPED_PRECEDENCE_REASON);
    }
  });
});
