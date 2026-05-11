---
name: adr-principle-review
description: Step 2 of the QVAC architecture advice process. Cross-check an ADR draft's Decision and Consequences against PRINCIPLES.md (P1-P11). Flag conflicts, missing trade-offs, missing negative consequences, and missing tech-debt entries when a principle is knowingly broken. Output is a comment template the decider posts on the ADR PR.
disable-model-invocation: true
---

# adr-principle-review

Static review of an ADR draft against the architectural principles. Flags four classes of issues:

1. **Principle conflicts** the ADR did not declare in its Trace.
2. **Trade-offs missing** in Options when a principle is constrained.
3. **Negative consequences missing** when the decision visibly trades against a principle.
4. **Tech debt missing** when a principle is knowingly broken (mandatory per the process).

This is informational. It does not block merge.

## Inputs

- **Required**: ADR draft path: `docs/architecture/adr/NNNN-slug.md` (relative to qvac repo root).
- **Optional**: an explicit list of principles to focus on (P1, P2, ...). If omitted, scan all P1-P11.

## Workflow

```
- [ ] 1. Read the ADR draft
- [ ] 2. Read PRINCIPLES.md
- [ ] 3. For each principle, evaluate alignment vs conflict
- [ ] 4. Compile findings (conflicts, missing trade-offs, missing consequences, missing tech debt)
- [ ] 5. Print the review-comment template
```

### 1. Read the ADR

Extract these sections:

- **Context** — the problem framing.
- **Options considered** — each option's summary and trade-offs.
- **Decision** — chosen option.
- **Consequences** — Positive, Negative, Open risks, Tech debt created.
- **Trace** — listed Principles, NFRs.

If the file does not match the template (missing sections), say so in the report and stop.

### 2. Read the canonical source

```
Read: docs/architecture/PRINCIPLES.md
```

The principles are P1-P11 with names:

- P1 Device-First Design
- P2 Cross-Platform Parity
- P3 Modular at the Interface, Pragmatic at the Boundary
- P4 P2P as Infrastructure
- P5 Verifiable Trust Boundaries
- P6 Developer Experience is Architecture
- P7 Observable Without Phoning Home
- P8 Resilient at the SDK Boundary
- P9 Reach Every Device That Matters
- P10 Inference Platform, Not Application Framework
- P11 Strategic Depth Over Wholesale Forking

### 3. Evaluate alignment vs conflict

For each principle, classify the ADR's stance as one of:

- **aligns** — the decision reinforces or implements the principle.
- **conflicts** — the decision visibly trades against the principle (e.g. degrading offline, dropping a platform, adding telemetry, increasing API surface).
- **neutral** — the decision is orthogonal to the principle.

Use evidence: a quoted phrase or section reference from the ADR. Do not classify based on vibes.

### 4. Compile findings

For every principle marked **conflicts**, check:

- **Declared in Trace?** If not → flag as undeclared conflict (decider should add to Trace).
- **Trade-off in Options?** Each option's trade-offs should mention what's given up. If silent → flag missing trade-off.
- **Negative in Consequences?** Negative consequences should name the principle being traded against. If silent → flag missing negative consequence.
- **Tech debt logged?** Knowingly breaking a principle requires a tech debt ticket linked from Consequences. If missing → flag missing tech debt (this is mandatory per the process).

Also flag:

- **Trace cites a principle that the ADR does not actually engage** (over-claiming alignment).
- **Options has fewer than two entries** — the template requires status quo + at least one alternative.

### 5. Print the review-comment template

Output a Markdown block the decider can paste verbatim as a PR review comment. Format:

```markdown
## Principle review — ADR-NNNN

<one-sentence summary, e.g. "Two principle conflicts not declared in Trace; one missing tech debt entry.">

### Findings

<numbered list of findings; each with severity, principle, evidence>

1. **[blocker]** P7 Observable Without Phoning Home conflicts but is not declared in Trace.
   - Evidence: Decision says "send weekly health pings to <https://...>".
   - Fix: Add P7 to Trace; explain trade-off in Consequences.Negative; create tech debt ticket linking back to this ADR.

2. **[needs-attention]** P2 Cross-Platform Parity is listed in Trace as aligned but the Decision drops Windows support.
   - Evidence: Decision says "ship for darwin and linux only in v1".
   - Fix: Either restate as "conflicts with P2 — see Consequences" or remove from Trace.

3. **[advisory]** Options considered has only one entry (Option A — Status quo). Template requires at least two.
   - Fix: Add at least one alternative.

### Aligned principles (no action)

- P1 Device-First — aligned: runtime works fully offline once provisioned.
- P9 Reach Every Device — aligned: targets includes microcontrollers.

### Severity legend

- **blocker**: violates the process (e.g. broken principle without tech debt). Decider must address before merging.
- **needs-attention**: claim in the ADR is inconsistent with the body. Fix before requesting advice.
- **advisory**: cleanup or completeness. Address when convenient.

---

Generated by the `adr-principle-review` skill. Decider edits before posting.
```

## Output format

A single Markdown comment template printed to chat. No file edits. No PR comments posted automatically — the decider posts it manually after review.

## Safety rules

- **Read-only.** Never modify the ADR file or the PR.
- **Evidence required.** Each finding cites a quoted phrase or section reference. No findings without evidence.
- **Do not invent principles.** Only P1-P11 from PRINCIPLES.md. If you cannot read it, say so and stop.
- **Severity discipline.** Reserve "blocker" for missing tech debt on a conflicted principle (mandated by the process). Other inconsistencies are "needs-attention" or "advisory".
- **Do not auto-post.** Print the template to chat; decider posts.
