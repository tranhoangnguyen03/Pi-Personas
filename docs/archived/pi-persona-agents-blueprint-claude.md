# Pi Persona-Agent System — Build Blueprint v2

A scoped, file-based persona system for Pi Coding Agent. Replaces Kilo Code's
"agent dropdown with a shared tool/doc pool" with named personas that each carry
their own isolated tools and docs, a domain generalist that routes and moderates,
and an ad-hoc round-table for structured multi-specialist discourse.

---

## 1. Design goals

- **Named personas** selectable per task, with real tool/doc isolation (not
  prompt-injection isolation).
- **Two-tier scope:** shared baseline everyone gets + per-agent additive scope.
- **Clean handoff.** One agent = one scoped session. Switching = fresh session.
- **Three-tier invocation:** generalist → direct specialist → round-table.
- **Mid-session consultation.** Active agent can invoke specialists invisibly.
- **Ad-hoc round-table** with Delphi discourse protocol.
- **Conversational authoring.** Initial agents hand-ported; afterward the user
  creates/edits agents by talking to Pi.

---

## 2. Core mental model

> **An agent is a file. A single resolver assembles a scoped session from that
> file. The generalist is both a standalone agent and the moderator of
> round-tables. "Launch," "consult," and "convene" all use the same assembly
> machine.**

Four moving parts:

1. **Agent files** — `.pi/agents/*.md`, frontmatter-authoritative.
2. **Shared baseline** — `_baseline.md` + `docs/shared/`, merged into every
   session.
3. **Resolver** — written ONCE, generic over all agent files.
4. **Round-table orchestrator** — the generalist running Delphi protocol over
   an ad-hoc group of up to 5 specialists.

---

## 3. File & directory layout

```
.pi/
  agents/
    _baseline.md              # shared tools + docs for all agents
    generalist.md             # THE one generalist (router + moderator)
    brand-strategist.md       # specialist
    pricing-specialist.md     # specialist
    guideline-reviewer.md     # specialist
    secretary.md              # specialist
    docs-librarian.md         # specialist
  skills/
    agent-authoring/          # skill for conversational agent creation

docs/
  shared/                     # baseline docs — universal reference
    brand-guidelines.pdf
    company-voice.md
  workstreams/
    brand/                    # brand-strategist scoped
    pricing/                  # pricing-specialist scoped
    librarian/                # docs-librarian scoped
    ...
```

**Separation rule:** a doc/tool is scoped by living in a single agent file /
its own `workstreams/<x>/` folder and NOT in the baseline. Promote to universal
by moving into `_baseline.md` / `docs/shared/`.

**Writes:** inherited from Pi's own permissions — not modeled per-agent.

**Constraint:** exactly ONE generalist. The extension enforces this (only one
file may have `role: generalist`).

---

## 4. Agent file format

### Specialist

```markdown
# .pi/agents/brand-strategist.md
---
name: brand-strategist
role: specialist
description: Defines positioning, voice, competitive framing.
model: opus
tools:    [web_search]                 # ADDITIVE to baseline
docs:     [workstreams/brand/]         # ADDITIVE to baseline
consults: [pricing-specialist, guideline-reviewer]
tags:     [brand, positioning, voice, messaging, competitive]
---
You are a brand strategist. You help define positioning, voice, and
competitive framing for the company's products...
```

### Generalist

```markdown
# .pi/agents/generalist.md
---
name: generalist
role: generalist
description: Domain-aware generalist. Routes to specialists or answers directly.
model: opus
tools:    [web_search]                 # ADDITIVE to baseline
docs:     [docs/shared/]              # generalist sees shared; NOT specialist dirs
consults: [all]                        # may invoke any specialist
tags:     [general, routing, moderation]
---
You are the domain generalist. For straightforward questions, answer
directly using shared knowledge. When a question touches a specialty,
invoke the relevant specialist(s). You also serve as the moderator for
round-table discourse sessions...
```

### Baseline

```markdown
# .pi/agents/_baseline.md
---
name: _baseline
tools: [read_file, write_file, list_dir]
docs:  [docs/shared/]
---
(Optional shared system-prompt preamble injected into every agent.)
```

**Key fields:**
- `role:` — `generalist` or `specialist`. Exactly one generalist allowed.
- `consults:` — named peers or `all` (generalist only).
- `tags:` — used by the generalist for relevance-matching when assembling
  ad-hoc round-tables.

---

## 5. The resolver — written once

