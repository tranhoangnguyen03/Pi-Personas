# Phase 8 Runtime Proof - Skills Awareness

Date: 2026-06-30
Workspace: `/Users/davidus-tranus/Github/Pi-Personas`
Evidence: `/Users/davidus-tranus/.codex/attachments/1bfb017e-c1e7-42c8-8528-c786f6e4b6bf/pasted-text.txt`

## Verdict

Status: pass with one consult caveat.

The live Pi runtime proved the new skills-awareness contract for scaffold,
listing, doctor, direct launch, and legacy-field migration warnings. Direct
launch also proved that shared and specialist `skills.md` files are available to
the launched child.

Roster consult behavior was partially proved. The requester accepted
`phase8-guideline` by name without a `consults` allowlist and produced the
expected `Consulted:` provenance. However, the child reported that the native Pi
subagent tool was unavailable inside that environment, so it verified the
guideline skill/doc files directly rather than performing a true nested child
consult. Treat this as evidence that roster-based consult prompting works, not
as full proof of nested consult execution from inside a child persona.

## Goal

Prove the live Pi runtime matches the current Pi Persona metadata contract:

- `/persona new` scaffolds `skills`, not `tools`, `consults`, or `tags`.
- `/persona-list` shows role, description, docs, and skills.
- `/persona doctor` reports legacy `tools`/`consults`/`tags` as migration
  warnings, not permission gates.
- Direct launch preloads shared and specialist `skills.md` files as awareness
  breadcrumbs.
- Consults can target any known persona by name, guided by descriptions rather
  than requester-specific consult allowlists.

## Observed Results

| ID | Question | Observed | Verdict |
|---|---|---|---|
| P8-01 | Does `/persona new` scaffold `skills` metadata and omit old fields? | `phase8-generalist`, `phase8-brand`, and `phase8-guideline` were created. Output showed `Skills: none` for the generalist and specialist skill paths for brand/guideline. No scaffold output showed `Tools`, `consults`, or `tags`. | PASS |
| P8-02 | Does `/persona-list` show docs and skills? | List showed three personas. `phase8-brand` and `phase8-guideline` showed their docs and skills paths; `phase8-generalist` showed `docs: none` and `skills: none`. | PASS |
| P8-03 | Does `/persona doctor` pass with skills-aware agents? | Doctor reported `Status: pass`, `Agents: 3 launchable`, `Primary generalist: phase8-generalist`, baseline `.pi/agents/_baseline.md`, and `Issues - none`. | PASS |
| P8-04 | Does direct launch receive shared and specialist skill markers? | `/phase8-brand` run `7f713496` completed. Summary included `PHASE8_DIRECT_SKILLS_AWARENESS_OK`, `PHASE8_SHARED_SKILL_OK: yes`, and `PHASE8_BRAND_SKILL_OK: yes`. | PASS |
| P8-05 | Does roster consult work without `consults` metadata? | `/phase8-brand` run `a7e13fcf` returned `PHASE8_ROSTER_CONSULT_OK`, reported `PHASE8_GUIDELINE_SKILL_OK received: yes`, and included `Consulted: phase8-guideline`. The child also reported the native Pi subagent tool was unavailable and verified guideline files directly. | PASS WITH CAVEAT |
| P8-06 | Does doctor report legacy metadata as migration warnings? | After creating `phase8-legacy`, doctor reported `Status: warning`, `Agents: 4 launchable`, and warnings for legacy `tools`, `consults`, and `tags`. | PASS |

## Key Transcript Evidence

Scaffold and listing proof:

