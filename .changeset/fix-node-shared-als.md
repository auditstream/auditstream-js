---
"@auditstream/node": patch
---

Share the internal `AsyncLocalStorage` store via `globalThis[Symbol.for("auditstream.node.scopeStorage.v1")]` so separate server chunks (such as Next.js 16 Turbopack Route Handlers and Server Actions sharing a `globalThis` Prisma client) always observe the same active actor scope.
