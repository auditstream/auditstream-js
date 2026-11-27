import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { audit, decodeScope, LOG_EVENT_SQL, tagSql } from "../src/index.js";
import { wrapPgPool } from "../src/pg.js";

const README_PATH = resolve(fileURLToPath(new URL("../README.md", import.meta.url)));

function extractSectionSnippet(heading: string): string {
  const readme = readFileSync(README_PATH, "utf8");
  const sectionStart = readme.indexOf(heading);
  if (sectionStart < 0) {
    throw new Error(`Missing section heading ${JSON.stringify(heading)} in README.md`);
  }
  const afterHeading = readme.slice(sectionStart + heading.length);
  const nextHeadingMatch = /\r?\n#{2,3}\s+/.exec(afterHeading);
  const sectionBody =
    nextHeadingMatch === null ? afterHeading : afterHeading.slice(0, nextHeadingMatch.index);
  const match = /```ts\r?\n([\s\S]*?)\r?\n```/.exec(sectionBody);
  if (!match?.[1]) {
    throw new Error(`Missing fenced \`\`\`ts snippet under ${JSON.stringify(heading)}`);
  }
  return match[1];
}

describe("@auditstream/node README snippets", () => {
  it("documents tagSql(sql) in the audit.log() example and records actor user:usr_42 (never NULL)", async () => {
    const snippet = extractSectionSnippet("### Application events (`audit.log`)");
    expect(snippet).toContain('import { audit, tagSql } from "@auditstream/node";');
    expect(snippet).toContain("pool.query(tagSql(sql), values)");

    const recorded: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query(sql: string, values: unknown[]): Promise<{ rowCount: number }> {
        recorded.push({ sql, values });
        return Promise.resolve({ rowCount: 1 });
      },
    };

    await audit.as({ type: "user", id: "usr_42" }, () =>
      audit.log((sql, values) => pool.query(tagSql(sql), values), {
        action: "invoice.exported",
        target: { invoice_id: 42 },
        data: { format: "csv" },
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sql.startsWith(LOG_EVENT_SQL)).toBe(true);
    expect(recorded[0]?.values).toEqual([
      "invoice.exported",
      '{"invoice_id":42}',
      '{"format":"csv"}',
    ]);
    expect(decodeScope(recorded[0]?.sql ?? "")).toEqual({
      actor: { type: "user", id: "usr_42" },
      context: null,
      actorSource: "comment",
    });
  });

  it("documents wrapPgPool from @auditstream/node/pg and tags both DML and audit.log()", async () => {
    const snippet = extractSectionSnippet(
      "### PostgreSQL driver wrappers (`/pg`, `/postgres-js`, `/neon-http`)",
    );
    expect(snippet).toContain('import { wrapPgPool } from "@auditstream/node/pg";');
    expect(snippet).toContain("wrapPgPool(new pg.Pool(");
    expect(snippet).toContain("pool.query(sql, values)");

    const recorded: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = wrapPgPool({
      on(): void {},
      query(
        first: string | { text: string; values?: unknown[] },
        values?: unknown[],
      ): Promise<{ rowCount: number }> {
        if (typeof first === "string") {
          recorded.push({ text: first, values });
        } else {
          recorded.push({ text: first.text, values: first.values });
        }
        return Promise.resolve({ rowCount: 1 });
      },
    });

    await audit.as({ type: "user", id: "usr_42" }, async () => {
      await pool.query("UPDATE invoice SET status = $1 WHERE id = $2", ["paid", 42]);
      await audit.log((sql, values) => pool.query(sql, values), {
        action: "invoice.paid",
        target: { invoice_id: 42 },
      });
    });

    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.text.startsWith("UPDATE invoice SET status = $1 WHERE id = $2")).toBe(true);
    expect(recorded[0]?.values).toEqual(["paid", 42]);
    expect(recorded[1]?.text.startsWith(LOG_EVENT_SQL)).toBe(true);
    expect(recorded[1]?.values).toEqual(["invoice.paid", '{"invoice_id":42}', null]);
    for (const entry of recorded) {
      expect(decodeScope(entry.text)).toEqual({
        actor: { type: "user", id: "usr_42" },
        context: null,
        actorSource: "comment",
      });
    }
  });
});
