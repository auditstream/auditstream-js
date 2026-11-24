# Contributing to auditstream-js

Thank you for contributing to the Auditstream TypeScript adapters. Our engineering standards and workflow live in the engine repository's [engineering handbook](https://github.com/auditstream/auditstream/blob/main/docs/handbook/README.md); this file summarizes the `auditstream-js` specifics and links to the authoritative rules.

## Workflow: issue, branch, pull request, squash merge

- **Issues:** Claim an unassigned issue by assigning yourself before starting (for an agent, assign the human running it); see [Workflow: Issues](https://github.com/auditstream/auditstream/blob/main/docs/handbook/workflow.md#issues) and [Parallel work](https://github.com/auditstream/auditstream/blob/main/docs/handbook/parallel-work.md).
- **Spec changes:** The contract lives in `auditstream/auditstream`. File contract proposals in the [engine repository](https://github.com/auditstream/auditstream/issues/new?template=spec-change.yml); see [The contract](https://github.com/auditstream/auditstream/blob/main/docs/handbook/contract.md).
- **Branches:** Create a short-lived branch from `main` named `<type>/<issue>-<slug>` (for example `feat/12-actor-context`); see [Workflow: Branches](https://github.com/auditstream/auditstream/blob/main/docs/handbook/workflow.md#branches).
- **Commits and PR titles:** Pull request titles must follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/), using the `auditstream-js` scopes `node`, `prisma`, `drizzle`, `docs`, `ci` and `deps`; see [Workflow: Commits](https://github.com/auditstream/auditstream/blob/main/docs/handbook/workflow.md#commits).
- **Pull requests:** Close one issue per PR with `Closes #N`, aim for 400 changed lines or fewer (excluding lockfiles and generated files), open as draft until `pnpm check` and verification pass, and fill every template section; see [Workflow: Pull requests](https://github.com/auditstream/auditstream/blob/main/docs/handbook/workflow.md#pull-requests).
- **Changesets:** Every pull request that changes a published package (`@auditstream/node`, `@auditstream/prisma`, `@auditstream/drizzle`) must include a changeset (`pnpm changeset`). Docs-only and CI-only changes are exempt. The three packages release together as a Changesets `fixed` group; see [Releases: Adapters](https://github.com/auditstream/auditstream/blob/main/docs/handbook/releases.md#adapters).
- **Review and merge:** Pull requests require one human approval (both maintainers for `.github/workflows/`), green CI, resolved conversations and squash merge; see [Workflow: Review and merge](https://github.com/auditstream/auditstream/blob/main/docs/handbook/workflow.md#review-and-merge).

## Local checks and adapter standards

- Develop on Node 26 (`.nvmrc`) with pnpm 12 and run `pnpm check` before marking a PR ready; see [Engineering standards](https://github.com/auditstream/auditstream/blob/main/docs/handbook/engineering-standards.md).
- Follow every adapter rule (ESM-only, `@auditstream/node` as peer dependency, `AsyncLocalStorage.run()` only, no named prepared statements with per-actor comments, 40-request concurrency tests) in [Adapters (TypeScript)](https://github.com/auditstream/auditstream/blob/main/docs/handbook/adapters.md).

## AI usage policy

AI tools are welcome under [AI usage policy](https://github.com/auditstream/auditstream/blob/main/docs/handbook/ai-policy.md) and [AGENTS.md](AGENTS.md). Every pull request must fill in the required **AI disclosure** field (`none`, `assisted` or `agent-authored`, plus the tool name when applicable). Commit trailers such as `Co-Authored-By` are allowed, never required.

## Definition of done

See [Workflow: Definition of done](https://github.com/auditstream/auditstream/blob/main/docs/handbook/workflow.md#definition-of-done):

- [ ] Every acceptance criterion in the issue is met
- [ ] New tests cover the change and pass in CI
- [ ] Docs, changelog entry or changeset, and the spec are updated where the change touches them
- [ ] No new warnings from clippy or Biome
- [ ] Reviewed, squash-merged, and the issue closed by the merge

## Licensing and community

- Licensed under the [MIT License](LICENSE), with no CLA and no DCO (contributions are licensed under section D.6 of GitHub's Terms of Service; see [Security and community](https://github.com/auditstream/auditstream/blob/main/docs/handbook/security-and-community.md)).
- Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report security vulnerabilities privately via [SECURITY.md](SECURITY.md).
