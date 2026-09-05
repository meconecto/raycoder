# Releasing raycoder

This is the maintainer runbook for release candidates and stable-channel promotion.

## Prerequisites

- Use Node.js 24 LTS, pnpm 11.19.0, Git, and the GitHub CLI (`gh`).
- Have permission to merge and create tags in `meconecto/raycoder`, dispatch GitHub Actions,
  and create GitHub releases.
- Configure the npm package `raycoder` with a Trusted Publisher for GitHub repository
  `meconecto/raycoder` and workflow filename `release.yml`. The release workflow exchanges
  GitHub's OIDC identity for short-lived npm publishing credentials; do not create or store a
  long-lived npm token in GitHub or the repository.
- Keep the pinned `actions/setup-node` step with `registry-url: https://registry.npmjs.org` in
  `release.yml`. It creates npm's temporary registry configuration so the CLI can exchange the
  GitHub OIDC identity; `id-token: write` alone is not sufficient for this workflow.
- For stable promotion, have a local npm maintainer session. Use `npm whoami`, and if needed
  `npm login --auth-type=web`; never print or copy npm authentication configuration.

## Release candidate flow

1. On a release branch, bump `apps/server/package.json` to a new, unpublished version ending
   in `-rc.N`. Update user-facing version references as needed. npm versions are immutable:
   never reuse a version, even when a previous publish was incomplete or defective.
2. Open a pull request and let CI pass. Merge it without changing the reviewed release
   version. The standard checks are offline and credential-free; `pnpm smoke:codex` is not
   part of them. Run that smoke only with explicit, immediate authorization because it invokes
   the real provider and consumes quota.
3. From the merged release commit, create and push an annotated tag matching the manifest:

   ```bash
   VERSION=$(node -p "require('./apps/server/package.json').version")
   git tag -a "v${VERSION}" -m "raycoder ${VERSION}"
   git push origin "v${VERSION}"
   ```

4. Dispatch `.github/workflows/release.yml` at that immutable tag with publishing enabled:

   ```bash
   gh workflow run release.yml --ref "v${VERSION}" -f publish=true
   gh run list --workflow release.yml --branch "v${VERSION}" --limit 1
   gh run watch <run-id> --exit-status
   ```

   The workflow repeats security, build, type, lint, unit, browser, package, installer, and
   dogfood validation; creates `raycoder-${VERSION}.tgz` and its SHA-256 file; uploads both as
   the `raycoder-release-candidate` artifact; publishes the tarball as `raycoder@next`; and
   creates a prerelease from the verified annotated tag.

5. Download the workflow artifact and verify it before accepting the candidate:

   ```bash
   gh run download <run-id> -n raycoder-release-candidate -D artifacts/verify
   cd artifacts/verify
   sha256sum --check "raycoder-${VERSION}.tgz.sha256"
   npm view "raycoder@next" version dist.integrity dist.shasum
   ```

   The checksum must pass and `next` must resolve to the exact candidate version. Keep the
   downloaded tarball and checksum paired; the checksum file names that tarball.

The first subsequent unpublished RC after configuring or changing the Trusted Publisher is
the end-to-end verification of the trust relationship. A green validation/upload phase alone
does not prove npm accepted the GitHub OIDC identity; confirm that the publish step succeeds
and `npm view raycoder@next version` returns the new version.

## Promote the accepted candidate

Do not rebuild or republish it. With `apps/server/package.json` still naming the accepted RC,
run:

```bash
npm whoami
pnpm release:promote
pnpm release:verify-tags
```

`release:promote` first requires `next` to identify the manifest version, then moves the npm
`latest` dist-tag to that same version. It verifies that `latest` and `next` have identical
version, integrity, and shasum values. Promotion therefore makes the tested RC artifact the
stable install without changing its version or bytes. A later version such as `1.0.0` is a
different immutable npm artifact and must go through the complete release flow itself.

## Recover a failed publish

If the workflow validates and uploads the artifact but fails during `npm publish`, inspect the
publish log first and check `npm view "raycoder@${VERSION}" version`.

- If npm does not know that version, fix the Trusted Publisher configuration or transient
  publishing problem, then rerun the same tagged workflow with `publish=true`. For `ENEEDAUTH`,
  also verify that the tagged workflow contains the pinned `actions/setup-node` registry step.
  A fresh job rebuilds from the same immutable tag and verifies its generated checksum before
  publishing. If the tagged workflow itself is defective, preserve the tag and prepare a new RC;
  never move the old tag to the fix.
- If npm already knows the version, do not retry publication or delete/reuse the version.
  Compare `npm view "raycoder@${VERSION}" dist.integrity dist.shasum` with the verified
  downloaded tarball. If they do not identify the same bytes, prepare a new RC version through
  the full PR and tag flow. If they match but `next` is wrong, repair only the tag with
  `npm dist-tag add "raycoder@${VERSION}" next`, verify it, and create the prerelease from the
  verified tag and downloaded files:

  ```bash
  npm view raycoder@next version dist.integrity dist.shasum
  gh release create "v${VERSION}" "raycoder-${VERSION}.tgz" \
    "raycoder-${VERSION}.tgz.sha256" --verify-tag --prerelease \
    --title "raycoder ${VERSION}" --generate-notes
  ```

In either case, download the artifact from the failed run and verify its checksum for diagnosis.
Do not create the GitHub prerelease until npm contains the intended immutable artifact.