```
function assemble(agentName):
    base  = parse(".pi/agents/_baseline.md")
    agent = parse(".pi/agents/<agentName>.md")
    validate(agent)

    tools    = base.tools ∪ agent.tools
    readDocs = base.docs  ∪ agent.docs
    prompt   = base.preamble + agent.body
    model    = agent.model ?? default

    return scopedSession(tools, readDocs, prompt, model,
                         consults = agent.consults)
```

Generic: any new agent file is handled for free. No per-agent launcher.

---

## 6. Three-tier invocation

### Tier 1 — Generalist: `/generalist`

Domain-aware generalist session. Answers straightforward questions directly
using shared docs/tools. When a question touches a specialty, invokes the
relevant specialist(s) via the consult mechanism — invisibly to the user.

Can do *light substantive work* directly; delegates when it recognizes
specialty depth.

### Tier 2 — Direct specialist: `/<specialist-name>`

e.g. `/brand-strategist`, `/pricing-specialist`.

Direct session with a specific persona, scoped to its tools/docs. Can consult
peers listed in its `consults:` field.

### Tier 3 — Round-table: `/roundtable <query>`

Ad-hoc. The generalist reads the query, selects up to **5 most relevant
specialists** (matched by `tags:` + `description:` + `docs:` relevance to the
query), and convenes them into a Delphi discourse session.

### Picker: `/persona-select`

Lists all agents (generalist + all specialists). User selects from the list.
Named shortcut: `/persona-select brand-strategist`.

| Command | Session type | Who speaks to the user |
|---|---|---|
| `/generalist` | Generalist session | Generalist (routes invisibly) |
| `/brand-strategist` | Specialist session | Brand strategist |
| `/roundtable <query>` | Delphi discourse | Generalist (as moderator) |
| `/persona-select` | Picker | Whichever agent is selected |

All launch a **fresh session**. User may choose to resume a prior one.

---

## 7. Consult mechanism (agent-to-agent)

Unchanged from v1. Active agent invokes another by name. The resolver
assembles the consulted agent's scope **fresh from its file** — narrow by
default, no inheritance from caller.

**Topology:**
- Depth capped at 1 (one hop).
- Width open (parallel fan-out).
- Barrier fan-in — wait for all to settle.
- Independent failure / partial results (Promise.allSettled shape). Failures
  surfaced, not swallowed.

---

## 8. Round-table — Delphi protocol

When the user invokes `/roundtable <query>`:

### Step 0 — Convene (moderator)
The generalist reads the query, scores each specialist's relevance (using
`tags:`, `description:`, `docs:` fields), and selects up to 5. The selected
roster is reported to the user before proceeding.

### Step 1 — Independent positions (round 1)
Each selected specialist receives the query and responds independently. No
specialist sees any other's output. Assembled fresh from their files (scoped
isolation preserved).

Parallel fan-out, barrier fan-in, independent failure — same as the consult
mechanism.

### Step 2 — Reveal + Revise (round 2)
All round-1 positions are revealed to all specialists simultaneously. Each
specialist revises their position given what they now know from peers. They
may concede, reinforce, qualify, or flag tensions.

Same parallel/barrier/independent-failure semantics.

### Step 3 — Synthesis (moderator)
The generalist reads all round-2 revised positions and produces a final
synthesis for the user:
- Where specialists converged.
- Where tensions remain (and why).
- A recommended course of action.
- Which specialist(s) failed, if any (with impact noted).

**Cost profile:** N specialists × 2 turns + 1 moderator convene + 1
moderator synthesis = 2N + 2 calls. For 5 specialists: 12 calls.

**Depth cap applies:** specialists in a round-table may NOT themselves
consult other agents. The round-table IS the multi-agent interaction; nesting
consults inside it would create unbounded depth and cost.

---

## 9. Authoring agents

1. **Conversational (primary).** In a vanilla Pi session, the user asks Pi to
   create an agent. Pi (guided by `agent-authoring` skill) writes a new file
   in `.pi/agents/`.
2. **Slash command (optional).** `/agent new <name>` scaffolds from template.
3. **By hand.** Direct file editing.

**Validation:** `/agent doctor` checks each file against the schema, confirms
declared tools/docs exist, verifies exactly one generalist, and checks that
`consults:` references point to existing agent files.

---

## 10. Build order

