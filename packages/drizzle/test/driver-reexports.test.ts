import { audit, decodeScope } from "@auditstream/node";
import * as nodeNeonHttp from "@auditstream/node/neon-http";
import * as nodePg from "@auditstream/node/pg";
import * as nodePostgresJs from "@auditstream/node/postgres-js";
import { describe, expect, it } from "vitest";
import * as drizzleNeonHttp from "../src/neon-http.js";
import * as drizzlePg from "../src/pg.js";
import * as drizzlePostgresJs from "../src/postgres-js.js";

describe("@auditstream/drizzle driver wrapper re-exports", () => {
  it("preserves SUBPATH literals and re-exports the canonical @auditstream/node wrappers", async () => {
    expect(drizzlePg.SUBPATH).toBe("@auditstream/drizzle/pg");
    expect(drizzlePostgresJs.SUBPATH).toBe("@auditstream/drizzle/postgres-js");
    expect(drizzleNeonHttp.SUBPATH).toBe("@auditstream/drizzle/neon-http");

    expect(drizzlePg.wrapPgPool).toBe(nodePg.wrapPgPool);
    expect(drizzlePostgresJs.wrapPostgresJs).toBe(nodePostgresJs.wrapPostgresJs);
    expect(drizzleNeonHttp.wrapNeonHttp).toBe(nodeNeonHttp.wrapNeonHttp);

    const pgSeen: string[] = [];
    const pool = drizzlePg.wrapPgPool({
      on: () => undefined,
      query: (cfg: { text: string }) => {
        pgSeen.push(cfg.text);
        return Promise.resolve({ rows: [] });
      },
    });

    const pjsSeen: Array<{ query: string; opts: unknown }> = [];
    const pjs = drizzlePostgresJs.wrapPostgresJs({
      begin: () => Promise.resolve(),
      unsafe: (query: string, _params?: unknown, opts?: unknown) => {
        pjsSeen.push({ query, opts });
        return Promise.resolve([]);
      },
    });

    const neonSeen: string[] = [];
    const neonRaw = Object.assign(
      (text: string) => {
        neonSeen.push(text);
        return Promise.resolve([]);
      },
      {
        query: (text: string) => {
          neonSeen.push(text);
          return Promise.resolve([]);
        },
      },
    );
    const neon = drizzleNeonHttp.wrapNeonHttp(neonRaw);

    await audit.as({ type: "user", id: "usr_reexport" }, async () => {
      await pool.query({ text: "UPDATE invoice SET status = 'paid'" });
      await pjs.unsafe("UPDATE invoice SET status = 'paid'", [], { prepare: true });
      await neon.query("UPDATE invoice SET status = 'paid'");
    });

    expect(decodeScope(pgSeen[0] ?? "")).toEqual({
      actor: { type: "user", id: "usr_reexport" },
      context: null,
      actorSource: "comment",
    });
    expect(decodeScope(pjsSeen[0]?.query ?? "")).toEqual({
      actor: { type: "user", id: "usr_reexport" },
      context: null,
      actorSource: "comment",
    });
    expect(pjsSeen[0]?.opts).toEqual({ prepare: false });
    expect(decodeScope(neonSeen[0] ?? "")).toEqual({
      actor: { type: "user", id: "usr_reexport" },
      context: null,
      actorSource: "comment",
    });
  });
});
