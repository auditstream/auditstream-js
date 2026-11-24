import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditstreamError, audit, decodeScope, encodeScope, isTagged } from "@auditstream/node";
import { eq as eqV1 } from "drizzle-orm-v1";
import { drizzle as drizzleV1 } from "drizzle-orm-v1/node-postgres";
import { integer as integerV1, pgTable as pgTableV1, text as textV1 } from "drizzle-orm-v1/pg-core";
import { describe, expect, it } from "vitest";
import { auditComment } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(__dirname, "..");

const invoiceV1 = pgTableV1("invoice", {
  id: integerV1("id").primaryKey(),
  status: textV1("status"),
});

describe("auditComment()", () => {
  it("returns {} outside an audit.as() scope when extra is omitted", () => {
    expect(auditComment()).toEqual({});
  });

  it("returns a copy of extra outside an audit.as() scope", () => {
    const extra = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
    const result = auditComment(extra);
    expect(result).toEqual(extra);
    expect(result).not.toBe(extra);
  });

  it("returns auditstream encoded scope inside audit.as(), merged with extra keys", async () => {
    const actor = { type: "user" as const, id: "usr_42" };
    const expectedEncoded = encodeScope({ actor });

    await audit.as(actor, () => {
      expect(auditComment()).toEqual({ auditstream: expectedEncoded });
      expect(
        auditComment({
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          route: "invoices.update",
        }),
      ).toEqual({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        route: "invoices.update",
        auditstream: expectedEncoded,
      });
    });
  });

  it("throws when extra contains an auditstream key (inside or outside a scope)", async () => {
    expect(() => auditComment({ auditstream: "spoofed" })).toThrow(AuditstreamError);
    expect(() => auditComment({ auditstream: undefined })).toThrow(AuditstreamError);

    await audit.as({ type: "user", id: "usr_42" }, () => {
      expect(() => auditComment({ auditstream: "spoofed" })).toThrow(AuditstreamError);
    });
  });

  it("produces one trailing comment recognized by isTagged() and decodeScope() across Drizzle 1.x builders", async () => {
    const db = drizzleV1.mock();
    const actor = { type: "user" as const, id: "rc_comment" };

    // Outside scope with no extra -> no comment appended.
    const unscopedSql = db.select().from(invoiceV1).comment(auditComment()).toSQL().sql;
    expect(isTagged(unscopedSql)).toBe(false);
    expect(unscopedSql).not.toContain("/*");

    await audit.as(actor, () => {
      const queries = [
        db.select().from(invoiceV1).comment(auditComment()).toSQL().sql,
        db.insert(invoiceV1).values({ id: 1, status: "open" }).comment(auditComment()).toSQL().sql,
        db
          .update(invoiceV1)
          .set({ status: "paid" })
          .where(eqV1(invoiceV1.id, 1))
          .comment(
            auditComment({
              traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            }),
          )
          .toSQL().sql,
        db.delete(invoiceV1).where(eqV1(invoiceV1.id, 1)).comment(auditComment()).toSQL().sql,
      ];

      for (const querySql of queries) {
        expect(isTagged(querySql)).toBe(true);
        // Exactly one trailing block comment at the end of the SQL statement.
        expect(querySql.match(/\/\*/g)).toHaveLength(1);
        const decoded = decodeScope(querySql);
        expect(decoded.actorSource).toBe("comment");
        expect(decoded.actor).toEqual(actor);
      }
    });
  });

  it("compiles public package types cleanly with only Drizzle 0.45 installed (no drizzle-orm import)", () => {
    const dtsPath = resolve(PACKAGE_DIR, "dist/index.d.mts");
    const dtsContent = readFileSync(dtsPath, "utf8");
    expect(dtsContent).not.toMatch(/from\s+["']drizzle-orm/);

    const scratchDir = mkdtempSync(join(tmpdir(), "auditstream-drizzle-types-"));
    try {
      // Simulate a consumer project that has only Drizzle 0.45 installed and imports
      // the built @auditstream/drizzle public entry point declarations.
      const checkFile = join(scratchDir, "check.ts");
      const tsconfigPath = join(scratchDir, "tsconfig.json");
      const dtsImport = resolve(PACKAGE_DIR, "dist/index.mjs");
      const drizzle045Import = resolve(PACKAGE_DIR, "node_modules/drizzle-orm/index.d.ts");

      writeFileSync(
        checkFile,
        [
          `import type { SQL } from ${JSON.stringify(drizzle045Import)};`,
          `import { auditComment, type SqlCommenterValues, PACKAGE_NAME } from ${JSON.stringify(dtsImport)};`,
          "const c1: SqlCommenterValues = auditComment();",
          'const c2: SqlCommenterValues = auditComment({ traceparent: "00-abc", retry: 1, ok: true });',
          "const pkg: '@auditstream/drizzle' = PACKAGE_NAME;",
          "export type Verified = [typeof c1, typeof c2, typeof pkg, SQL];",
          "",
        ].join("\n"),
      );

      writeFileSync(
        tsconfigPath,
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2023",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              types: [],
            },
            files: [checkFile],
          },
          null,
          2,
        ),
      );

      const tscBin = resolve(PACKAGE_DIR, "node_modules/.bin/tsc");
      execFileSync(tscBin, ["-p", tsconfigPath], { stdio: "pipe" });
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
