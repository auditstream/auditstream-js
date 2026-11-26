---
"@auditstream/node": patch
---

Prevent prototype hijacking via `__proto__`, `constructor`, and `prototype` keys (and custom object prototypes) across `audit.as()`, `encodeScope()`, `setConfigValue()`, `tagSql()`, and `decodeScope()`. Harden `isTagged()`, `tagSql()`, and `decodeScope()` with a PostgreSQL-aware SQL lexer and strict sqlcommenter parser so trailing `--` line comments receive a newline before `/*auditstream='...'*/`, malformed or embedded `,auditstream='...'` comments never suppress tagging, and `decodeScope()` rejects NUL and unpaired UTF-16 surrogates even inside shadowed duplicate JSON keys.
