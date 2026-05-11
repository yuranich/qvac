---
name: adr-advice-transcribe
description: Step 5 of the QVAC architecture advice process. Read resolved review threads on an ADR PR and draft the *Advice received* table for the ADR file. The decider edits the y/n and rationale columns and commits. Read-only against the PR.
disable-model-invocation: true
---

# adr-advice-transcribe

Pull resolved review comments from an ADR PR, distill them by advisor, and produce a Markdown table the decider can paste into the ADR's `## Advice received` section. The decider then edits the `Applied?` and `If not, why` columns and commits.

The point: keep the ADR file self-contained without manual copy-paste from PR threads.

## Inputs

- **Required**: ADR PR URL, e.g. `https://github.com/tetherto/qvac/pull/1234`.
- **Optional**: include unresolved threads. Default `false` (process is "resolved threads only" per Section 5).

## Workflow

```
- [ ] 1. Parse PR URL
- [ ] 2. Fetch reviews + thread comments
- [ ] 3. Group comments by author and resolution state
- [ ] 4. Distill one row per advisor
- [ ] 5. Print the Markdown table
- [ ] 6. Print insertion instructions
```

### 1. Parse PR URL

Extract `<num>`. Verify repo is `tetherto/qvac`.

### 2. Fetch reviews + thread comments

Three calls; save outputs and reuse:

```bash
gh pr view <num> --repo tetherto/qvac --json number,title,author,reviews,baseRefName,headRefName > /tmp/adr-pr-<num>.json
gh api repos/tetherto/qvac/pulls/<num>/comments --paginate > /tmp/adr-pr-<num>-comments.json
gh api repos/tetherto/qvac/pulls/<num>/reviews --paginate > /tmp/adr-pr-<num>-reviews.json
```

`/tmp/adr-pr-<num>-comments.json` is an array of inline review comments with `id`, `user.login`, `body`, `in_reply_to_id`, `path`, `line`, `created_at`.

`/tmp/adr-pr-<num>-reviews.json` is an array of review submissions with `id`, `user.login`, `state` (APPROVED, COMMENTED, CHANGES_REQUESTED), `body`, `submitted_at`.

### 3. Group by author and resolution state

A thread is "resolved" if its top comment's `id` appears in any review with `state == "APPROVED"` or has been explicitly resolved via the GitHub UI. Resolution state via REST is messy; conservative rule: treat a thread as **eligible** for transcription if **any** of:

- The advisor (thread author) submitted an `APPROVED` review on the PR after their last comment in the thread.
- The thread root comment's author is the PR author and the advisor only commented in reply (advisor's input has been folded in).
- `--include-unresolved` was passed.

Otherwise mark the thread **pending** and exclude from the table.

Group eligible comments by `user.login`. For each advisor, collect their non-trivial comments (drop "lgtm", "ack", "ok" without context).

### 4. Distill one row per advisor

For each advisor with eligible comments:

- **Advice (summary)**: 1-2 sentences synthesizing what they said. Quote the strongest phrase verbatim if short. If the advisor made multiple distinct points, list them as a sub-bulleted block in the cell. Do not editorialize.
- **Applied?**: leave blank as `<TODO: yes/no>` — only the decider knows whether they applied the advice.
- **If not, why**: leave blank as `<TODO: rationale or "—">`.

Advisors who only approved without comment substance: include a row with `Advice (summary): approved without further comment`, `Applied? Yes (advice was approval)`, `If not, why: —`. This documents that they were consulted.

### 5. Print the Markdown table

```markdown
## Advice received — ADR-NNNN PR #<num>

Eligible advisors: <count>
Pending threads (excluded): <count> — <list of advisor handles with pending threads>

| Advisor | Advice (summary) | Applied? | If not, why |
| ------- | ---------------- | -------- | ----------- |
| @advisor1 | Recommended X over Y because Z. Also flagged that W could backfire on mobile. | <TODO: yes/no> | <TODO: rationale or —> |
| @advisor2 | "We should not couple the registry to the CLI." | <TODO: yes/no> | <TODO: rationale or —> |
| @advisor3 | approved without further comment | Yes (advice was approval) | — |

### Pending threads (not transcribed)

- @advisorX: 2 comments awaiting resolution.
- @advisorY: 1 comment, advisor has not approved yet.

These appear once threads resolve. Re-run this skill after the next review pass.
```

### 6. Print insertion instructions

```markdown
### How to apply

1. Open `docs/architecture/adr/NNNN-slug.md` (the ADR you're transcribing for).
2. Replace the `## Advice received` section's table with the table above.
3. Fill in the `<TODO: yes/no>` and `<TODO: rationale or —>` cells based on what you actually did with each piece of advice.
4. Commit and push to the PR. The PR is now ready for the merge step.
```

## Output format

A single Markdown block printed to chat. No file edits. No PR comments posted. The decider edits `Applied?` and `If not, why`, then commits the ADR change to the PR branch.

## Safety rules

- **Read-only.** Never edit the ADR file, never post to the PR, never push to git.
- **Never fabricate advice.** If an advisor's comments are unclear, quote them verbatim and note `<unclear — decider to clarify>` in the summary.
- **Never set `Applied?` automatically.** Only the decider knows.
- **Never include unresolved threads** unless `--include-unresolved` is passed. Section 5 of the process is explicit: resolved threads only.
- **Never invent advisors.** Only advisors who actually commented or reviewed the PR appear in the table.
