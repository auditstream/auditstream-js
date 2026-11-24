---
"@auditstream/prisma": minor
---

Add the `auditTransaction()` transaction-local `set_config` fallback (`SELECT set_config('auditstream.actor', $1, true)` via `setConfigValue()`) for Prisma Accelerate and finalize `@auditstream/prisma` TSDoc and API report.
