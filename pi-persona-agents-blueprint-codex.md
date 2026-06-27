# Pi Persona Agents - Codex Build Blueprint

A generic persona-agent extension for Pi Coding Agent, built on the existing
`pi-subagents` and `pi-intercom` packages.

The extension turns Pi's existing coding-agent scaffold into a role-aware
workspace system. It does not replace Pi's session model, subagent runtime, tool
registry, permissions, plugin conventions, or filesystem behavior. It adds a
thin semantic layer that assembles named role sessions from project-level
`pi-subagents` agent files, workspace docs, and Pi-registered tools.

The intended product shape is an 80/20 base:

- The extension supplies the generic 80%: persona schema, resolver, launch
  commands, baseline docs, consult and round-table semantics, validation, and
  conversational authoring on top of `pi-subagents` and `pi-intercom`.
- The user supplies the local 20%: their actual agents, docs, workstreams, tool
  choices, naming conventions, and operating habits.

The result can become a business operating layer, but the core extension should
remain generic. It should help users define their own operating layer without
forcing one onto them.

---

## 1. Product Boundary

This is a Pi Coding Agent extension first. Every design decision must account
for what Pi, `pi-subagents`, and `pi-intercom` already enable.

Pi owns:

- Session/thread lifecycle and resume behavior.
- Filesystem access and write permissions.
- Tool registration, execution, and external connector policy.
- Skill/plugin loading conventions.
- Slash-command or command-palette surfaces.
- Model selection, if exposed to extensions.
- Terminal, editor, and workspace integration.

Required dependencies own:

- `pi-subagents` owns child Pi sessions, foreground/background execution,
  fresh/fork context launch, parallelism, status, resume, interrupt, child
  safety, and project-level agent discovery.
- `pi-intercom` owns targeted session-to-session communication and the
  subagent-to-supervisor bridge for blocked decisions, structured clarification,
  and meaningful plan-changing updates.

Pi Persona Agents owns:

- Agent file schema.
- Baseline-plus-agent scope assembly.
- Command routing from persona commands to `pi-subagents` runs.
- Consult and round-table semantics.
- Validation of declared docs, tools, and agent references.
- Conversational authoring of agent files.

The extension must not invent a parallel subagent system, permission system,
tool runtime, or session store. Pi remains the platform; `pi-subagents` and
`pi-intercom` are the runtime substrate; pi-persona is the scoped role and
workflow layer on top.

---

## 2. Design Goals

- **Generic by default.** The extension ships as a reusable base, not a
  pre-baked business process.
- **No reinvented runtime.** Use required `pi-subagents` and `pi-intercom`
  mechanisms instead of building parallel child-session or communication
  machinery.
- **User-customizable.** Users can define agents, deploy docs, and choose tools
  without editing extension internals.
- **Named personas.** Users can launch role-specific Pi sessions by name.
- **Real scoped inputs.** Each agent receives only the docs and tools assembled
  for that session by the resolver.
- **Two-tier scope.** Shared baseline scope plus additive per-agent scope.
- **Clean handoff.** One agent launch creates one scoped `pi-subagents` run or
  Pi session. Switching agents starts fresh unless the user explicitly resumes.
- **Three invocation paths.** Generalist, direct specialist, and round-table.
- **Mid-session consultation.** Active agents can invoke allowed peers through
  the same resolver.
- **Low friction.** Avoid confirmations, gates, policy prompts, and write
  restrictions unless a concrete failure mode justifies them.
- **Build first.** Acknowledge future optimization areas, but do not tune them
  before users hit real pain.

---

## 3. Core Mental Model

> An agent is a file. A resolver assembles a scoped Pi session from that file.
> `pi-subagents` executes that session. `pi-intercom` lets child sessions
> escalate when blocked. Launch, consult, and round-table convening all use the
> same assembly path.

Four moving parts:

