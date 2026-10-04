# Release process

v0.1.0 is built and tagged locally and not published.

1. `npm ci && npm run build && npm test && npm run test:e2e`; `npx tsc --noEmit -p tsconfig.json` clean.
2. `(cd vendor/sev3-toolkit/1.2.0 && sha256sum -c SHA256SUMS)`; the vendored files equal
   `sev3/assets/package/phases/tools/` (checked by `test/unit/sev3.test.ts` when `sev3/` exists).
3. `npm pack` → `looprch-<version>.tgz`. `tar tzf` must list only `package/{dist,assets,vendor,
   schemas,install.sh,VERSION,MANIFEST.sha256,README.md,LICENSE,CHANGELOG.md,package.json}`, and
   `package.json` has no `dependencies`.
4. Clean-room install: extract the tarball in a temporary directory, then
   `HOME=$H node package/dist/looprch.mjs install --from package` and
   `HOME=$H $H/.local/bin/looprch self-test --json` → `"ok": true`.
5. `install.sh` against the tarball: `LOOPRCH_NPX_SPEC=./looprch-<version>.tgz sh install.sh` in a
   temporary `HOME`; it must refuse Node < 22 or Python < 3.10.
6. `CHANGELOG.md` has a `## <version> - <date>` section; the README quickstart was checked by hand.
7. `docs/dev/spike-results.md` is current; unverified agents are marked in doctor and docs.
8. `git tag -a v<version> -m "Looprch <version>"` locally. No `npm publish`, no push (the
   publication repository is decided later).
