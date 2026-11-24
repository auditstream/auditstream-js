# Auditstream Conformance Fixtures

**Spec version:** 0.1.0 (tag: `spec-v0.1.0`)

This directory contains the language-neutral conformance fixtures for Auditstream Specification `0.1.0`. Every conforming engine (`auditstream`) and adapter (`auditstream-js` and future language repositories) MUST pass all applicable cases for the tag it pins.

## Layout

```text
spec/conformance/
├── README.md                  # This document
├── fixture.schema.json        # JSON Schema (draft 2020-12) for every fixture file
├── transport/
│   ├── encode.json            # Actor + optional context -> canonical JSON & unpadded base64url comment
│   ├── decode.json            # SQL text -> extracted actor, context, and actor_source
│   └── precedence.json        # Resolution precedence across set_config, comment, JWT, and unset
└── capture/
    ├── kit-t1-t9.json         # Core capture scenarios T1..T9 derived from the pooler test kit
    └── edge-tables.json       # Tables without primary keys, partitioned tables, composite PKs & cascades
```

## Case shape

Every fixture JSON file conforms to [fixture.schema.json](fixture.schema.json) and uses the top-level structure:

```json
{
  "spec": "0.1.0",
  "kind": "transport_encode | transport_decode | transport_precedence | capture",
  "cases": [
    {
      "name": "stable-unique-slug",
      "description": "Human-readable purpose of this case",
      "input": {},
      "expected": {}
    }
  ]
}
```

- **`spec`:** Specification version (`"0.1.0"`).
- **`cases[*].name`:** Stable, unique lowercase kebab-case identifier across its file. Implementations reference cases by `name` when reporting failures or skipping inapplicable cases.
- **`cases[*].input` / `cases[*].expected`:** Structured input and expected output matching the fixture's `kind`.

## Comparison rules

### Transport encode (`transport/encode.json`)

- **Valid cases (`expected.encoded` present):** Implementations MUST produce the **exact byte-for-byte** unpadded base64url string (`expected.encoded`) and trailing comment (`expected.comment`). Key order MUST match [spec/transport.md](../transport.md#canonical-json-and-base64url-encoding) (`type`, `id`, `onBehalfOf`, `tenant`, `context`; nested `onBehalfOf`: `type`, `id`, `tenant`; `context`: `requestId`, `source`, `ip`, `userAgent`), with compact UTF-8 JSON and no unnecessary `\uXXXX` escaping.
- **Error cases (`expected.error` present):** Implementations MUST reject the input before building any SQL text and MUST NOT truncate or emit a comment.

### Transport decode (`transport/decode.json`)

- Implementations MUST extract the trailing comment from `right(sql, 4096)` following [spec/transport.md](../transport.md#reader-extraction-algorithm-for-comments).
- Expected `actor`, `context`, and `actor_source` are compared by JSON structural equality (object key order is not significant on decode).
- When `actor_source` is `"invalid"` or `null`, both `actor` and `context` MUST be `null`.

### Transport precedence (`transport/precedence.json`)

- Evaluates the strict priority order `set_config` > `comment` > `jwt` > none, including the rule that malformed `set_config` or malformed `auditstream` comments yield `actor_source = "invalid"` and MUST NOT fall through to lower-priority sources.
- Empty `set_config` (`""`, as PostgreSQL reports after commit) MUST be treated as unset.

### Capture scenarios (`capture/*.json`)

- Each case defines `schema_sql`, `excluded_columns` (per table), and an ordered list of `steps`. Each step carries `sql`, `role` (`"app"` or `"admin"`), and optional `set_config`, `actor_comment`, or `jwt_claims` inputs.
- **Row projection:** Actual rows in `auditstream.changes` are projected to:
  - `table_name`
  - `op`
  - `record_id` (structural JSON equality)
  - `changed` (compared as a set of column names; element order is not significant)
  - `actor` (structural JSON equality)
  - `actor_source`
  - `before_keys` (sorted list of top-level keys present in `before`, or `null` when `before` is `NULL`)
  - `after_keys` (sorted list of top-level keys present in `after`, or `null` when `after` is `NULL`)
- **Row ordering rule:** Statement-level `INSERT` and `DELETE` triggers do not guarantee the order of rows inserted within a single statement, and `ON DELETE CASCADE` may emit child/parent rows in database order. Implementations MUST compare rows produced by a single step as an **unordered multiset** (for example by sorting both actual and expected rows within a step by `(table_name, op, record_id)`), while preserving step-to-step causal ordering.
- **Expected errors (`expected.step_errors`):** Each entry lists `{ "step_index", "sqlstate" }` (for example SQLSTATE `42501` `insufficient_privilege` when the `app` role attempts to write directly to `auditstream.changes`).

## Skipping inapplicable cases

Some fixture kinds apply only to specific layers (for example, `transport/precedence.json` and `capture/*.json` exercise PostgreSQL database behavior rather than a stateless client codec).

An implementation MAY skip a case ONLY when the case exercises a layer outside its scope (see [spec/compliance.md](../compliance.md)). Every skip MUST:

1. Name the exact skipped case `name` (or file) in the test harness.
2. Record an explicit human-readable reason (for example `"precedence is resolved inside PostgreSQL triggers; covered by engine integration suite"`).
3. Never silently ignore an empty fixture directory or an unexpected fixture hash.

## Release artifact and pinning

Each specification release is tagged `spec-v<version>` in `auditstream/auditstream` (for this release, `spec-v0.1.0`) with a GitHub Release attaching:

- `auditstream-spec-0.1.0.tar.gz` — created via `git archive --format=tar.gz --prefix=spec/ spec-v0.1.0:spec`
- `auditstream-spec-0.1.0.tar.gz.sha256` — SHA-256 checksum of the tarball

Adapter repositories pin the spec version, tag, and tarball SHA-256 in their `conformance.json` manifest and verify fixture integrity offline in CI.
