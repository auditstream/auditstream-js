import assert from "node:assert/strict";
import {
  AuditstreamError,
  audit,
  decodeScope,
  encodeScope,
  isTagged,
  setConfigValue,
  tagSql,
} from "../dist/index.mjs";

const scope = {
  actor: {
    type: "ai_agent",
    id: "billing-agent",
    onBehalfOf: { type: "user", id: "usr_42" },
    tenant: "org_acme",
  },
  context: {
    requestId: "req_smoke_1",
    source: "smoke",
  },
};

// Verify codec works with Buffer removed (Cloudflare Workers portability check).
const originalBuffer = globalThis.Buffer;
const hadBuffer = "Buffer" in globalThis;
if (hadBuffer) {
  Reflect.deleteProperty(globalThis, "Buffer");
}

try {
  const encoded = encodeScope(scope);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.equal(encoded.includes("="), false);

  const canonical = setConfigValue(scope);
  assert.equal(
    canonical,
    '{"type":"ai_agent","id":"billing-agent","onBehalfOf":{"type":"user","id":"usr_42"},"tenant":"org_acme","context":{"requestId":"req_smoke_1","source":"smoke"}}',
  );

  const tagged = await audit.as(
    scope.actor,
    () => {
      const once = tagSql("UPDATE invoice SET status = $1");
      assert.equal(isTagged(once), true);
      assert.equal(tagSql(once), once, "must never double-tag");
      return once;
    },
    { context: scope.context },
  );

  const decoded = decodeScope(tagged);
  assert.equal(decoded.actorSource, "comment");
  assert.deepEqual(decoded.actor, scope.actor);
  assert.deepEqual(decoded.context, scope.context);

  // Oversized payload must throw AuditstreamError before building SQL text.
  assert.throws(
    () => tagSql("SELECT 1", { actor: { type: "user", id: "x".repeat(500) } }),
    (err) => err instanceof AuditstreamError && err.code === "PAYLOAD_TOO_LARGE",
  );
} finally {
  if (hadBuffer) {
    globalThis.Buffer = originalBuffer;
  }
}
