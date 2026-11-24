# Security Policy

## Supported versions

During v0.x development, security fixes apply to the latest 0.x release (currently `0.2.x`) of `@auditstream/node`, `@auditstream/prisma` and `@auditstream/drizzle`, as well as `main` (Node.js `>=22.12`, Prisma `7.1+` within `7.x`, Drizzle `0.45` and `1.x`; see [Releases: Supported versions](https://github.com/auditstream/auditstream/blob/main/docs/handbook/releases.md#supported-versions)).

| Version | Supported |
| --- | --- |
| `0.2.x` / `main` | Yes |
| Earlier versions | No |

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities privately by emailing **security@auditstream.dev**. We aim to acknowledge every report within **3 business days** and coordinate disclosure once a fix is ready.

Include in your report:

- A clear description of the vulnerability and its impact (for example actor context leakage across concurrent requests or SQL comment injection).
- Affected package(s), ORM/driver versions and runtime version.
- Minimal steps to reproduce or a proof-of-concept.

### Reports found with AI tools

If a vulnerability was discovered or drafted with the help of an AI tool, your report **must** state so explicitly and include a working reproducer **verified by a human** before filing. Unverified AI-generated reports will be closed without investigation (see [AI usage policy](https://github.com/auditstream/auditstream/blob/main/docs/handbook/ai-policy.md)).