1. **Agent files** - `.pi/agents/**/*.md`, compatible with project-level
   `pi-subagents` agent discovery, with pi-persona fields layered on top.
2. **Shared baseline** - `_baseline.md` plus shared docs, merged into every
   agent session.
3. **Resolver** - generic assembly logic written once.
4. **Orchestrator** - the generalist running consults and round-tables through
   `pi-subagents`, with `pi-intercom` available for blocked children.

The important invariant: adding a new agent is data, not code. A user should be
able to create a new agent file, run validation, and launch it without adding a
new launcher implementation.

---

## 4. Runtime Dependencies And Adapter Points

The blueprint should be implemented through a small adapter over Pi,
`pi-subagents`, and `pi-intercom`. That adapter isolates package-specific calls
while keeping a single user-facing system.

Required packages:

- `pi-subagents`
- `pi-intercom`

The extension should refuse to enable consults, round-tables, or persona
launches until both packages are installed and visible to Pi. This is not an
optional enhancement; it is the execution substrate.

Required Pi capabilities:

- Read project files under the active workspace.
- Register or reference tool names exposed by Pi.
- Load `pi-subagents` project-level agent files.
- Launch `pi-subagents` child runs in fresh or fork context.
- Let `pi-intercom` provide `contact_supervisor` to subagent children when
  bridge metadata is present.
- Expose user-facing commands such as slash commands, command palette actions,
  or plugin actions.

Runtime contract:

- `pi-persona` agent files live in the same project-level agent surface used by
  `pi-subagents`.
- `pi-persona` should generate or maintain agent files that are valid
  `pi-subagents` project agents.
- The pi-persona resolver decides persona semantics: baseline merge, docs,
  consult permission, tags, role type, and round-table protocol.
- `pi-subagents` executes the resolved child runs.
- `pi-intercom` is used only for supervisor contact while a child is running,
  not as the ordinary result transport.
- If Pi cannot hard-enforce doc or tool boundaries, `/agent doctor` must say so
  plainly. The extension should still only load and declare the resolved scope.

Non-goal: building a second agent platform beside Pi. DRY, SOC, and KISS apply:
reuse proven `pi-subagents` and `pi-intercom` mechanisms, keep pi-persona as a
higher-value semantic layer, and avoid duplicate runtime machinery.

---

## 5. File And Directory Layout

```text
.pi/
  agents/
    _baseline.md              # pi-persona baseline; excluded from subagent runs
    generalist.md             # exactly one generalist
    brand-strategist.md       # specialist
    launch-reviewer.md        # specialist
    guideline-reviewer.md     # specialist
    secretary.md              # specialist
    docs-librarian.md         # specialist
    runtime/
      worker.md               # copied/adapted pi-subagents builtin, package: runtime
      reviewer.md             # copied/adapted pi-subagents builtin, package: runtime
      oracle.md               # copied/adapted pi-subagents builtin, package: runtime
  skills/
    agent-authoring/          # conversational agent creation/editing

docs/
  shared/                     # universal reference docs
    company-voice.md
    operating-principles.md
  workstreams/
    brand/
    launch/
    guidelines/
    librarian/
```

`.pi/agents/**/*.md` is the single project-level agent surface. Pi Persona
agents should be usable by `pi-subagents` directly. Pi Persona may add
frontmatter fields such as `role`, `docs`, `consults`, and `tags`, but `/agent
doctor` must verify that the resulting files remain compatible with
`pi-subagents` discovery.

Files prefixed with `_`, such as `_baseline.md`, are pi-persona control files,
not launchable agents.

Runtime support roles from `pi-subagents` should be copied into the project
when the project wants to pin or adapt them. Prefer copied files with provenance
metadata over symlinks for repo portability. Symlinks are acceptable for local
experimentation, but committed project behavior should not depend on machine-
specific npm package paths.

**Separation rule:** a doc/tool is scoped by living in a single agent file or
agent workstream folder, and not in the baseline. Promote to universal by moving
it into `_baseline.md` or `docs/shared/`.

