// Cloudflare Workers smoke test, bundled from packages/node/dist and run inside workerd by
// scripts/smoke-workers.mjs. Under the `nodejs_als` flag only `node:async_hooks` exists
// (no `node:assert`, `Buffer` or `process`), so this file checks results by hand.
// biome-ignore assist/source/organizeImports: als-guard must evaluate before @auditstream/node constructs AsyncLocalStorage
import { getAlsTrapCounts } from "./als-guard.mjs";
import {
  AuditstreamError,
  audit,
  decodeScope,
  isTagged,
  parseExportRecord,
} from "@auditstream/node";
import { auditstream } from "@auditstream/node/hono";
import { wrapNeonHttp } from "@auditstream/node/neon-http";
import { auditAction, withAudit } from "@auditstream/node/next";
import { wrapPgPool } from "@auditstream/node/pg";
import { wrapPostgresJs } from "@auditstream/node/postgres-js";
import { Hono } from "hono";

const TOTAL_REQUESTS = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const actorId = () => audit.current()?.actor.id ?? null;

function createChecker() {
  const failures = [];
  const check = (label, actual, expected) => {
    if (actual !== expected) {
      failures.push(
        `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  };
  return { failures, check };
}

// Stateless drivers shared at module scope across concurrent env.SELF.fetch() requests.
const pgPool = wrapPgPool({
  on() {},
  async query(config, values) {
    const isObj = typeof config === "object" && config !== null;
    const text = isObj ? config.text : config;
    const bound = isObj ? config.values : values;
    const n = Number(bound?.[0]);
    await sleep(Number.isFinite(n) ? (n * 2 + 1) % 5 : 2);
    return { rows: [{ text, values: bound, name: isObj ? config.name : undefined }], rowCount: 1 };
  },
});

const neonSql = wrapNeonHttp(
  Object.assign(async (text, params) => ({ text, params }), {
    query: (text, params) => ({ text, params }),
    transaction: async (queries) => queries,
  }),
);

let contextCalls = 0;
const app = new Hono();
app.use(
  "*",
  auditstream({
    actor: (c) => {
      const id = c.req.header("x-actor-id");
      return id === undefined ? undefined : { type: "user", id, tenant: "org_workers" };
    },
    context: (c) => {
      contextCalls += 1;
      const requestId = c.req.header("x-request-id");
      return requestId ? { requestId, source: "workers-smoke" } : { source: "workers-smoke" };
    },
  }),
);

app.get("/invoices/:id", async (c) => {
  const idParam = c.req.param("id");
  const n = Number(idParam);
  const seen = [actorId()];
  await sleep(Number.isFinite(n) ? (n * 3) % 7 : 3);
  seen.push(actorId());

  const { rows } = await pgPool.query({
    text: "SELECT * FROM invoice WHERE id = $1",
    values: [idParam],
    name: "invoice_by_id",
  });
  const neonBatch = await neonSql.transaction([neonSql.query("SELECT id FROM invoice", [idParam])]);
  seen.push(actorId());

  const nestedActor = seen[0]
    ? { type: "ai_agent", id: `agent_${seen[0]}`, onBehalfOf: { type: "user", id: seen[0] } }
    : { type: "service", id: "svc_anon" };
  const nested = await audit.as(nestedActor, async () => {
    await sleep(1);
    const res = await pgPool.query({
      text: "UPDATE invoice SET status = $1",
      values: ["sent"],
      name: "update_invoice",
    });
    const d = decodeScope(res.rows[0].text);
    return {
      current: actorId(),
      source: d.actorSource,
      actor: d.actor,
      name: res.rows[0].name ?? null,
    };
  });
  seen.push(actorId());

  const row = rows[0];
  const tag = decodeScope(row.text);
  const neon = decodeScope(neonBatch[0].text);
  return c.json({
    seen,
    tag: {
      source: tag.actorSource,
      tagged: isTagged(row.text),
      actor: tag.actor,
      context: tag.context,
      values: row.values,
      name: row.name ?? null,
    },
    neon: { source: neon.actorSource, actor: neon.actor },
    nested,
  });
});

// Bounded 5-slot queuing pg.Pool (no node:events) run inside test()'s IoContext to exercise
// decidedPoolConfigs, pool.connect() (promise & callback -> AsyncLocalStorage.snapshot()),
// name stripping, and releaser-context isolation without crossing Worker request IoContexts.
function createQueuingPgPool(maxClients) {
  const listeners = [];
  const idle = Array.from({ length: maxClients }, (_, idx) => ({
    id: idx,
    connected: false,
    query(config, values) {
      const isObj = typeof config === "object" && config !== null;
      const text = isObj ? config.text : config;
      return Promise.resolve({
        rows: [
          {
            text,
            values: isObj ? config.values : values,
            name: isObj ? config.name : undefined,
            ambientActor: actorId(),
          },
        ],
      });
    },
  }));
  const waiters = [];
  let queuedDispatches = 0;
  const acquire = (cb) => {
    const client = idle.shift();
    if (client === undefined) {
      waiters.push(cb);
      return;
    }
    if (!client.connected) {
      client.connected = true;
      for (const fn of listeners) fn(client);
    }
    const release = () => {
      const next = waiters.shift();
      // Intentionally resume waiter synchronously inside releaser's active ALS scope.
      if (next !== undefined) {
        queuedDispatches += 1;
        next(null, client, release);
      } else idle.push(client);
    };
    cb(null, client, release);
  };
  const pool = wrapPgPool({
    on(event, fn) {
      if (event === "connect") listeners.push(fn);
    },
    connect(cb) {
      if (typeof cb === "function") {
        acquire(cb);
        return undefined;
      }
      return new Promise((resolve) =>
        acquire((_e, client, release) => {
          client.release = release;
          resolve(client);
        }),
      );
    },
    query(config, values) {
      return new Promise((resolve, reject) =>
        acquire((_e, client, release) =>
          Promise.resolve(client.query(config, values)).then(
            async (res) => {
              await sleep(1);
              release();
              resolve(res);
            },
            (err) => {
              release();
              reject(err);
            },
          ),
        ),
      );
    },
  });
  return { pool, stats: () => ({ queuedDispatches }) };
}

async function runQueuingPoolChecks(check) {
  const { pool, stats } = createQueuingPgPool(5);
  const runScoped = (i) =>
    audit.as({ type: "user", id: `usr_pool_${i}` }, async () => {
      const id = `usr_pool_${i}`;
      const qRes = await pool.query({ text: "SELECT $1", values: [i], name: `s_${i}` });
      check(`pool.query ${i} actor`, decodeScope(qRes.rows[0].text).actor?.id, id);
      check(`pool.query ${i} name`, qRes.rows[0].name, undefined);

      const pClient = await pool.connect();
      try {
        const pRes = await pClient.query({ text: "SELECT 1", name: `p_${i}` });
        check(`pool.connect() ${i} tag`, decodeScope(pRes.rows[0].text).actor?.id, id);
        check(`pool.connect() ${i} name`, pRes.rows[0].name, undefined);
      } finally {
        pClient.release();
      }

      const cb = await new Promise((resolve, reject) =>
        pool.connect((err, client, release) => {
          if (err) return reject(err);
          const insideCb = actorId();
          Promise.resolve(client.query({ text: "SELECT 2", name: `cb_${i}` })).then(
            async (res) => {
              await sleep(1);
              const out = {
                insideCb,
                tag: decodeScope(res.rows[0].text).actor?.id,
                name: res.rows[0].name,
              };
              release();
              resolve(out);
            },
            (qErr) => {
              release();
              reject(qErr);
            },
          );
        }),
      );
      check(`pool.connect(cb) ${i} ALS`, cb.insideCb, id);
      check(`pool.connect(cb) ${i} tag`, cb.tag, id);
      check(`pool.connect(cb) ${i} name`, cb.name, undefined);
    });

  // Start all 40 scoped requests first so the 5-slot pool is saturated before queuing `unscoped`;
  // this guarantees `unscoped` resumes inside a scoped releaser's ALS context (`decidedPoolConfigs`).
  const scoped = Array.from({ length: TOTAL_REQUESTS }, (_, i) => runScoped(i));
  const unscoped = (async () => {
    const res = await pool.query({ text: "SELECT 0", name: "keep_name" });
    check(
      "pool.query unscoped resumed inside scoped releaser",
      typeof res.rows[0].ambientActor === "string" &&
        res.rows[0].ambientActor.startsWith("usr_pool_"),
      true,
    );
    check("pool.query unscoped untagged", isTagged(res.rows[0].text), false);
    check("pool.query unscoped name", res.rows[0].name, "keep_name");
  })();

  await Promise.all([...scoped, unscoped]);
  check(
    "queuing pool exercised releaser handoffs",
    stats().queuedDispatches >= TOTAL_REQUESTS,
    true,
  );
}

async function runAdditionalApiChecks(check) {
  const mkTx = () => ({ unsafe: (q, p, opts) => ({ q, p, opts }), savepoint: (fn) => fn(mkTx()) });
  const pjs = wrapPostgresJs({ ...mkTx(), begin: (fn) => fn(mkTx()) });
  const pjsRes = await audit.as({ type: "user", id: "usr_pjs" }, () =>
    pjs.begin((tx) =>
      tx.savepoint((sp) => sp.unsafe("UPDATE t SET v = $1", [1], { prepare: true })),
    ),
  );
  check("postgres-js savepoint tag", decodeScope(pjsRes.q).actor?.id, "usr_pjs");
  check("postgres-js prepare false", pjsRes.opts?.prepare, false);

  const route = withAudit(async () => new Response(actorId() ?? "none"), {
    actor: () => ({ type: "user", id: "usr_next" }),
  });
  check(
    "next withAudit",
    await (await route(new Request("https://smoke.test/api"))).text(),
    "usr_next",
  );
  const action = auditAction(async (n) => `${actorId()}:${n}`, {
    actor: () => ({ type: "user", id: "usr_action" }),
  });
  check("next auditAction", await action(7), "usr_action:7");

  let loggedSql = "";
  await audit.as({ type: "user", id: "usr_log" }, () =>
    audit.log(
      async (sql, values) => {
        loggedSql = (await pgPool.query(sql, values)).rows[0].text;
      },
      { action: "invoice.exported", target: { id: 1 }, data: { format: "csv" } },
    ),
  );
  check("audit.log tag", decodeScope(loggedSql).actor?.id, "usr_log");

  const row = {
    id: "9007199254740993",
    event_id: "01936b8e-0000-7000-8000-000000000001",
    occurred_at: "2026-11-27T12:00:00.123456Z",
    xact_id: "4200000001",
    source: "app",
    schema_name: null,
    table_name: null,
    table_oid: null,
    op: "invoice.exported",
    record_id: { id: 1 },
    before: null,
    after: { amount: 0 },
    changed: null,
    actor: { type: "user", id: "usr_log" },
    context: null,
    actor_source: "comment",
    db_user: "app_user",
    schema_version: 1,
  };
  const page1 = await audit.query(() => ({ rows: [row, { ...row, id: "9007199254740992" }] }), {
    since: "2026-11-01T00:00:00Z",
    limit: 1,
  });
  check("audit.query hasMore", page1.hasMore, true);
  check("audit.query nextCursor", page1.nextCursor !== null, true);
  const page2 = await audit.query(() => ({ rows: [] }), {
    since: "2026-11-01T00:00:00Z",
    cursor: page1.nextCursor ?? "",
  });
  check("audit.query cursor round-trip", page2.entries.length, 0);

  const hist = await audit.history(() => ({ rows: [row] }), {
    table: "invoice",
    recordId: { id: 1 },
  });
  check("audit.history id", hist[0]?.id, "9007199254740993");

  const parsed = parseExportRecord(
    JSON.stringify(row).replace('"amount":0', '"amount":9007199254740993'),
  );
  check("parseExportRecord numeric precision", parsed.after?.amount, "9007199254740993");

  const lazy = await audit.as({ type: "user", id: "usr_lazy" }, () => ({
    // biome-ignore lint/suspicious/noThenProperty: intentional lazy PromiseLike thenable check
    then: (ok, fail) => Promise.resolve(actorId()).then(ok, fail),
  }));
  check("lazy thenable actor", lazy, "usr_lazy");

  let errCode = null;
  try {
    await audit.as({ type: "invalid", id: "x" }, () => {});
  } catch (err) {
    errCode = err instanceof AuditstreamError ? err.code : "OTHER";
  }
  check("invalid actor error", errCode, "INVALID_ACTOR");

  let thrownMsg = null;
  try {
    await audit.as({ type: "user", id: "usr_boom" }, async () => {
      throw new Error("boom");
    });
  } catch (err) {
    thrownMsg = err instanceof Error ? err.message : null;
  }
  check("scope throw propagated", thrownMsg, "boom");
  check("scope cleared after throw", actorId(), null);
}

async function request(env, id, headers) {
  const response = await env.SELF.fetch(`https://smoke.test/invoices/${id}`, { headers });
  if (response.status !== 200) {
    throw new Error(`GET /invoices/${id} returned ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

export default {
  fetch: app.fetch,

  async test(_controller, env) {
    const { failures, check } = createChecker();
    const expectGlobals = env.EXPECT_NODE_GLOBALS === "true";
    check("Buffer presence", typeof globalThis.Buffer !== "undefined", expectGlobals);
    check("process presence", typeof globalThis.process !== "undefined", expectGlobals);

    const [anonymous, noReqId, ...results] = await Promise.all([
      request(env, "anon", {}),
      request(env, "noreqid", { "x-actor-id": "usr_no_reqid" }),
      ...Array.from({ length: TOTAL_REQUESTS }, (_, i) =>
        request(env, i, { "x-actor-id": `usr_workers_${i}`, "x-request-id": `req_${i}` }),
      ),
    ]);

    for (const [i, r] of results.entries()) {
      const actor = `usr_workers_${i}`;
      check(`req ${i} seen.length`, r.seen.length, 4);
      for (const [s, id] of r.seen.entries()) check(`req ${i} step ${s}`, id, actor);
      check(`req ${i} actorSource`, r.tag.source, "comment");
      check(`req ${i} tagged`, r.tag.tagged, true);
      check(`req ${i} actor.type`, r.tag.actor?.type, "user");
      check(`req ${i} actor.id`, r.tag.actor?.id, actor);
      check(`req ${i} tenant`, r.tag.actor?.tenant, "org_workers");
      check(`req ${i} requestId`, r.tag.context?.requestId, `req_${i}`);
      check(`req ${i} source`, r.tag.context?.source, "workers-smoke");
      check(`req ${i} values[0]`, r.tag.values?.[0], String(i));
      check(`req ${i} name`, r.tag.name, null);
      check(`req ${i} neon source`, r.neon.source, "comment");
      check(`req ${i} neon actor`, r.neon.actor?.id, actor);
      check(`req ${i} nested current`, r.nested.current, `agent_${actor}`);
      check(`req ${i} nested source`, r.nested.source, "comment");
      check(`req ${i} nested id`, r.nested.actor?.id, `agent_${actor}`);
      check(`req ${i} nested onBehalfOf`, r.nested.actor?.onBehalfOf?.id, actor);
      check(`req ${i} nested name`, r.nested.name, null);
    }

    check("noReqId actor", noReqId.tag.actor?.id, "usr_no_reqid");
    check("noReqId requestId omitted", noReqId.tag.context?.requestId, undefined);
    check("noReqId source", noReqId.tag.context?.source, "workers-smoke");

    check("anon seen.length", anonymous.seen.length, 4);
    for (const [s, id] of anonymous.seen.entries()) check(`anon step ${s}`, id, null);
    check("anon actorSource", anonymous.tag.source, null);
    check("anon tagged", anonymous.tag.tagged, false);
    check("anon actor", anonymous.tag.actor, null);
    check("anon context", anonymous.tag.context, null);
    check("anon name kept", anonymous.tag.name, "invoice_by_id");
    check("anon neon source", anonymous.neon.source, null);
    check("anon nested current", anonymous.nested.current, "svc_anon");
    check("anon nested source", anonymous.nested.source, "comment");
    check("anon nested actor", anonymous.nested.actor?.id, "svc_anon");
    check("anon nested name", anonymous.nested.name, null);
    check("context resolver skipped for anon", contextCalls, TOTAL_REQUESTS + 1);

    await runQueuingPoolChecks(check);
    await runAdditionalApiChecks(check);

    const { enterWithCalls, disableCalls } = getAlsTrapCounts();
    check("audit.current() outside requests", actorId(), null);
    check("AsyncLocalStorage.enterWith() calls", enterWithCalls, 0);
    check("AsyncLocalStorage.disable() calls", disableCalls, 0);

    if (failures.length > 0) {
      throw new Error(`${failures.length} smoke check(s) failed:\n  ${failures.join("\n  ")}`);
    }
    console.log(
      `ok: ${TOTAL_REQUESTS} concurrent fetch + queuing pool checks, 0 wrong actors, 0 enterWith()/disable() calls`,
    );
  },
};
