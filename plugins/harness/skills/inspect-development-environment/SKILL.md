---
name: inspect-development-environment
description: Use when a durable inventory of a macOS or Linux development environment is needed to understand active tools, installed alternatives, providers, command resolution, project expectations, or reproducibility-relevant state. Do not use to diagnose a specific failure, modify or reproduce the environment, generate Docker or bootstrap artifacts, or inspect a different container, VM, or remote host.
---

# Inspect Development Environment

Create an evidence-backed inventory of the current macOS or Linux development environment. Make the JSON inventory canonical, and derive the Markdown report only from that JSON.

## Boundaries

- Use `standard` unless the user explicitly requests `deep`.
- Inspect only the current execution environment and current project.
- Keep all operations local, read-only, non-interactive, and unprivileged.
- Never use `sudo`.
- Do not use the network, install or update software, log in, activate an environment, change a cache, or control a service.
- Do not inspect inside a detected container, VM, WSL distribution, or remote host. Record the boundary only.
- Do not recursively scan `/`, the home directory, unrelated repositories, application data, external volumes, or remote filesystems.
- Never read `.env`, `.env.*`, credential files, keychains, password stores, token caches, browser data, or arbitrary user documents.
- Do not create a Dockerfile, bootstrap script, repair plan, comparison, SBOM, or reproduction guarantee.

If the user asks about one concrete environment failure, use `diagnose-environment` instead. If the user asks to reproduce or change an environment, do not run this inventory workflow unless the user also requests an inventory.

## Output

Publish exactly these two files in a new UTC timestamped directory:

```text
./development-environment-inventory-YYYYMMDDTHHMMSSZ/
  environment-inventory.json
  environment-report.md
```

Use directory mode `0700` and file mode `0600`. Never overwrite an existing path. If a timestamp collides, get a new current timestamp.

Build both files in a private sibling staging directory. Validate both files before one atomic directory rename publishes them. If the run fails, remove only the staging data that this invocation created.

## Modes

`standard` records:

- OS, kernel, process architecture, execution boundary, shell, ordered `PATH`, working directory, and project root.
- Active development commands and their resolution chains.
- Detected installation, package, and version managers.
- Installed alternate versions that a manager reports authoritatively.
- Relevant development components and direct global developer utilities.
- Project declarations, current-project environments, and direct packages in active or current-project environments.
- Differences between project declarations and observed state.
- GUI tools and services only when project or active-state evidence makes them relevant.

`deep` also records bounded evidence for:

- Complete package sets in current-project environments.
- Inactive environments inside the current project root.
- Relevant global ecosystem packages.
- Conventional development installation locations.
- Alternate architectures, compatibility layers, SDKs, IDE command integration, native libraries, databases, and local development services.

Deep mode does not weaken any boundary in this skill.

## Required core context

Before you create a staging directory, establish all of these items:

- OS family and version.
- Kernel and process architecture.
- Current execution boundary.
- Current shell.
- `PATH` as an ordered list.
- Working directory.
- Repository or project root when one is present.
- A safe, collision-free output target.

If a core item cannot be established safely, stop without publication and report the exact blocker. An optional probe failure does not stop publication. It changes `inspection.status` to `partial` and creates evidence, coverage, and warning records.

## Safe discovery

Start with shell resolution, runtime identity, and detected managers. Use targeted filesystem inspection only as a fallback.

- Distinguish an alias, function, wrapper, shim, `PATH` entry, symlink, runtime identity, provider, and installation.
- Do not execute an arbitrary discovered binary to guess its version interface.
- Use a version or help option only when its local, read-only behavior is known.
- Inspect current command help when a manager interface can change. Do not assume a fixed external JSON layout.
- Set a documented no-update option when a known manager needs it for a local query.
- Bound optional operations with harness-level time limits when available.
- If an optional operation cannot be bounded safely, record it as `skipped`.
- Do not install timeout software and do not retry a failed or timed-out probe automatically.
- Use only the project root, known manager roots, conventional platform development locations, and explicit safe paths from prior evidence.

On macOS, use safe local sources such as `sw_vers`, `uname`, process architecture, `xcode-select`, `xcrun`, known Homebrew prefixes, and detected version managers. Keep Apple-provided commands separate from Homebrew, version-manager, and manual installations. Record Rosetta or mixed architecture only when local evidence establishes it.

On Linux, use safe local sources such as `uname` and `/etc/os-release`. Detect package-manager capabilities instead of using a fixed distribution list. Keep platform packages, user managers, and manual installations separate. Do not query service data or start, stop, or connect to a service.

Read environment-variable values only when relevant and only from this allowlist:

```text
PATH SHELL TERM LANG LC_ALL SDKROOT DEVELOPER_DIR CC CXX JAVA_HOME GOPATH GOROOT
RUSTUP_HOME CARGO_HOME PYENV_ROOT NVM_DIR FNM_DIR MISE_DATA_DIR MISE_CONFIG_DIR
ASDF_DATA_DIR CONDA_PREFIX VIRTUAL_ENV PKG_CONFIG_PATH CPATH LIBRARY_PATH CFLAGS
CPPFLAGS LDFLAGS
```

Do not enumerate other environment-variable names. Redact an allowlisted value if it resembles a credential or contains an unrecognized URL with user information.