**Writes:** inherited from Pi and the host filesystem. The extension does not
model per-agent write access by default.

**Generalist constraint:** exactly one file may have `role: generalist`.

---

## 6. Agent File Format

### Specialist

```markdown
# .pi/agents/brand-strategist.md
---
name: brand-strategist
role: specialist
description: Defines positioning, voice, competitive framing.
model: default
tools: web_search
defaultReads: docs/workstreams/brand/
docs: docs/workstreams/brand/
consults: guideline-reviewer, launch-reviewer
tags: brand, positioning, voice, messaging, competitive
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---
You are a brand strategist. You help define positioning, voice, and
competitive framing for the user's products and workstreams.
```

### Generalist

```markdown
# .pi/agents/generalist.md
---
name: generalist
role: generalist
description: Domain-aware generalist. Routes to specialists or answers directly.
model: default
tools: web_search, subagent
defaultReads: docs/shared/
docs: docs/shared/
consults: all
tags: general, routing, moderation
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---
You are the domain generalist. Answer directly when shared context is enough.
When a question clearly needs a specialist, consult the relevant specialist and
synthesize the result. For round-tables, act as moderator.
```

### Baseline

```markdown
# .pi/agents/_baseline.md
---
name: _baseline
tools: read, write, ls
docs: docs/shared/
---
Shared operating principles and baseline instructions injected into every
persona session.
```

Required fields for persona agents:

- `name` - command-safe unique name.
- `role` - `generalist` or `specialist`.
- `description` - short natural-language routing hint.
- `tools` - additive `pi-subagents`/Pi tool names.
- `docs` - additive pi-persona doc paths relative to the workspace root.
- `consults` - named peers or `all` for the generalist.
- `tags` - lightweight routing and selection hints.

Control and runtime files:

- `_baseline.md` is pi-persona control data and is not launchable.
- Copied runtime support roles may use `role: runtime`; they are launchable
  through `pi-subagents` but excluded from generalist routing and round-table
  selection unless the user explicitly invokes them.

Runtime-compatible fields:

- `defaultReads` should mirror the agent's default doc paths when the runtime
  should preload those files.
