import assert from "node:assert/strict";
import { AuditstreamError, audit, LOG_EVENT_SQL } from "../dist/index.mjs";

const calls = [];
const result = await audit.as(
  { type: "user", id: "usr_smoke_log" },
  () =>
    audit.log(
      async (text, values) => {
        calls.push({ text, values, actorId: audit.current()?.actor.id });
        return { rowCount: 1 };
      },
      {
        action: "invoice.sent",
        target: { invoiceId: 7 },
        data: { channel: "email" },
      },
    ),
  { context: { requestId: "req_smoke_log" } },
);

assert.equal(result, undefined);
assert.equal(calls.length, 1);
assert.equal(calls[0]?.text, LOG_EVENT_SQL);
assert.deepEqual(calls[0]?.values, ["invoice.sent", '{"invoiceId":7}', '{"channel":"email"}']);
assert.equal(calls[0]?.actorId, "usr_smoke_log");

let invoked = false;
await assert.rejects(
  () =>
    audit.log(
      () => {
        invoked = true;
      },
      { action: "INSERT" },
    ),
  (err) => err instanceof AuditstreamError && err.code === "INVALID_EVENT",
);
assert.equal(invoked, false);