Inspect recognized shell startup files only for `PATH` construction, manager initialization, command wrappers, and architecture selection. Record the file and line number. Do not retain a complete line when it contains unrelated exports, command substitutions, private URLs, or values outside the allowlist.

## Project inspection

Treat declarations as intent, not observed conformance. Inspect only tool, version, environment, and package intent.

Recognize relevant declarations for:

- Node.js package manifests, engine constraints, version files, workspaces, and lockfiles.
- Python project files, requirement files, lockfiles, virtual environments, and version files.
- Ruby manifests, lockfiles, and version files.
- Rust manifests, lockfiles, and toolchain declarations.
- Go modules and workspaces.
- Java or Kotlin build files, wrappers, settings, and toolchain declarations.
- Swift package files and Xcode project or workspace declarations.
- .NET project, solution, package, SDK, and tool-version files.
- PHP manifests, lockfiles, and platform constraints.
- Version-manager declarations.
- Container and dev-container declarations.

Do not read application source merely to infer tool use. Do not read `.env` files or `.envrc` contents.

In `standard`, record direct installed packages only for active or current-project local environments. In `deep`, you can record complete package sets and inactive environments only inside the current project root.

## Canonical JSON contract

Set `schema_version` to `1.0.0`. Use these top-level keys and no others:

```text
schema_version inspection machine shell coverage managers components resolutions
relationships project assessments evidence warnings
```

Use explicit objects for managers, installations, components, resolution steps, relationships, project declarations, environments, packages, mismatches, assessments, coverage, evidence, and warnings. Do not mix provider, installation, activation, command resolution, project intent, or reproduction assessment.

Every material claim has this shape:

```json
{
  "value": "example",
  "basis": "observed",
  "confidence": "confirmed",
  "evidence_refs": ["evidence:command:001"],
  "rationale": null
}
```

Use `observed`, `declared`, or `inferred` for `basis`. Use `confirmed`, `probable`, or `unknown` for `confidence`. An inferred claim must have a nonempty rationale. Do not promote a declaration to an observation.

Use these identity rules:

```text
logical_key = component:<normalized-kind>:<normalized-name>
instance_key = installation:<logical-key>:<provider>:<version>:<architecture>:<scope>:<normalized-root>
```

Normalize identifiers to lowercase ASCII tokens separated by hyphens. Normalize the current home prefix to `~` for identity construction. Use `unknown` when a tuple value is absent. Keep each provider and installation separate under its logical component.

Each command resolution records the command, shell result, ordered chain, selected installation when established, alternate installations, and evidence references. Resolution-step kinds are `alias`, `function`, `wrapper`, `shim`, `path`, `symlink`, `runtime`, and `unknown`.

Relationship types are `managed_by`, `installed_by`, `contains`, `provides_command`, `resolves_to`, `requested_by`, `depends_on`, and `platform_provides`.

Assessment classifications are `project_relevant`, `workstation_relevant`, `container_relevant`, `probably_incidental`, and `unknown_relevance`. Keep assessments outside objective component state.

Evidence records contain a stable ID, source type, exact read-only operation or targeted path, UTC timestamp, status, exit code when applicable, normalized result, bounded sanitized excerpt, truncation state, omission reason, and redaction descriptions. Evidence statuses are `passed`, `failed`, `skipped`, `unsupported`, `not_applicable`. Do not retain a complete large output or output whose safety is uncertain.

Coverage uses the evidence status vocabulary. A manager that is absent is `not_applicable`, not `failed`. Warnings record partial coverage, uncertain provenance, skipped unsafe probes, and project mismatches. Warnings do not prescribe changes.

Sort arrays deterministically:

- Managers by normalized name and scope.
- Components by `logical_key` and installations by `instance_key`.
- Resolutions by command name.
- Relationships by type, subject, and object.
- Project declarations by relative path.
- Assessments by subject and classification.
- Evidence by evidence ID.
- Warnings by code and subject.

## Publication workflow

1. Select the mode and establish the required core context.
2. Inspect active commands, resolution chains, detected managers, and authoritative installed alternatives.
3. Apply the development-relevance rule before you retain a component.
4. Inspect project declarations and current-project environments.
5. Run the additional bounded discovery only in explicit `deep` mode.
6. Build the canonical JSON with separate claims, installations, resolutions, relationships, assessments, evidence, coverage, and warnings.
7. Sort all arrays and validate the complete object against this contract.
8. Create a private sibling staging directory and write `environment-inventory.json` with mode `0600`.
9. Derive `environment-report.md` only from the JSON and write it with mode `0600`.
10. Re-read both files. Confirm that each Markdown fact has a JSON coordinate and evidence reference.
11. Rename the staging directory to the unused final path.
12. Report the published directory, mode, completion status, coverage gaps, and two artifact names from the completed inventory. Do not rerun probes to restate metadata.

The report starts with platform and boundary, active runtimes and providers, native toolchains, managers, important inactive alternatives, project declarations and mismatches, coverage gaps, uncertain provenance, and reproduction assessments. Detailed component and evidence sections can follow.

Include a component only when evidence shows that it is active, project-requested, explicitly installed as a developer tool, part of another included component's provenance chain, or relevant to the requested deep scope. Broad manager queries do not authorize retention of unrelated package names. Record aggregate excluded counts when useful.