```text
Created .pi/agents/phase8-brand.md

Launch: /phase8-brand
Docs: docs/workstreams/phase8-brand/
Skills: .pi/skills/workstreams/phase8-brand/
Next: run /persona doctor

Pi Personas

- phase8-brand - specialist
  Brand specialist for Phase 8 proof.
  docs: docs/workstreams/phase8-brand/
  skills: .pi/skills/workstreams/phase8-brand/
- phase8-generalist - generalist (primary)
  Routes Phase 8 proof requests.
  docs: none
  skills: none
- phase8-guideline - specialist
  Guideline reviewer for Phase 8 proof.
  docs: docs/workstreams/phase8-guideline/
  skills: .pi/skills/workstreams/phase8-guideline/
```

Doctor pass proof:

```text
Pi Persona Doctor

Status: pass

Dependencies

- pi-subagents: 0.31.0 at /Users/davidus-tranus/.pi/agent/npm/node_modules/pi-subagents
- pi-intercom: 0.6.0 at /Users/davidus-tranus/.pi/agent/npm/node_modules/pi-intercom

Project

Agents: 3 launchable
Primary generalist: phase8-generalist
Generalists: 1
Baseline: .pi/agents/_baseline.md

Issues

- none
```

Direct launch proof:

```text
Run: 7f713496
Mode: single
Status: completed
Children: 1 completed

Summary:
PHASE8_DIRECT_SKILLS_AWARENESS_OK

Received:
- PHASE8_SHARED_SKILL_OK: yes
- PHASE8_BRAND_SKILL_OK: yes
```

Roster consult proof with caveat:

```text
Run: a7e13fcf
Mode: single
Status: completed
Children: 1 completed

Summary:
PHASE8_ROSTER_CONSULT_OK

PHASE8_GUIDELINE_SKILL_OK received: yes.

Consulted:
- phase8-guideline (answered): Consult request was prepared by roster name; native Pi subagent tool was unavailable in this environment, so guideline skill/doc files were verified directly and PHASE8_GUIDELINE_SKILL_OK was present.
```

Legacy warning proof:

```text
Pi Persona Doctor

Status: warning

Project

Agents: 4 launchable
Primary generalist: phase8-generalist
Generalists: 1
Baseline: .pi/agents/_baseline.md

Issues

- WARNING: .pi/agents/phase8-legacy.md: legacy field tools found; migrate tool-use guidance to skills
- WARNING: .pi/agents/phase8-legacy.md: legacy field consults found; route by agent descriptions instead
- WARNING: .pi/agents/phase8-legacy.md: legacy field tags found; prefer high-signal descriptions
```

## Follow-up

- Investigate why the native Pi subagent tool was unavailable inside the
  `phase8-brand` child during the roster consult proof. The code path allows
  roster-based consults, but this specific manual run did not prove true nested
  subagent execution from inside a child persona.
- Future proof should explicitly inspect the generated child task or session
  JSONL to confirm concrete reads include:
  - `.pi/skills/shared/skills.md`
  - `.pi/skills/workstreams/phase8-brand/skills.md`
  - `docs/shared/phase8/context.md`
  - `docs/workstreams/phase8-brand/brief.md`

## Setup

The following setup was used for the proof and can be reused for reproduction.
Run these from the Pi-Personas repo root before opening or resuming the Pi
session.

```bash
rtk mkdir -p docs/shared/phase8 docs/workstreams/phase8-brand docs/workstreams/phase8-guideline .pi/skills/shared .pi/skills/workstreams/phase8-brand .pi/skills/workstreams/phase8-guideline
rtk printf '%s\n' 'PHASE8_SHARED_DOC_OK' > docs/shared/phase8/context.md
rtk printf '%s\n' 'PHASE8_BRAND_DOC_OK' > docs/workstreams/phase8-brand/brief.md
rtk printf '%s\n' 'PHASE8_GUIDELINE_DOC_OK' > docs/workstreams/phase8-guideline/rules.md
rtk printf '%s\n' 'PHASE8_SHARED_SKILL_OK' > .pi/skills/shared/skills.md
rtk printf '%s\n' 'PHASE8_BRAND_SKILL_OK' > .pi/skills/workstreams/phase8-brand/skills.md
rtk printf '%s\n' 'PHASE8_GUIDELINE_SKILL_OK' > .pi/skills/workstreams/phase8-guideline/skills.md
```

