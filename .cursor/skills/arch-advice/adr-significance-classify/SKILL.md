---
name: adr-significance-classify
description: Steps 2 and 7 of the QVAC architecture advice process. Run the significance checklist over an ADR draft or a PR diff and report which triggers fire. Never gates — output is informational. Invoke before opening an ADR (to confirm it warrants the process) or on any PR (to detect missed ADRs).
disable-model-invocation: true
---

# adr-significance-classify

Determine whether a proposed change is architecturally significant. Run the seven-trigger checklist; report which triggers fire with one-line evidence; recommend `significant` / `borderline` / `not significant`. Never blocks. Output goes to the architect triage queue when run on a PR.

## Inputs

Exactly one of:

- **ADR draft path**: `docs/architecture/adr/NNNN-slug.md` (relative to qvac repo root). Read Context, Options, Decision, Trace.
- **PR URL**: `https://github.com/tetherto/qvac/pull/<num>`. Fetch via `gh pr view --json title,body,files,baseRefName,headRefName` and `gh pr diff <num> --patch`.

## The checklist

A change is **architecturally significant** if any of the following fire:

| # | Trigger | Detection signal |
| --- | --- | --- |
| T1 | Crosses a package boundary or introduces a new cross-package import | Diff shows new `import ... from '@qvac/<other-pkg>'` or `require('@qvac/<other-pkg>')` in a package that didn't depend on it before; or new entry in `packages/<x>/package.json` `dependencies` referencing another `@qvac/*` |
| T2 | Changes a public SDK API surface | Diff touches `packages/sdk/src/index.ts`, `packages/sdk/types/`, `packages/cli/src/commands/`, or any `*.d.ts` exported from a package's `package.json` `exports`/`main`/`types` |
| T3 | Adds a native dependency or platform-specific code path | New `binding.gyp`, `*.gyp`, `CMakeLists.txt`, prebuild config; new addon under `packages/*-addon`; new `bare-*` import in worker-side code; new platform guard `process.platform === '...'` |
| T4 | Touches the addon, plugin, or model registry contract | Diff touches `packages/sdk/src/addon/`, `packages/sdk/src/plugin/`, `packages/registry-*/`, `packages/qvac-lib-registry-server/`, or any `BaseInference` / `addon`-suffixed interface |
| T5 | Introduces a new runtime, transport, or storage technology | New top-level dependency on a runtime (Bare, Node, Bun), transport (Hyperswarm, WebRTC, libp2p), or storage (HyperDB, Hypercore, Hyperdrive, sqlite, levelDB) that the package didn't use before |
| T6 | Changes a published NFR threshold | Diff or ADR text mentions binary size, startup time, crash-free rate, platform coverage thresholds; or modifies CI gates that enforce them |
| T7 | Conflicts with a published principle | ADR Trace lists a principle as conflicted; or the change visibly contradicts P1-P11 in `docs/architecture/PRINCIPLES.md` (e.g. adding telemetry, dropping a platform, mandating network for runtime) |

If **none** fire, decide it inside the team using normal PR review or design doc. No ADR required.

## Workflow

```
- [ ] 1. Load input (ADR draft or PR data)
- [ ] 2. For each trigger T1-T7, gather evidence
- [ ] 3. Build the trigger table
- [ ] 4. Recommend significant / borderline / not significant
- [ ] 5. Print report
```

### 1. Load input

**ADR draft mode**: Read the file. Extract Context, Options, Decision, Trace.

**PR mode**: Save outputs once and reuse:

```bash
gh pr view <num> --repo tetherto/qvac --json title,body,files,baseRefName,headRefName,headRefOid > /tmp/sig-pr-<num>.json
gh pr diff <num> --repo tetherto/qvac --patch > /tmp/sig-pr-<num>.patch
```

Read the title/body/files via `Read`; grep the patch via `Grep` or `rg` against `/tmp/sig-pr-<num>.patch`.

### 2. Gather evidence per trigger

For each of T1-T7, record:

- **Fired**: yes / no / borderline
- **Evidence**: one line — file path, line, or quoted phrase from the ADR/PR. No speculation. If you cannot find concrete evidence, mark `no`.

T7 specifically requires reading `docs/architecture/PRINCIPLES.md` to compare claims. Do not cite principles you haven't verified.

### 3. Build the trigger table

```markdown
| # | Trigger | Fired | Evidence |
| --- | --- | --- | --- |
| T1 | Cross-package boundary | yes | `packages/sdk/src/foo.ts:12` adds `import { x } from '@qvac/rag'` |
| T2 | Public SDK API surface | no | — |
| T3 | Native dep / platform-specific | yes | new `packages/llm-addon/binding.gyp` |
| T4 | Addon / plugin / registry contract | no | — |
| T5 | New runtime / transport / storage | no | — |
| T6 | NFR threshold | borderline | ADR Context mentions "startup under 200ms" but no published threshold doc |
| T7 | Principle conflict | no | Trace cites P9 but stance is aligned, not conflicted |
```

### 4. Recommend

- `significant` — at least one trigger clearly fires.
- `borderline` — only borderline signals; flag for architect review.
- `not significant` — nothing fires.

State the recommendation in one sentence with the count of fired triggers.

### 5. Print report

```markdown
## Significance classification — <ADR-NNNN | PR #NNN>

**Recommendation**: <significant | borderline | not significant>

<one-sentence summary, e.g. "T1 and T3 fire — this introduces a new cross-package import and a new native dep. ADR is appropriate.">

<the trigger table from step 3>

### Notes for the decider

- <if "significant" and no ADR exists yet: "Open an ADR via the adr-draft skill before merging implementation.">
- <if "borderline": "Architect should spot-check.">
- <if "not significant": "Proceed via normal team review. No ADR required.">
```

## Output format

A single Markdown report printed to chat. No file edits. No PR comments posted automatically — the decider or architect copies the report into the relevant PR/ADR thread if needed.

## Safety rules

- **Read-only.** Never modify the ADR, the PR, or any file.
- **Evidence required.** Do not mark a trigger `yes` without a concrete file path, line, or quoted phrase.
- **Never gate.** This skill is informational. It does not pass/fail anything. The decider decides.
- **No fabrication.** If a check requires reading PRINCIPLES.md and you can't access it, say so in the report — do not guess.
