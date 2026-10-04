# SEV3 observations (for the user's review only)

SEV3 has not been modified, and nothing below is part of the Looprch implementation plan.
Looprch handles every case listed here on its own side. Any SEV3 change needs your explicit
approval first.

| # | Observation | Evidence | Looprch handling now | Possible SEV3 improvement (not applied) |
|---|---|---|---|---|
| 1 | Two different fingerprints exist: the source fingerprint (refinement and context headers) and the package fingerprint (`package-lock.json`) | Corebit: `0603b24e…` vs `0a132f63…` | Looprch tracks the package fingerprint and documents the difference | Name both explicitly in the package docs, or expose one canonical fingerprint |
| 2 | Generated `phases/EXECUTION_GUIDE.md` and `phases/README.md` hardcode an absolute path | Corebit: `/var/www/html/Corebit` | Looprch ignores paths in the guide and always uses the project root | Keep generated guides path-relative, as the template in `assets/package` already is |
| 3 | 109 sealed files have mode `600` | Corebit context views, tools, locks, registry | Looprch checks readability and reports a clear error | Normalize file modes to `644` when packaging |
| 4 | No machine-readable Looprch-compatibility field | `manifest.json` has only `schema_version` and `toolkit_version` | Looprch accepts known toolkit versions only | Add an optional `execution_protocol` field, e.g. `looprch/1` |
| 5 | The guides reference "Looprch's handover-and-git guide", a document from the 5.x build | `EXECUTION_GUIDE.md` (Final semantic handover) | The new Looprch ships `docs/user/handover-and-git.md` | None needed if Looprch provides the document |
| 6 | Gate evidence paths require the Looprch runtime folder at the package root | `evidence.path` pattern `^\.looprch/test-evidence/` | v1 requires the SEV3 package at the project root | Document the "package root = project root" assumption |
