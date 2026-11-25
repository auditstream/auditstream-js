---
"@auditstream/node": patch
---

Validate `occurred_at` calendar dates and clock ranges in `parseExportRecord()` using the shared proleptic Gregorian date validator.