- `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `model`,
  `fallbackModels`, `thinking`, `skills`, `extensions`, and `maxSubagentDepth`
  follow `pi-subagents` semantics.

Optional fields:

- `model` - only honored if Pi exposes model choice to the extension.
- `owner` - human owner or team.
- `version` - user-maintained schema/content version.

---

## 7. The Remaining 20%: User Setup Path

The blueprint must explicitly support how a user turns the generic extension
into their local operating layer. The setup path has four parts: required
runtime packages, agents, docs, and tools.

### 7.0 Installing Runtime Dependencies

Pi Persona Agents requires:

- `pi-subagents`
- `pi-intercom`

The setup path should install or verify both packages through Pi's normal
package ecosystem. `/agent doctor` should fail early if either package is
missing, disabled, or not visible to the active Pi session.

After dependencies are present, pi-persona should enforce project-level agent
behavior by writing or maintaining project agent files under `.pi/agents/`.
When runtime support roles are needed, copy the relevant `pi-subagents` builtin
agent into `.pi/agents/runtime/` with provenance metadata, for example:

```yaml
---
name: worker
package: runtime
origin: pi-subagents builtin worker
originVersion: checked-by-agent-doctor
role: runtime
---
```

This keeps the project reproducible and avoids making users choose between a
persona system and a subagent system.

### 7.1 Defining Agents

Users should be able to define agents in three ways:

1. **Conversational authoring.** In a normal Pi session, the user says what role
   they want. The `agent-authoring` skill writes or edits the agent file.
2. **Scaffold command.** `/agent new <name>` creates a minimal valid agent file.
3. **Manual editing.** The user edits `.pi/agents/<name>.md` directly.

Agent files must remain launchable through `pi-subagents`. Pi Persona may add
semantic fields, but it should not create a second agent registry.

The authoring flow should ask only for missing essentials:

- Agent name.
- Role purpose.
- Docs/workstreams it should read.
- Pi tools it should use.
- Peers it may consult, if any.

Everything else gets a conservative default. The user can refine the agent over
time by editing the file or asking Pi to edit it.

### 7.2 Deploying Docs

Docs should be ordinary workspace files. The extension should not require a
separate knowledge-base product.

Recommended pattern:

- Put universal references in `docs/shared/`.
- Put agent-specific references in `docs/workstreams/<domain>/`.
- Reference those paths in `_baseline.md` or the relevant agent file.
- Run `/agent doctor` to confirm paths exist and are readable by Pi.

Document deployment is intentionally file-native. Users can use git, sync
folders, shared drives, generated markdown, PDFs, or whatever Pi can already
read. Pi Persona Agents only indexes or loads the paths declared in agent files.

### 7.3 Setting Up And Deploying Tools

Tools should be Pi or `pi-subagents` registered tool names. Agent files
reference tool names; they do not define a new tool runtime.

Recommended pattern:

- Install or enable tools through Pi's normal ecosystem.
- Add the tool name to `_baseline.md` if every agent should have it.
- Add the tool name to one specialist if it is domain-specific.
- Run `/agent doctor` to catch unknown tool names.

If Pi supports project-local tools, the extension may provide a thin helper to
link those tools into agent files. If Pi does not, tool setup remains external
to pi-persona, and the blueprint should say so plainly.

---

## 8. Resolver

```text
function assemble(agentName):
    base  = parse(".pi/agents/_baseline.md")
    agent = parse(".pi/agents/<agentName>.md")
    validate(base, agent)

    tools    = unique(base.tools + agent.tools)
    readDocs = unique(base.docs  + agent.docs)
    prompt   = base.body + "\n\n" + agent.body
    model    = agent.model ?? base.model ?? piDefaultModel

    return subagentRunSpec({
      agent: agent.name,
      tools,
      readDocs,
      prompt,
      model,
      consults: agent.consults
    })
```

The resolver is the single assembly machine for:

- Direct specialist launch.
- Generalist launch.
- Specialist consult.
- Round-table participant launch.
- Agent validation previews.

The resolver should be strict about file schema and path existence. It should be
minimal about policy. It assembles what the user declared; it does not second
guess the user's write permissions.

The resolver owns scope. `pi-subagents` owns execution. A forked consult may
carry requester conversation context, but it must not inherit requester docs,
tools, or consult permissions unless those are also present in the consultant's
resolved scope.

---

## 9. Invocation Model

### Tier 1 - Generalist: `/generalist`

Starts a generalist Pi session. The generalist answers directly when shared
context is enough. It consults specialists only when the task clearly needs a
specialist perspective.

### Tier 2 - Direct Specialist: `/<specialist-name>`

Starts a scoped specialist Pi session, such as `/brand-strategist` or
`/launch-reviewer`.

The specialist may consult only peers listed in its `consults` field. Consulted
agents use forked requester context by default, but their scope is assembled
from their own files.

### Tier 3 - Round-table: `/roundtable <query>`

The generalist selects up to five relevant specialists and convenes them into a
short Delphi-style process.

### Picker: `/persona-select`

Lists the generalist and all specialists. A direct shortcut such as
`/persona-select brand-strategist` launches the selected agent.

Direct user launches create fresh sessions by default. Resume behavior uses Pi's
native thread/session mechanism if available. Agent-to-agent consults are the
exception: they fork requester context by default to mimic how people forward a
whole email chain when asking for specialist input.

---

## 10. Consult Mechanism

An active agent can invoke another agent by name when permitted by `consults`.
The consulted agent runs through `pi-subagents`.

Default context policy:

- Consults fork requester context by default.
- The requester may deliberately choose a summarized/fresh consult instead.
- Forked context is reference context, not scope inheritance.
- The consultant's prompt, docs, tools, model, and consult permissions are
  resolved from the consultant's own agent file plus `_baseline.md`.

The default should feel like forwarding the full email chain: the consultant
gets enough history to understand why they were asked, without the requester
having to manually summarize every time.

Every consult also includes a small consult envelope so the consultant knows
what to do with the forwarded context:

```yaml
consult:
  requester: brand-strategist
  consultant: guideline-reviewer
  context: fork
  question: "What guideline risks or required edits do you see?"
  constraints:
    - "Answer from your guideline-reviewer role."
  expectedOutput:
    - risks
    - required edits
    - optional improvements
