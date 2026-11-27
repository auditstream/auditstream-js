// Cloudflare Workers smoke test, bundled from packages/node/dist and run inside workerd by
// scripts/smoke-workers.mjs. Under the `nodejs_als` flag only `node:async_hooks` exists
// (no `node:assert`, `Buffer` or `process`), so this file checks results by hand.
import { AsyncLocalStorage } from "node:async_hooks";
import { audit, decodeScope } from "@auditstream/node";
import { auditstream } from "@auditstream/node/hono";
import { wrapPgPool } from "@auditstream/node/pg";
import { Hono } from "hono";

const TOTAL_REQUESTS = 40;

// Workers ship enterWith() as a stub that throws; count calls so a swallowed error still fails.
let enterWithCalls = 0;
AsyncLocalStorage.prototype.enterWith = function enterWith() {
  enterWithCalls += 1;
  throw new Error("AsyncLocalStorage.enterWith() is not implemented on Cloudflare Workers");
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const currentActorId = () => audit.current()?.actor.id ?? null;

// In-memory stand-in for a pg.Pool shared by every request: returns the SQL text it received.
const pool = wrapPgPool({
  on() {},
  async query(config, values) {
    const text = typeof config === "string" ? config : config.text;
    await sleep(text.length % 5);
    return { rows: [{ text, values: values ?? config.values }], rowCount: 1 };
  },
});

const app = new Hono();

app.use(
  "*",
  auditstream({
    actor: (c) => {
      const id = c.req.header("x-actor-id");
      return id === undefined ? undefined : { type: "user", id, tenant: "org_workers" };
    },
    context: (c) => ({ requestId: c.req.header("x-request-id") ?? "", source: "workers-smoke" }),
  }),
);

app.get("/invoices/:id", async (c) => {
  // audit.current() at handler entry, after a timer, after a query and after a nested scope.
  const seen = [currentActorId()];
  await sleep(Number(c.req.param("id")) % 7);
  seen.push(currentActorId());
  const { rows } = await pool.query("SELECT * FROM invoice WHERE id = $1", [c.req.param("id")]);
  seen.push(currentActorId());

  const nested = await audit.as({ type: "service", id: `svc_${seen[0]}` }, async () => {
    await sleep(1);
    const result = await pool.query({ text: "UPDATE invoice SET status = $1", values: ["sent"] });
    return { current: currentActorId(), tagged: decodeScope(result.rows[0].text).actor?.id };
  });
  seen.push(currentActorId());

  const tag = decodeScope(rows[0].text);
  return c.json({ seen, tag: { actor: tag.actor?.id ?? null, ...tag.context }, nested });
});

function expectEqual(failures, label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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

  // `workerd test` calls this once; env.SELF dispatches real fetch events back to this Worker.
  async test(_controller, env) {
    const failures = [];
    const [anonymous, ...results] = await Promise.all([
      request(env, "anon", {}),
      ...Array.from({ length: TOTAL_REQUESTS }, (_, i) =>
        request(env, i, { "x-actor-id": `usr_workers_${i}`, "x-request-id": `req_${i}` }),
      ),
    ]);

    for (const [i, result] of results.entries()) {
      const actor = `usr_workers_${i}`;
      for (const [step, id] of result.seen.entries()) {
        expectEqual(failures, `request ${i} step ${step}`, id, actor);
      }
      expectEqual(failures, `request ${i} SQL tag actor`, result.tag.actor, actor);
      expectEqual(failures, `request ${i} SQL tag requestId`, result.tag.requestId, `req_${i}`);
      expectEqual(failures, `request ${i} nested current`, result.nested.current, `svc_${actor}`);
      expectEqual(failures, `request ${i} nested SQL tag`, result.nested.tagged, `svc_${actor}`);
    }
    for (const [step, id] of anonymous.seen.entries()) {
      expectEqual(failures, `anonymous step ${step}`, id, null);
    }
    expectEqual(failures, "anonymous SQL tag actor", anonymous.tag.actor, null);
    expectEqual(failures, "audit.current() outside requests", currentActorId(), null);
    expectEqual(failures, "AsyncLocalStorage.enterWith() calls", enterWithCalls, 0);

    if (failures.length > 0) {
      throw new Error(`${failures.length} smoke check(s) failed:\n  ${failures.join("\n  ")}`);
    }
    console.log(`ok: ${TOTAL_REQUESTS} concurrent requests, 0 wrong actors, 0 enterWith() calls`);
  },
};