1. **Schema + agent file format** (§4) — lock the frontmatter contract.
2. **Resolver / assembly** (§5) — merge + scoped-session start.
3. **Baseline wiring** (§3, §5) — `_baseline.md` + `docs/shared/` merge.
4. **Tier 2: direct specialist launch** — `/<specialist-name>` invocation.
5. **Consult mechanism** (§7) — agent-to-agent, parallel, barrier, partial.
6. **Tier 1: generalist launch** (§6) — `/generalist` with routing logic.
7. **Tier 3: round-table** (§8) — `/roundtable`, Delphi protocol.
8. **`/persona-select` picker** (§6).
9. **`/agent doctor` validation** (§9).
10. **`agent-authoring` skill** (§9).
11. **Port initial agents** from Kilo by hand.

Steps 1–4 give working single-specialist sessions.
Step 5 adds cross-agent consultation.
Steps 6–7 add generalist routing and round-table.
Steps 8–10 add UX and self-serve authoring.

---

## 11. Settled decisions

| Decision | Resolution |
|---|---|
| Write scope | Inherited from Pi |
| Direct launch | Fresh session; resume optional |
| Consult topology | One-hop, parallel, barrier fan-in, independent failure |
| Generalist count | Exactly one |
| Cross-domain round-table | Allowed; relevance-gated by moderator |
| Round-table membership | Ad-hoc, up to 5 most relevant specialists |
| Round-table invocation | `/roundtable <query>` — ad-hoc, not predefined files |
| Discourse protocol | Delphi (independent → reveal+revise → synthesize) |
| Moderator | The generalist |
| Agent creation | File creation via conversational authoring, slash command, or by hand |

---

## 12. Test content strategy

Testing this extension requires verifying each tier independently, then the
interactions between tiers, then the system as a whole. No code below — just
scenarios, what to observe, and what a pass looks like.

### Phase 1 — Foundation (steps 1–3): schema + resolver + baseline

**Test 1.1 — Schema validation.**
Create a correctly-formed agent file and a deliberately malformed one (missing
`role:`, invalid `consults:` reference, non-existent `docs:` path). Run
`/agent doctor`. Pass: valid file passes; each malformed variant gets a
specific, actionable error message.

**Test 1.2 — Baseline merge.**
Create a minimal specialist with one additive tool and one additive doc dir.
Assemble a session from it. Pass: the session has the baseline tools AND the
specialist's tool; the session can read from `docs/shared/` AND the
specialist's workstream dir; the session CANNOT read from another specialist's
workstream dir.

**Test 1.3 — Isolation.**
Assemble two different specialists in separate sessions. Pass: specialist A's
session has no access to specialist B's tools or docs, and vice versa. Verify
by attempting to read a file from the other's workstream — should fail or
return nothing.

### Phase 2 — Tier 2: direct specialist (step 4)

**Test 2.1 — Slash-command launch.**
Invoke `/<specialist-name>`. Pass: a fresh session starts; the agent's prompt
is active (it introduces itself or behaves per its persona); its scoped
tools/docs are available; baseline tools/docs are available.

**Test 2.2 — Fresh session guarantee.**
Launch the same specialist twice. Make a change (e.g. define a variable,
write a note) in session 1. Launch again. Pass: session 2 has no memory of
session 1's state.

**Test 2.3 — Resume path.**
Launch a specialist, do some work, exit. Re-launch with a resume option.
Pass: prior session state is restored.

### Phase 3 — Consult mechanism (step 5)

**Test 3.1 — Happy-path consult.**
In a brand-strategist session, ask a question that touches pricing (e.g.
"should we price this as premium or value?"). Pass: the brand strategist
invokes the pricing specialist, receives a synthesis, and presents a
combined answer. The user never directly interacts with the pricing
specialist. The brand strategist's answer references pricing considerations
it could not have known from its own docs alone.

**Test 3.2 — Consults-list enforcement.**
In a specialist that does NOT list another in its `consults:`, ask a
question that would require that other specialist. Pass: the agent does NOT
invoke the unlisted specialist. It either answers from its own knowledge
(possibly incomplete) or tells the user it can't address that domain.

**Test 3.3 — Parallel fan-out.**
In a specialist that consults two peers, ask a question touching both.
Pass: both are invoked; both results appear in the synthesis. Verify by
checking that the answer contains domain-specific content from both
consulted specialists.

**Test 3.4 — Partial failure.**
Simulate one consulted agent failing (e.g. by giving it a non-existent
doc path that causes an error). Pass: the calling agent still receives the
successful consult's result; the failure is explicitly noted in the
response (not silently dropped); the user is told which specialist was
unavailable.

**Test 3.5 — Depth enforcement.**
A consulted specialist attempts to itself consult a third agent. Pass: the
nested consult is blocked. The consulted specialist answers from its own
scope only.

### Phase 4 — Tier 1: generalist (step 6)

