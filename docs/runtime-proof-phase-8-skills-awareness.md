# Phase 8 Runtime Proof - Skills Awareness

Date: TBD
Workspace: `/Users/davidus-tranus/Github/Pi-Personas`

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

## Setup

Run these from the Pi-Personas repo root before opening or resuming the Pi
session:

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
