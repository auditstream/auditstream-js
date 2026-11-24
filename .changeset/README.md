# Changesets and npm Trusted Publishing

Every pull request that changes package source (`packages/*/src/**`) or package manifests (`packages/*/package.json`) must include a new changeset file under `.changeset/*.md`. Docs-only and CI-only pull requests do not need one.

```sh
pnpm changeset
```

## Versioning rules

- `@auditstream/node`, `@auditstream/prisma`, and `@auditstream/drizzle` are a `fixed` group and always share one version.
- Private packages (`@auditstream/test-utils`) are never versioned or tagged.
- While in `0.x`, breaking changes bump the minor version and everything else bumps the patch version. `onlyUpdatePeerDependentsWhenOutOfRange` plus the `>=0.1.0 <1.0.0` peer dependency range on `@auditstream/node` prevents Changesets from accidentally jumping to `1.0.0`.

## Maintainer setup for npm trusted publishing

Agents never run npmjs.com setup, change GitHub settings/secrets, or publish packages. A maintainer performs these steps once:

1. **GitHub App for version pull requests:** install the release GitHub App (Contents + Pull requests read/write) on `auditstream/auditstream-js` and add `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` as repository secrets. (Pull requests opened with the default `GITHUB_TOKEN` do not trigger CI.)
2. **GitHub `npm` environment:** create an environment named `npm` in `auditstream/auditstream-js` settings:
   - Require approval from **both maintainers**.
   - Restrict deployment branches to **`main` only**.
   - Do **not** add any `NPM_TOKEN` secret anywhere in the repository or organization (classic npm tokens were revoked in December 2025).
3. **Create / stage the three package names on npmjs.com:** trusted publishing cannot create a new package. For each package (`@auditstream/node`, `@auditstream/prisma`, `@auditstream/drizzle`), publish once by hand or stage it with `npm stage publish` (npm 11.15+ publishes a public `0.0.0-stage` placeholder). Note that package names become public as soon as they are created or staged.
4. **Configure trusted publishing on npmjs.com** for each of the three packages:
   - Repository: `auditstream/auditstream-js`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
   - Verify with `npm trust list @auditstream/node` (and the other two packages).
5. **2-day trust expiry — run a snapshot publish immediately:** a newly configured npm trusted publisher **expires automatically if it does not publish within 2 days**. Trigger `.github/workflows/release.yml` via `workflow_dispatch` with `snapshot=true` (and approve the `npm` environment deployment) within 2 days of configuring trust so the packages publish under the `snapshot` dist-tag via OIDC, then verify with `npm view @auditstream/node dist-tags`.

## Provenance limit while private

npm attaches SLSA provenance attestations automatically under trusted publishing, **except for private repositories**. While `auditstream/auditstream-js` is private, packages publish via OIDC without provenance; provenance starts automatically once the repository becomes public.