**Test 4.1 — Direct answer.**
Ask the generalist a straightforward question answerable from shared docs.
Pass: it answers directly without invoking any specialist. Response draws
on `docs/shared/` content.

**Test 4.2 — Transparent routing.**
Ask the generalist a question that clearly requires a specific specialist
(e.g. a detailed pricing question). Pass: it invokes the pricing specialist
via consult, synthesizes the answer, and presents it as its own. The user
sees one voice, not a handoff.

**Test 4.3 — Multi-routing.**
Ask the generalist a question that spans two specialties. Pass: it invokes
both relevant specialists (parallel), receives both results, and
synthesizes a combined answer.

**Test 4.4 — Routing accuracy (false positive).**
Ask the generalist something it should handle itself, phrased in a way that
might superficially seem like a specialist question. Pass: it answers
directly, not over-routing.

**Test 4.5 — Routing accuracy (false negative).**
Ask the generalist a subtle specialist question that doesn't use obvious
domain keywords. Pass: it still recognizes the need for a specialist and
routes.

### Phase 5 — Tier 3: round-table (step 7)

**Test 5.1 — Convene + roster.**
Invoke `/roundtable "Should we reposition the premium tier?"`. Pass: the
generalist selects relevant specialists (likely brand-strategist, pricing-
specialist, guideline-reviewer), reports the roster to the user, and
proceeds. Irrelevant specialists (e.g. docs-librarian) are NOT selected.

**Test 5.2 — Delphi round 1: independence.**
After convene, verify each specialist's round-1 position. Pass: positions
are substantively different (reflecting different domain lenses); no
specialist references another's position (confirming they didn't see it).

**Test 5.3 — Delphi round 2: revision.**
After reveal, verify each specialist's round-2 revised position. Pass: at
least one specialist meaningfully revises (concedes a point, adds a caveat,
adjusts a recommendation) based on what they learned from peers. The
revisions reference specific content from other specialists' round-1
positions.

**Test 5.4 — Delphi round 3: synthesis.**
Verify the moderator's final synthesis. Pass: it identifies convergence
points and remaining tensions; it recommends a course of action; it does
not flatten genuine disagreements into false consensus.

**Test 5.5 — Partial failure in round-table.**
Simulate one specialist failing in round 1. Pass: remaining specialists
proceed normally through both rounds. The moderator's synthesis notes which
specialist was unavailable and what coverage gap that creates.

**Test 5.6 — Participant cap.**
Invoke `/roundtable` on a query relevant to more than 5 specialists (once
enough exist). Pass: exactly 5 are selected. The moderator explains why
it chose those 5 over the others.

### Phase 6 — Picker + authoring (steps 8–10)

**Test 6.1 — `/persona-select` listing.**
Invoke `/persona-select` with no argument. Pass: lists all agents with
name + description, grouped by role (generalist first, then specialists).

**Test 6.2 — `/persona-select` shortcut.**
Invoke `/persona-select brand-strategist`. Pass: launches that specialist
directly, skipping the picker.

**Test 6.3 — Conversational creation.**
In a vanilla Pi session, ask "create a social-media agent that can use
web search and read the social workstream." Pass: Pi creates a well-formed
`.pi/agents/social-media.md` with correct frontmatter (role: specialist,
tools: [web_search], docs: [workstreams/social/], tags populated).

**Test 6.4 — Conversational editing.**
Ask Pi to "add guideline-reviewer to the brand-strategist's consults
list." Pass: Pi edits the existing file; the change is reflected in the
next session launch.

**Test 6.5 — Doctor catches conversational errors.**
After a conversational creation, run `/agent doctor`. Pass: catches any
issues (e.g. the conversational creation referenced a non-existent
workstream directory).

### Phase 7 — System-level integration

**Test 7.1 — Full workflow.**
Simulate a real workday sequence: launch generalist → ask a routing
question → exit → launch a specialist → consult a peer → exit → run a
round-table → verify synthesis. Pass: every transition works; no scope
leakage between sessions; no stale state.

**Test 7.2 — Agent addition doesn't break existing agents.**
Add a new specialist file. Re-run all previous tests. Pass: nothing
changes for existing agents; the new specialist appears in the picker and
is available for consult/round-table selection.

**Test 7.3 — Generalist uniqueness enforcement.**
Create a second file with `role: generalist`. Run `/agent doctor`. Pass:
doctor flags the violation. The resolver refuses to start with two
generalists.

**Test 7.4 — Isolation under stress.**
Run two specialist sessions concurrently (if the runtime allows). Verify
neither can access the other's docs or tools. Pass: complete isolation
maintained even under concurrent use.
