import assert from "node:assert/strict";
import { AuditstreamError, audit } from "../dist/index.mjs";

class Semaphore {
  constructor(permits) {
    this.available = permits;
    this.queue = [];
  }

  async run(fn) {
    if (this.available === 0) {
      await new Promise((resolvePermit) => {
        this.queue.push(resolvePermit);
      });
    } else {
      this.available -= 1;
    }

    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next !== undefined) {
        next();
      } else {
        this.available += 1;
      }
    }
  }
}

function yieldTick() {
  if (typeof setImmediate === "function") {
    return new Promise((resolve) => setImmediate(resolve));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

assert.equal(audit.current(), undefined, "outside any scope, audit.current() must be undefined");

// 1. Lazy thenable returned unawaited must still observe the active actor.
const lazyResult = await audit.as({ type: "user", id: "usr_smoke_lazy" }, () => ({
  // biome-ignore lint/suspicious/noThenProperty: intentional lazy PromiseLike thenable (Drizzle/Prisma query builder check)
  then(onfulfilled, onrejected) {
    return Promise.resolve(audit.current()).then(onfulfilled, onrejected);
  },
}));
assert.equal(lazyResult?.actor.id, "usr_smoke_lazy");

// 2. Invalid actor must throw AuditstreamError before invoking callback.
let called = false;
await assert.rejects(
  () =>
    audit.as({ type: "unknown", id: "x" }, () => {
      called = true;
    }),
  (err) => err instanceof AuditstreamError && err.code === "INVALID_ACTOR",
);
assert.equal(called, false);

// 3. 40 concurrent scopes across timers, yieldTick and a 5-slot semaphore: zero wrong actors.
const semaphore = new Semaphore(5);
const total = 40;
const observed = await Promise.all(
  Array.from({ length: total }, (_, index) => {
    const id = `usr_smoke_${index}`;
    return audit.as(
      { type: "user", id, tenant: `org_${index % 4}` },
      async () => {
        assert.equal(audit.current()?.actor.id, id);
        await new Promise((resolve) => setTimeout(resolve, (index * 5) % 17));
        assert.equal(audit.current()?.actor.id, id);
        await yieldTick();
        assert.equal(audit.current()?.actor.id, id);
        return await semaphore.run(async () => {
          assert.equal(audit.current()?.actor.id, id);
          await new Promise((resolve) => setTimeout(resolve, (index * 3) % 9));
          assert.equal(audit.current()?.actor.id, id);
          return audit.current()?.actor.id;
        });
      },
      { context: { requestId: `smoke_req_${index}`, source: "smoke" } },
    );
  }),
);

for (let i = 0; i < total; i += 1) {
  assert.equal(observed[i], `usr_smoke_${i}`);
}
assert.equal(audit.current(), undefined);