```

If the requester chooses summarized context, runtime mapping is:

```yaml
consult:
  context: fresh
  summary: "Requester-provided summary of only the relevant history."
```

Topology:

- Depth capped at one hop.
- Width open for parallel fan-out.
- Barrier fan-in: wait for all consults to settle.
- Independent failure: partial results are returned with explicit failures.
- No scope inheritance from caller: consulted agents receive their own resolved
  docs, tools, model, and consult permissions only.
- `pi-intercom/contact_supervisor` is available for blocked decisions,
  structured clarification, or meaningful plan-changing updates. Routine
  consult completion returns through `pi-subagents`.

Depth is capped to preserve cost, predictability, and debuggability. This is a
minimal structural rule, not a broad policy system.

---

## 11. Round-table Protocol

When the user invokes `/roundtable <query>`:

### Step 0 - Convene

The generalist selects up to five specialists using simple relevance over
`tags`, `description`, and declared `docs`. The roster is shown to the user.

This selection should be understandable, not over-engineered. Advanced routing
quality work belongs later, after users report concrete misses.

### Step 1 - Independent Positions

Each selected specialist receives the query independently through a
`pi-subagents` parallel run. By default, each specialist also receives forked
context from the requester/generalist so they understand the full situation.
No specialist sees another specialist's first response.

Forking requester context does not violate Delphi independence. Independence
means specialists do not see peer outputs before round 2; it does not require
discarding the original request history.

### Step 2 - Reveal And Revise

All first-round positions are revealed to all selected specialists. Each
specialist revises, qualifies, reinforces, or concedes.

### Step 3 - Moderator Synthesis

The generalist synthesizes:

- Where specialists converged.
- Where tensions remain.
- Recommended next action.
- Any specialist failures and their impact.

The round-table is the multi-agent interaction. Specialists inside a
round-table may not consult other agents.

---

## 12. Write Access Philosophy

Default: no pi-persona write guardrails.

The extension inherits Pi's permissions and the host filesystem's permissions.
If a human wants files to be read-only, the human should use normal filesystem,
workspace, repository, or organizational controls to make them read-only.

This is intentional:

- Extra prompts and policy layers slow down the core building loop.
- Write restrictions are easy to add badly and hard to make trustworthy.
- Pi already owns the permission model.
- The user is responsible for locking files that AI should not modify.

Friction is a necessary evil. It must be justified by a proven failure mode
before it becomes default behavior.

Allowed later, if users ask for it:

- Optional dry-run mode.
- Optional write summaries.
- Optional protected-path warnings.
- Optional integration with Pi or workspace-level read-only controls.

Not default:

- Per-agent write ACLs.
- Mandatory confirmations.
- Built-in protected file lists.
- Extra policy prompts around every edit.

---

## 13. Routing Philosophy

Routing should start simple.

Initial routing signals:

- Agent `tags`.
- Agent `description`.
- Declared `docs` paths.
- Explicit user command.
- Generalist judgment from the active query.

Do not optimize routing before users report problems. Avoid early scoring
models, learned profiles, complex eval suites, or heavy telemetry. Those can
breed complexity before the product shape is validated.

The design should leave room for future improvements:

- Explain why a specialist was selected.
- Let users override the roster.
- Record obvious false-positive or false-negative examples.
- Add lightweight tests for known routing misses.

But v1 should remain direct: pick plausible specialists, show the roster for
round-tables, and let users correct course.

---

## 14. Validation: `/agent doctor`

`/agent doctor` checks only the things the extension can know cheaply and
reliably:

- `pi-subagents` is installed, enabled, and discovering project agents.
- `pi-intercom` is installed, enabled, and available for child supervisor
  contact.
- Agent markdown parses.
- Required frontmatter exists.
- Agent files are compatible with `pi-subagents` project-level discovery.
- `name` values are unique.
- Exactly one generalist exists.
- `consults` references point to existing agents or valid `all`.
- Declared doc paths exist.
- Declared tool names are known to Pi if Pi exposes tool discovery.
- Copied runtime support roles include provenance metadata.
- Copied runtime support roles are checked for drift against installed
  `pi-subagents` builtins when feasible.
- Baseline merge previews look sane.

It should produce actionable errors, not policy lectures.

Examples:

- `brand-strategist: docs/workstreams/brand/ does not exist`
- `launch-reviewer: consults unknown agent guideline-reviewr`
- `generalist: role generalist appears in 2 files`
- `secretary: tool calendar_lookup is not registered in Pi`
- `runtime.worker: copied from pi-subagents 0.31.0; installed builtin changed`
- `dependency: pi-intercom is installed but not loaded in this Pi session`

---

## 15. Authoring Agents

The `agent-authoring` skill is the user's main path from generic base to local
customization.

It should support:

- Create a new agent from a plain-English role description.
- Edit an existing agent's tools, docs, consults, tags, or body.
- Move docs between baseline and specialist scope.
- Suggest tags from the description and docs path.
- Run `/agent doctor` after edits.
- Preserve user wording unless cleanup is necessary.
- Preserve `pi-subagents` compatibility while adding pi-persona metadata.

The skill should not over-interview. Ask only for information needed to produce
a valid file. The user can iterate.

---

## 16. Build Order

1. **Runtime dependency audit.** Confirm `pi-subagents` and `pi-intercom` are
   installed, loaded, and callable in the active Pi session.
2. **Project agent surface.** Confirm `.pi/agents/**/*.md` discovery through
   `pi-subagents`, including how to exclude `_baseline.md` and how copied
   runtime roles should be named.
3. **Schema and parser.** Lock the pi-persona metadata contract while retaining
   `pi-subagents` compatibility.
4. **Resolver.** Merge baseline plus agent into a `pi-subagents` run spec.
5. **Baseline wiring.** Support `_baseline.md` and `docs/shared/`.
6. **Direct specialist launch.** Launch `/<specialist-name>` sessions.
7. **Doctor.** Validate dependencies, schema, docs, tools, runtime compatibility,
   copied builtin provenance, and generalist uniqueness.
8. **Conversational authoring.** Create/edit agents through Pi.
9. **Generalist launch.** Add `/generalist` with simple routing.
10. **Consult mechanism.** Add one-hop peer consults with forked requester
    context by default and summarized/fresh as an explicit override.
11. **Round-table.** Add Delphi-style multi-specialist discourse through
    parallel `pi-subagents` runs.
12. **Picker.** Add `/persona-select`.
13. **Initial examples.** Ship a small generic sample set, not a fixed business
    operating system.

Steps 1-7 prove the runtime-backed scoped file model.
Steps 8-9 make the system user-customizable.
Steps 10-11 add multi-agent leverage.
Step 12 improves ergonomics.

---

## 17. Settled Decisions

| Decision | Resolution |
|---|---|
| Product boundary | Pi extension, not separate agent platform |
| Runtime dependencies | `pi-subagents` and `pi-intercom` are required |
| Runtime design | Reuse required packages; do not build a parallel subagent system |
| Default write policy | Inherit Pi and filesystem permissions |
| User customization | 80% generic base, 20% user-defined agents/docs/tools |
| Agent definition | Project-level `pi-subagents` markdown files with pi-persona metadata |
| Runtime support roles | Copy/adapt builtins locally with provenance; symlinks only for local experiments |
| Tool setup | Pi/`pi-subagents` registered tools referenced by name |
| Doc setup | Workspace files referenced by path |
| Direct launch | Fresh session; resume through Pi if available |
| Consult context | Fork requester context by default; summarized/fresh is explicit |
| Consult scope | Consultant scope always resolves from consultant file plus baseline |
| Consult topology | One-hop, parallel fan-out, barrier fan-in through `pi-subagents` |
| Generalist count | Exactly one |
| Round-table membership | Ad hoc, up to five specialists |
| Discourse protocol | Independent, reveal/revise, synthesize |
| Supervisor bridge | `pi-intercom/contact_supervisor` only for blocked or plan-changing updates |
| Routing | Simple first; optimize only after user-reported misses |
| Validation | Cheap structural checks through `/agent doctor` |

---

## 18. Test Content Strategy

Testing should verify Pi integration boundaries first, then the persona
features.

### Phase 1 - Runtime Adapter

**Test 1.1 - Required dependency audit.**
Run `/agent doctor` in a session with both packages installed and in a session
where one package is missing or disabled. Pass: both required packages are
detected when present; missing or disabled dependency produces a blocking,
actionable error.

**Test 1.2 - Project agent discovery.**
Create a valid `.pi/agents/<name>.md` persona file. Pass: `pi-subagents`
discovers it as a project-level agent, while `_baseline.md` is not launchable.

**Test 1.3 - Tool discovery.**
Reference one known Pi tool and one fake tool. Run `/agent doctor`. Pass: the
known tool passes if Pi exposes discovery; the fake tool gets an actionable
warning or error.

**Test 1.4 - Permission inheritance.**
Attempt writes through a persona session using normal Pi permissions. Pass:
behavior matches Pi and filesystem permissions, with no extra pi-persona write
gate.

**Test 1.5 - Runtime support role provenance.**
Copy a `pi-subagents` builtin into `.pi/agents/runtime/`. Pass: `/agent doctor`
reports provenance and, when feasible, drift against the installed builtin.

### Phase 2 - Schema, Resolver, Baseline

**Test 2.1 - Schema validation.**
Create a valid agent and malformed variants. Pass: valid file passes; malformed
files get specific errors without breaking `pi-subagents` compatibility.

**Test 2.2 - Baseline merge.**
Create a minimal specialist with one additive tool and one additive doc dir.
Pass: assembled scope includes baseline plus specialist declarations.

**Test 2.3 - No accidental specialist docs.**
Assemble two specialists. Pass: the resolver loads only baseline docs and the
selected specialist's declared docs.

### Phase 3 - User Setup Path

**Test 3.1 - Conversational agent creation.**
Ask Pi to create a new specialist for a concrete workstream. Pass: a valid
`.pi/agents/<name>.md` file is created with docs, tools, tags, and body.

**Test 3.2 - Doc deployment.**
Add a file under `docs/workstreams/<domain>/`, reference it from an agent, and
run `/agent doctor`. Pass: the path validates and appears in resolver preview.

**Test 3.3 - Tool deployment.**
Enable a Pi tool through Pi's normal tool setup, reference it from an agent, and
run `/agent doctor`. Pass: the tool resolves or the limitation is clearly
reported if Pi cannot expose discovery.

### Phase 4 - Direct Launch

**Test 4.1 - Specialist command.**
Invoke `/<specialist-name>`. Pass: a fresh scoped Pi session starts with the
agent prompt and declared docs/tools.

**Test 4.2 - Fresh session default.**
Launch the same specialist twice. Pass: the second launch does not inherit
unrequested conversational state from the first.

**Test 4.3 - Resume path.**
Resume a prior specialist session using Pi's native mechanism. Pass: state
restores only when explicitly resumed.

### Phase 5 - Generalist And Consults

**Test 5.1 - Direct generalist answer.**
Ask a question answerable from shared docs. Pass: the generalist answers
without consulting a specialist.

**Test 5.2 - Specialist consult.**
Ask a question that clearly needs a listed peer. Pass: the active agent
consults that peer through `pi-subagents`, receives a scoped result, and
synthesizes it.

**Test 5.2a - Forked context default.**
Create requester context that is necessary for the consultant to answer well,
then trigger a consult without specifying context mode. Pass: the consultant
receives the requester conversation context as reference context.

**Test 5.2b - Scope does not fork.**
Give the requester a specialist-only doc or tool not declared by the consultant.
Pass: the consultant can see forwarded conversation context but does not receive
the requester's docs, tools, model, or consult permissions.

**Test 5.2c - Summarized/fresh override.**
Trigger a consult with an explicit summarized/fresh context option. Pass: the
consultant receives the summary/envelope rather than the full requester
conversation.

**Test 5.3 - Consult permission.**
Ask for a consult to an unlisted peer. Pass: the consult is not invoked.

**Test 5.4 - Partial failure.**
Break one consulted agent's doc path. Pass: successful consults return, failure
is reported, and work continues.

**Test 5.5 - Depth cap.**
Have a consulted agent attempt a nested consult. Pass: the nested consult is
blocked.

**Test 5.6 - Supervisor bridge.**
Have a consulted agent encounter a blocking decision. Pass: it uses
`pi-intercom/contact_supervisor`; routine completion still returns through
`pi-subagents`.

### Phase 6 - Round-table

**Test 6.1 - Convene roster.**
Invoke `/roundtable` with a cross-functional question. Pass: the generalist
selects up to five plausible specialists and shows the roster.

**Test 6.2 - Independent first round.**
Pass: first-round specialist outputs may use the original requester/generalist
context, but do not reference each other.

**Test 6.3 - Reveal and revise.**
Pass: second-round outputs react to the revealed peer positions.

**Test 6.4 - Synthesis.**
Pass: the moderator identifies convergence, unresolved tensions, and a next
action without flattening disagreement.

### Phase 7 - Integration

**Test 7.1 - Full workflow.**
Run: verify dependencies, create agent, deploy docs, reference a Pi tool,
doctor, direct launch, generalist consult, round-table. Pass: each layer works
without changing extension code or choosing between two agent systems.

**Test 7.2 - Add agent without breakage.**
Add a new specialist file. Pass: existing agents keep working; the new agent
appears in picker and can be launched.

**Test 7.3 - Duplicate generalist.**
Create a second generalist. Pass: `/agent doctor` flags it and resolver refuses
ambiguous launch.

---

## 19. Open Questions For Pi Integration

These are implementation questions, not product blockers:

- What exact command surface should the extension use in Pi?
- What is the cleanest programmatic call path into `pi-subagents` for direct
  launch, consult, parallel round-table, status, resume, and interrupt?
- Does `pi-subagents` tolerate all pi-persona metadata fields directly, or
  should `/agent doctor` constrain field shape more tightly?
- What is the exact convention for excluding `_baseline.md` from launchable
  project agents?
- Should copied runtime support roles use `package: runtime`, another package
  name, or project-specific names?
- Can `pi-subagents` pass a narrowed tool list to each child reliably in the
  active Pi version?
- Can Pi expose registered tool names for validation?
- Can Pi expose model choice to extensions?
- Can Pi load declared docs as context without granting broad doc access?
- How should direct persona session resume map onto Pi and `pi-subagents`
  resume semantics?

Answer these during the runtime dependency audit. Keep the blueprint thin until
the actual scaffold proves what is possible.
