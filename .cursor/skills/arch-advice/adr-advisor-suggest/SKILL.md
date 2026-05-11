---
name: adr-advisor-suggest
description: Step 3 of the QVAC architecture advice process. Suggest advisors for an ADR by mapping affected monorepo packages to QVAC pods (via Asana QVAC SDK & Platforms project), identifying team leads (via .github/teams/*.json), and ranking by recent activity. Caps at 6 advisors. Add the architect for cross-pod or principle-conflicting decisions.
disable-model-invocation: true
---

# adr-advisor-suggest

Produce a ranked advisor list for an ADR PR. Combines:

1. **Pod inference** from affected monorepo package paths.
2. **Asana roster** from the QVAC SDK & Platforms project (live, current).
3. **Team-lead overlay** from `.github/teams/*.json` (when present).
4. **Architect inclusion** when the decision spans pods or conflicts with a principle.

Output is a `name | pod | role | why` table, capped at 6 entries.

## Inputs

Exactly one of:

- **ADR draft path**: `docs/architecture/adr/NNNN-slug.md` (relative to qvac repo root). Infer affected packages from Context, Decision, and any explicit package mentions.
- **Explicit package list**: e.g. `["packages/sdk", "packages/llm-addon"]`.

Optional:

- **Lookback window for Asana activity**: default 90 days.
- **Force-include @handle list**: advisors the decider already knows are relevant.

## Workflow

```
- [ ] 1. Resolve affected packages
- [ ] 2. Map packages to pods (Context values)
- [ ] 3. Pull pod rosters from Asana
- [ ] 4. Overlay team leads from .github/teams/*.json
- [ ] 5. Decide architect inclusion
- [ ] 6. Rank and cap at 6
- [ ] 7. Print the advisor table
```

### 1. Resolve affected packages

If given an ADR path, search the file for `packages/<name>` mentions and infer additional packages from Decision phrasing. List the unique set.

### 2. Map packages to pods

Use this static mapping (embedded; do not depend on external files). The pod label is the Asana `Context` custom field value.

| Package(s) | Pod (Context) |
| --- | --- |
| `packages/sdk`, `packages/cli`, `packages/rag`, `packages/logging`, `packages/error` | `SDK` |
| `packages/llm-llamacpp`, `packages/embed-llamacpp`, `packages/onnx`, `packages/diffusion-cpp`, `packages/langdetect-text`, `packages/langdetect-text-cld2` | `NLP / Media Gen` |
| `packages/ocr-onnx`, `packages/translation-nmtcpp` | `Vision / Translation` |
| `packages/transcription-whispercpp`, `packages/bci-whispercpp`, `packages/transcription-parakeet`, `packages/tts-onnx`, `packages/decoder-audio` | `Speech` |
| `packages/inference-addon-cpp`, `packages/lint-cpp`, `packages/infer-base`, `packages/diagnostics`, `packages/dl-base`, `packages/dl-filesystem`, `packages/dl-hyperdrive`, `packages/qvac-lib-dl-base`, `packages/qvac-lib-dl-filesystem`, `packages/qvac-lib-dl-hyperdrive` | `DevOps` (cross-cutting infra) |
| `packages/registry-server`, `packages/qvac-lib-registry-server` | architect (sole maintainer) |

If a package is not in the table, fall back to `git log -n 20 --format='%aN' -- packages/<name>` to identify recent contributors and ask the user which pod owns it. Do not guess silently.

### 3. Pull pod rosters from Asana

For each unique pod from step 2, query Asana via `user-asana` MCP. The skill prompt instructs the agent to call:

```
CallMcpTool: server=user-asana, toolName=get_tasks
arguments:
  project: "1214153063536860"
  modified_since: "<now - 90 days, ISO 8601>"
  opt_fields: "name,assignee.name,custom_fields.name,custom_fields.display_value,permalink_url"
  limit: 100
```

Then filter client-side: keep only tasks whose `Context` custom field display value matches the pod label (e.g. `SDK`, `NLP / Media Gen`, etc.).

For each pod, aggregate distinct assignee names and count tasks per name. Rank by count desc.

If Asana is unreachable, fall back to `git log` on the affected packages: `git log --since=90.days --format='%aN' -- packages/<name> | sort | uniq -c | sort -rn`. Note "Asana unavailable; ranked by git log activity" in the output.

### 4. Overlay team leads

Read `.github/teams/*.json` for each pod's lead overlay. Format:

```json
{
  "name": "SDK Pod",
  "leads": ["NamelsKing"],
  "members": [...],
  "ownedPaths": [...]
}
```

If the JSON for a pod exists, mark its leads' role as `lead` and prepend them to the ranked list. If no JSON exists for a pod, mark all members `member` and rely on Asana ranking.

Currently committed: `.github/teams/sdk.json`. Other pods have no JSON yet — that is expected.

### 5. Decide architect inclusion

Add the architect (the user maintaining the architecture canon) when **any** of:

- Affected pods >= 2 distinct Context values (cross-pod decision).
- The ADR Trace lists a principle as conflicted (architect must triage tech-debt entry).
- An affected package is `packages/qvac-lib-registry-server` (sole maintainer).

The architect's `why` reflects the trigger: `cross-pod`, `principle conflict`, or `registry-server owner`.

### 6. Rank and cap at 6

Final ordering:

1. Architect (if included).
2. Team leads of affected pods.
3. Top members per pod by recent activity, round-robined across pods so no single pod monopolizes the slots.

If candidates > 6, drop the lowest-ranked member-tier entries until count == 6. Note "<N more candidates dropped" at the bottom.

If candidates < 6, that is fine — fewer is better than padding with low-signal advisors.

### 7. Print the advisor table

```markdown
## Advisor suggestions — ADR-NNNN

Affected packages: `<comma-separated list>`
Affected pods: `<comma-separated Context values>`
Asana data: <fresh / unavailable - fallback to git log>

| Name | Pod | Role | Why |
| --- | --- | --- | --- |
| @<handle> | architect | architect | cross-pod decision |
| @<handle> | SDK | lead | from .github/teams/sdk.json |
| @<handle> | NLP / Media Gen | member | top contributor in `packages/llm-addon` (24 Asana tasks last 90d) |
| ... | ... | ... | ... |

### Notes

- <if force-included handles were applied: "Force-included by decider: @x, @y">
- <if Asana fallback used: "Asana MCP unreachable; ranked by git log over the last 90 days. Roster may be stale.">
- <if dropped: "3 more candidates dropped to keep advisor count at 6.">

### Next steps

1. Review and edit. The agent doesn't know everything — drop people who shouldn't be on it; add people you know are relevant.
2. Tag them as reviewers on the ADR PR. Default advice window: 3 business days.
```

## Output format

A single Markdown table printed to chat. No file edits. The decider tags reviewers manually on the PR.

## Safety rules

- **Read-only.** Never modify the ADR, never post to the PR, never write to Asana, never push to git.
- **No silent guessing.** If a package is not in the static map and git log is empty (new package), print a question for the decider rather than fabricating an owner.
- **No fake @handles.** Asana returns names, not GitHub handles. Use the name and let the decider map to handles. If `.github/teams/*.json` provides a handle, use it.
- **Do not exceed 6 advisors.** More turns advice into a meeting per the process.
- **Do not auto-tag.** Decider tags reviewers themselves.