Create or update `.pi/agents/_baseline.md` so it includes the shared docs and
shared skills:

```markdown
---
docs: docs/shared/phase8/
skills: .pi/skills/shared/
---
Shared Phase 8 runtime proof baseline.
```

## Pi Commands

Run these commands in a fresh Pi session:

```text
/persona new phase8-generalist --role generalist --description "Routes Phase 8 proof requests."
/persona new phase8-brand --description "Brand specialist for Phase 8 proof." --docs docs/workstreams/phase8-brand/ --skills .pi/skills/workstreams/phase8-brand/
/persona new phase8-guideline --description "Guideline reviewer for Phase 8 proof." --docs docs/workstreams/phase8-guideline/ --skills .pi/skills/workstreams/phase8-guideline/
/persona-list
/persona doctor
```

Expected:

- `phase8-generalist` is created with `primary: true` if it is the first
  generalist, otherwise `primary: false` with a warning.
- The scaffolded agent files include `skills:` and omit `tools:`, `consults:`,
  and `tags:`.
- `/persona-list` shows `docs:` and `skills:` lines.
- `/persona doctor` passes if exactly one generalist is primary and all doc/skill
  paths exist.

## Direct Launch Proof

Run:

```text
/phase8-brand Say exactly PHASE8_DIRECT_SKILLS_AWARENESS_OK. Also report whether you received PHASE8_SHARED_SKILL_OK and PHASE8_BRAND_SKILL_OK. Then stop.
```

Expected:

- The run launches through `pi-subagents`.
- The answer includes `PHASE8_DIRECT_SKILLS_AWARENESS_OK`.
- The answer reports both shared and brand skill markers.
- The child task or artifact shows concrete reads for:
  - `.pi/skills/shared/skills.md`
  - `.pi/skills/workstreams/phase8-brand/skills.md`
  - `docs/shared/phase8/context.md`
  - `docs/workstreams/phase8-brand/brief.md`

## Roster Consult Proof

Run:

```text
/phase8-brand Consult phase8-guideline by name. Ask it to say exactly PHASE8_ROSTER_CONSULT_OK and report whether it received PHASE8_GUIDELINE_SKILL_OK. Then synthesize the result with a compact Consulted footer.
```

Expected:

- The requester can consult `phase8-guideline` even though no `consults` field
  exists.
- The consultant receives its own docs/skills plus shared baseline.
- The final answer includes `PHASE8_ROSTER_CONSULT_OK`.
- The final answer includes a compact `Consulted:` footer.

## Legacy Warning Proof

Create a temporary legacy agent:

```bash
rtk cat > .pi/agents/phase8-legacy.md <<'EOF'
---
name: phase8-legacy
role: specialist
description: Legacy metadata warning proof.
tools: read, subagent
consults: phase8-guideline
tags: phase8, legacy
---
Legacy proof agent.
EOF
```

Run:

```text
/persona doctor
```

Expected:

- Doctor status becomes `warning` unless other errors exist.
- Issues include migration guidance for legacy `tools`, `consults`, and `tags`.
- Doctor does not require `subagent` as a consult permission gate.

## Cleanup

After recording the proof, remove only Phase 8 fixtures:

```bash
rtk rm -f .pi/agents/phase8-generalist.md .pi/agents/phase8-brand.md .pi/agents/phase8-guideline.md .pi/agents/phase8-legacy.md
rtk rm -rf docs/shared/phase8 docs/workstreams/phase8-brand docs/workstreams/phase8-guideline .pi/skills/workstreams/phase8-brand .pi/skills/workstreams/phase8-guideline
```

If `.pi/agents/_baseline.md` was changed only for Phase 8 proof, restore the
previous baseline manually after cleanup.
