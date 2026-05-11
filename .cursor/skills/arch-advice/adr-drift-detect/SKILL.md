---
name: adr-drift-detect
description: Step 7 of the QVAC architecture advice process. Check whether a PR's diff fires significance triggers without a linked Accepted ADR. Output is informational and goes to the architect triage queue. Never blocks the PR.
disable-model-invocation: true
---

# adr-drift-detect

Detect implementation PRs that should have a linked ADR but don't. Combines the `adr-significance-classify` checks with a presence check for an `ADR-NNNN` reference in the PR description.

This is the architect's early-warning system, not a CI gate. It produces a report; the architect decides whether to engage.

## Inputs

- **Required**: PR URL, e.g. `https://github.com/tetherto/qvac/pull/1234`.

## Workflow

```
- [ ] 1. Parse PR URL
- [ ] 2. Fetch PR data (metadata, diff, body)
- [ ] 3. Run significance triggers on the diff
- [ ] 4. Look for ADR references in the PR body and commits
- [ ] 5. Verify referenced ADRs exist and are Accepted
- [ ] 6. Compose drift report
```

### 1. Parse PR URL

Extract `<num>`. Verify repo `tetherto/qvac`.

### 2. Fetch PR data

Save once, reuse:

```bash
gh pr view <num> --repo tetherto/qvac --json number,title,body,baseRefName,headRefName,headRefOid,files,commits > /tmp/drift-pr-<num>.json
gh pr diff <num> --repo tetherto/qvac --patch > /tmp/drift-pr-<num>.patch
```

### 3. Run significance triggers

Apply the same T1-T7 checks as `adr-significance-classify`:

| # | Trigger |
| --- | --- |
| T1 | Cross-package import |
| T2 | Public SDK API surface |
| T3 | Native dep / platform-specific code path |
| T4 | Addon / plugin / registry contract |
| T5 | New runtime / transport / storage |
| T6 | NFR threshold change |
| T7 | Principle conflict |

Detection signals are identical to `adr-significance-classify`. Use Grep on `/tmp/drift-pr-<num>.patch` and on PR body text for keyword matches.

### 4. Look for ADR references

Search PR body and commit messages for `ADR-\d{4}` (regex). Collect all matches. Also accept `adr-NNNN-slug.md` filename references.

```bash
rg -o 'ADR-\d{4}' /tmp/drift-pr-<num>.json
```

Plus check `commits[].messageBody` from the JSON.

### 5. Verify referenced ADRs

For each referenced `ADR-NNNN`:

- Glob `docs/architecture/adr/NNNN-*.md` to find the file.
- Read the file. Look for `- Status: <value>` line.
- Mark each reference with one of:
  - **valid** — file exists and Status is `Accepted`.
  - **wrong-status** — file exists but Status is `Proposed` / `Rejected` / `Withdrawn` / `Superseded` / `Retired`.
  - **missing** — no file matches that number.

### 6. Compose drift report

Decision matrix:

| Triggers fired | Valid ADR linked? | Verdict |
| --- | --- | --- |
| none | — | OK — no significance, no ADR needed |
| any | yes | OK — significant change with linked Accepted ADR |
| any | no (missing reference, wrong status, or no reference at all) | DRIFT — report to triage queue |

Output:

```markdown
## Drift detection — PR #<num>

**Verdict**: <OK | DRIFT>

<one-sentence summary, e.g. "T2 and T4 fire but PR references no ADR. Drift flagged.">

### Significance triggers fired

| # | Trigger | Evidence |
| --- | --- | --- |
| T2 | Public SDK API surface | `packages/sdk/src/index.ts:42` adds new export `runDelegated` |
| T4 | Addon contract | new method `IInferAddon.suspend()` in `packages/qvac-lib-infer-base/types.d.ts` |

### ADR references found in PR

- `ADR-0017` → `docs/architecture/adr/0017-delegated-inference-suspend.md` → Status: **Proposed** (wrong-status)
- (no others)

### Verdict reasoning

The PR fires significance triggers T2 and T4 but the only referenced ADR (ADR-0017) is still Proposed, not Accepted. The advice process requires an Accepted ADR before implementation merges. Either:

1. Wait for ADR-0017 to be Accepted and re-run drift detection.
2. If ADR-0017's advice window has closed and the decider intends to merge, set Status to Accepted in the same merge or a precursor PR.
3. If the implementation is intentionally diverging from ADR-0017, open a remediation ADR that supersedes it.

### Architect action

This drift is now flagged for the triage queue. The PR is **not blocked** — the architect decides whether to intervene.

To raise this as a tracked issue, the architect can run:

`gh issue create --repo tetherto/qvac --label drift --title "Drift: PR #<num> — <triggers>" --body "<paste this report>"`
```

When the verdict is OK, print a 2-line confirmation only:

```markdown
## Drift detection — PR #<num>

**Verdict**: OK — <reason, e.g. "no significance triggers fired" or "T2 fires; ADR-0017 is Accepted and referenced">.
```

## Output format

A Markdown report printed to chat. No file edits. No issues created automatically — the architect decides whether to file a `drift` issue based on the report.

## Safety rules

- **Read-only.** No edits to PR, ADR files, or git state.
- **Never block.** This skill is informational. No exit code, no failed status check, no PR comment posted.
- **Evidence required for every fired trigger.** Same rule as `adr-significance-classify`.
- **Don't fabricate ADR statuses.** Read the file. If the file is unparseable or missing, mark `missing` rather than guessing.
- **Don't auto-create drift issues.** The architect runs `gh issue create` manually.

## Future CI integration (out of scope for this pass)

The same prompt can be wrapped in a GitHub Actions `pull_request` workflow that invokes the skill on every PR matching path filters and posts the verdict as a non-blocking PR comment routed to the architect triage queue. Not implemented here; the skill is invoked manually for now.
