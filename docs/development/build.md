# Build and distribution

[Development](README.md) / Build

Edit plugin implementation and bundled resources in `src/harness/`. Both marketplaces install the tracked `dist/harness/` tree directly, without installing a compiler or running a build. Root tooling, tests, and contributor documentation stay outside the artifact. Public component links describe the distribution. Contributor implementation links use source paths.

## Local workflow

```sh
npm ci --include=dev
npm run build
node scripts/setup-tests.js
node scripts/run-tests.js
```

On Linux/WSL2, run development commands through `./scripts/dev exec`. Setup verifies existing output instead of rebuilding it. Run setup before each gate because the gate removes `.venv`.

Commit source and regenerated distribution together. `npm run build:check` assembles a fresh candidate and compares filenames, bytes, and executable intent without repairing source or distribution. `npm run validate:dist` validates the artifact. CI also runs `node scripts/validate-dist.js --tracked` to reject untracked output, wrong Git modes, and forbidden tracked caches or dependencies.

## Ownership and assembly

TypeScript compiles through the local CLI with strict checking, NodeNext resolution, and ES2022 output. Ordinary `.ts` modules emit CommonJS `.js` under the explicit plugin package boundary. The sampler's `.mts` emits native ESM `.mjs`. Installed skill commands continue to name JavaScript. Python and Swift stay in their existing languages. Assets copy byte for byte. The canonical version in `src/harness/package.json` is injected into both versionless source manifest templates.

The migration temporarily enumerates unmigrated JavaScript in `scripts/transitional-javascript.json`. Remove each entry when converting its module, and remove the entire mechanism at migration completion.

Each build uses unique ignored staging under `.build/`. It validates the complete candidate before reconciling owned generated files in place. It removes obsolete generated files and empty directories. Backup's `skills/back-up-directories/node_modules` and the writer's `scripts/__pycache__` are the only allowed local overlays. Their contents are opaque and their ancestors are retained, including mounted dependency directories. Source authoring directories have no dependency overlays.

Builds do not install runtime dependencies, initialize references, or compile the Swift helper. These remain skill/setup responsibilities. Source executable bits determine generated executable intent. A shebang alone does not make a file executable.

## Failure handling

A compiler or candidate validation failure leaves the existing artifact untouched. Publication I/O failure can leave partial generated output. Fix the reported cause, then complete a successful build and check before committing. Whole-directory publication is not atomic because mounted overlays must remain in place.

Concurrent publishing builds are unsupported and fail on `.build/publication.lock`. After a killed build, confirm it stopped before removing that lock. Check mode uses its own staging and never publishes. Symlinks, output collisions, unsupported assets, and source manifest version fields fail validation.

A stale check reports the rebuild command. Never fix drift by manually editing `dist/`. Compiler, build logic, and asset changes require reviewing fresh output. Sparse/local marketplace checkouts must include both root catalogs and the complete distribution.
