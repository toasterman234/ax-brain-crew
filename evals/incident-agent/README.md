# /incident Investigator — golden evaluation dataset

Dataset for the planned `/incident` Slack Investigator agent (spec:
`vault/Meta/incident-command-spec.md`, workflow: `vault/Meta/incident-workflow.md`).
It validates two things: (1) that the agent classifies an incident correctly
(severity + failure category + root cause), and (2) that its **3-way recurrence
verdict** (`NEW` / `RECURRING` / `POSSIBLY-RELATED`) is sound — mechanism-based,
not symptom-based.

Everything here is grounded in the 6 real incident reports in
`vault/Meta/incidents/incident-*.md`. No incidents or root causes were invented.

## Files

| File | Rows | What it tests |
|------|------|---------------|
| `golden-incidents.jsonl` | 6 | One row per real incident. Correct severity, category, root cause, and that a fresh report is `NEW`. |
| `recurrence-pairs.jsonl` | 3 | Genuinely-related incident pairs where the verdict must be `POSSIBLY-RELATED` (similar symptom, different mechanism) — NOT `RECURRING`. |
| `synthetic-reopens.jsonl` | 5 | Resolved incidents reworded as "it happened again." Must return `RECURRING` + correct prior incident + correct `failure_mode`. Covers all three failure modes. |

## Schema

### golden-incidents.jsonl
```
{ "id", "input", "expected": { "severity", "category", "root_cause_summary", "verdict": "NEW", "prior_incident": null } }
```
- `input` — the raw symptom as a human would type it into `/incident` (Slack), NOT the polished report language.
- `category` — one of `routing` / `tool-failure` / `misclassification` / `hallucination` / `system-design` (from the workflow).
- `severity` — `low` / `medium` / `high` / `critical` (matches each report's frontmatter).

### recurrence-pairs.jsonl / synthetic-reopens.jsonl
Same base shape plus:
- `verdict` — `POSSIBLY-RELATED` (pairs) or `RECURRING` (reopens).
- `prior_incident` — the incident filename slug the agent must surface.
- `failure_mode` (reopens only) — `rca-wrong` / `prevention-missing` / `prevention-insufficient`.
- `reasoning` — human-readable justification for the expected verdict (for the model-based rubric grader; not a field the agent must output).

## Verdict rules (from the spec)

- `NEW` — no prior match, or a similar symptom with a **different mechanism**.
- `RECURRING` — only when it can name the specific prior incident **and** explain the **shared root-cause mechanism**. Similar symptom alone is NOT enough.
- `POSSIBLY-RELATED` — similar symptom, cannot confirm same cause. Links the prior incident, flags for human review.

## How rows were sourced

- **From the reports (all 6 golden rows, all 3 pairs, all 4 reopens):** severity from frontmatter; category from each report's "Classification"; root cause from "Root Cause Analysis"; `failure_mode` inferred from each report's actual "Prevention" / "Unresolved" section (see judgement calls below).
- **Raw `input` wording:** taken from the verbatim user quotes embedded in the reports themselves — e.g. `"what was i doing on febuary 20th"` (004), `"@Vault Agent research this"` (005), the follow-up forums/sources ask (006), `"audit and assess the agents file..."` (001) — then padded with the natural Slack framing a user would add ("it just told me...", "i pushed back and it still says..."). This keeps `input` raw and separate from the `expected` analysis.
- **Synthetic reopens** are the only fabricated inputs: real resolved incidents reworded as "it happened again." Their `expected` is still fully grounded in the corresponding report.

### agentmemory note
The spec suggested mining agentmemory for raw symptom wording. I searched
agentmemory (`memory_recall` / `memory_timeline` around the incident-writing
sessions). The relevant sessions are dominated by the file reads/edits of the
incident-authoring work itself, plus one decision memory capturing
`"i created a slack thread in research channel and got this. we need to create
an [incident]..."` (the 005/006 trigger). The `recall` API returned only compact
metadata, not full observation bodies, so it did not yield cleaner raw symptom
text than the verbatim quotes already preserved inside the reports. Per the task
rules, inputs were therefore derived from the reports' verbatim user quotes and
their "what was expected / what happened" sections. No incident lacked usable
raw wording.

## Judgement calls

### 004 vs 006 — why POSSIBLY-RELATED, not RECURRING (the key case)
Both are "a 120s timeout on seeker/conductor," so a user will connect them. But
the **mechanism differs**:
- **004** is a race: ax v23's internal retry-backoff collides with the crew's
  120s abort signal. The abort fires *before real work happens* — the LLM request
  was never even sent (`Request Body: undefined`). Nothing timed out from doing
  work; the retry was aborted mid-sleep.
- **006** is scope creep: conductor actually *ran* deep web research itself
  (because it holds `web.search`/`web.fetch`) and legitimately consumed 120s of
  work before the hard timeout.

Same ceiling, opposite cause. Under the spec's rule ("similar symptom ≠
recurring — the underlying cause must match"), the correct verdict is
`POSSIBLY-RELATED`: surface 004, link it, flag for human review. A false
`RECURRING` here is an explicit failure per the spec's success criteria.

### The other two pairs
- **006 vs 005** — same Slack thread, adjacent in time, but 005 is bridge
  context-loss (parent message dropped) while 006 is conductor doing web
  research itself. Context back-fill actually worked in 006's turn 1; the failure
  is elsewhere. Related surface, different cause → POSSIBLY-RELATED.
- **002 vs 001** — both share the "agent doubled down despite contradictory
  evidence" behavior, but 001 is a routing failure and 002 is a tool-interface
  design gap. 002's own report states it is "categorically different" from 001.
  Shared behavior pattern, different mechanism → POSSIBLY-RELATED.

### failure_mode picks for the synthetic reopens
Chosen from what each report's Prevention / Unresolved section actually says:
- **001 → prevention-insufficient** — prevention was fully implemented (router
  heuristics, `isVaultInitialized` guard, Contradiction Check). If it returns,
  the prevention didn't hold.
- **002 → prevention-missing** — the regression test was only listed as "will be
  added" to `tests/vault-tools.test.ts` (proposed, not confirmed landed). The
  most plausible gap on recurrence is the never-added test.
- **003 → prevention-insufficient** — prevention was doc-only manual advice
  ("verify the --dagu-home before reloading"), no automated guard/healthcheck.
  Manual advice doesn't hold against silent plist drift.
- **005 → prevention-missing** — the report's own "Unresolved" section says the
  fixes are "proposed, not implemented or verified"; the bridge back-fill never
  landed. Recurrence = prevention-missing.
- **004 → rca-wrong** — the one hand-crafted `rca-wrong` case. incident-004's
  fix unified retry ownership and the report explicitly claims "if this recurs,
  it can't be the retry-vs-abort race; it must be something else." The reopen
  supplies that "something else": a clean, typed proxy error after 3 successful
  crew-level retries, showing the race fix worked but the timeout still recurs
  because the real cause (genuine proxy/DeepSeek-V4 latency vs. a too-tight 120s
  ceiling) was misidentified as merely the trigger. Original RCA blamed the race
  → `rca-wrong`. This is a plausible synthetic (not asserting 004's real RCA was
  wrong), added to exercise the `rca-wrong` path that no historical incident
  covers.

## Category note
Incidents 002, 003, 004, 005, 006 all classify as `system-design` in their
reports (tools/components working as designed but the design has a gap), even
though several have a contributing `routing` factor. Only 001 is a pure
`routing` failure. The golden expectations follow each report's own
Classification line rather than re-deriving it.
