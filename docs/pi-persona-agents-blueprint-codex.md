# Pi Persona Agents - Codex Build Blueprint

A generic persona-agent extension for Pi Coding Agent, using Pi's active chat
session for direct persona answers and `pi-subagents`/`pi-intercom` only for
peer consults, round-tables, and child-session support.

The extension turns Pi's existing coding-agent scaffold into a role-aware
workspace system. It does not replace Pi's session model, subagent runtime, tool
registry, permissions, plugin conventions, skill loading, or filesystem
behavior. It adds a thin semantic layer that assembles named role sessions from
project-level `pi-subagents` agent files, workspace docs, native
`pi-subagents` skills, and the available Pi runtime.

The intended product shape is an 80/20 base:

- The extension supplies the generic 80%: persona schema, resolver, active
  persona commands, baseline docs, consult and round-table semantics,
  validation, and conversational authoring on top of Pi, `pi-subagents`, and
  `pi-intercom`.
- The user supplies the local 20%: their actual agents, docs, skills,
  workstreams, naming conventions, and operating habits.

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

- `pi-subagents` owns child Pi sessions for consults and round-tables,
  foreground/background execution, fresh/fork context launch, parallelism,
  status, resume, interrupt, child safety, and project-level agent discovery.
- `pi-intercom` owns targeted session-to-session communication and the
  native result/progress channels that `pi-subagents` may use.

Pi Persona Agents owns:

- Persona schema.
- Roles: `generalist`, `specialist`, and `runtime`.
- Primary generalist semantics.
- Baseline-plus-agent awareness assembly.
- Docs semantics and progressive docs discovery.
- Command routing from persona commands to active persona mode.
- Consult and round-table semantics.
- Validation and setup feedback for declared docs, skills, and agent references.
- Conversational authoring of agent files.

The extension must not invent a parallel subagent system, permission system,
tool runtime, or session store. Pi remains the platform; `pi-subagents` and
`pi-intercom` are the runtime substrate; pi-persona is the role-awareness and
workflow layer on top.

`pi-subagents` owns child execution, native tools, native skills,
`reads`/`defaultReads` transport, context mode, and runtime frontmatter fields
for consult and round-table child runs. Direct persona answers run in the active
Pi chat session through prompt injection, not through a child subagent run.

---

## 2. Design Goals

- **Generic by default.** The extension ships as a reusable base, not a
  pre-baked business process.
- **No reinvented runtime.** Use required `pi-subagents` and `pi-intercom`
  mechanisms instead of building parallel child-session or communication
  machinery.
- **User-customizable.** Users can define agents, deploy docs, and select native
  `pi-subagents` skills without editing extension internals.
- **Named personas.** Users can activate role-specific personas by name.
- **Real awareness inputs.** Each persona receives doc read guidance assembled
  by Pi Persona plus native `pi-subagents` skill names selected by baseline and
  persona metadata. These are operating-context hints, not permission
  boundaries.
- **Two-tier awareness.** Shared baseline foundation plus additive per-agent
  specialization.
- **Clean handoff.** One persona command activates one role-aware persona in the
  current Pi session. Switching personas is explicit; `/persona clear` exits
  persona mode.
- **Three invocation paths.** Primary generalist, direct specialist, and round-table.
- **Mid-session consultation.** Active personas can invoke known peers through
  `persona_consult`; the tool owns the subagent execution detail.
- **Low friction.** Avoid confirmations, gates, policy prompts, and write
  restrictions unless a concrete failure mode justifies them.
- **Build first.** Acknowledge future optimization areas, but do not tune them
  before users hit real pain.

---

## 3. Core Mental Model

> An agent is a file. A resolver assembles role-aware instructions from that
> file. Direct persona commands inject those instructions into the active Pi
> session. Consult and round-table workflows reuse the same resolver, then run
> child sessions through `pi-subagents` when peer execution is actually needed.

Four moving parts:

1. **Agent files** - `.pi/agents/**/*.md`, compatible with project-level
   `pi-subagents` agent discovery, with pi-persona fields layered on top.
2. **Shared baseline** - `_baseline.md` plus shared docs and native skill names,
   merged into every resolved persona scope.
3. **Resolver** - generic assembly logic written once.
4. **Active persona adapter** - stores the active persona for the current
   session, injects its instructions before agent turns, and routes peer
   consults through `persona_consult`.

The important invariant: adding a new agent is data, not code. A user should be
able to create a new agent file, run validation, and launch it without adding a
new launcher implementation.

### Awareness, Not Restriction

No pi-persona design should act as a permission boundary by default. The package
is allowed to inform, nudge, assemble runtime fields, summarize, and guide the
agent with useful context hints. It should not deny docs, tools, agents, or
writes that Pi and the host environment would otherwise allow.

This means:

- All agents receive shared docs and native skill names from the baseline.
- Specialists additionally receive their own docs and native skill names.
- The generalist is aware of the agent roster, but is not given specialist doc
  read paths unless the user promotes those materials to the shared foundation.
- All agents are aware that other agents exist, using names, roles, and
  descriptions as consultation hints.
- Tool-use guidance is expressed through native `pi-subagents` skills; actual
  tool access remains Pi-owned.
- Friction is a necessary evil and must be justified by a concrete failure mode.

---

## 4. Runtime Dependencies And Adapter Points

The blueprint should be implemented through a small adapter over Pi,
`pi-subagents`, and `pi-intercom`. That adapter isolates package-specific calls
while keeping a single user-facing system.

Required packages for consults, round-tables, and native child-result delivery:

- `pi-subagents`
- `pi-intercom`

The extension should refuse to run consults and round-tables until the relevant
package is installed and visible to Pi. Direct persona activation should still
work when these packages are missing, with doctor reporting consult/round-table
readiness separately from direct-mode readiness.

Required Pi capabilities:

- Read project files under the active workspace.
- Register or reference tool names exposed by Pi.
- Store custom transcript entries for active persona state.
- Inject or transform the next turn's system prompt before agent start.
- Send a user message or follow-up from a command handler.
- Load `pi-subagents` project-level agent files.
- Launch `pi-subagents` child runs in fresh or fork context.
- Let `pi-subagents` and `pi-intercom` deliver child-run progress and results
  through their native runtime paths.
- Expose user-facing commands such as slash commands, command palette actions,
  or plugin actions.

Runtime contract:

- `pi-persona` agent files live in the same project-level agent surface used by
  `pi-subagents`.
- `pi-persona` should generate or maintain agent files that are valid
  `pi-subagents` project agents.
- The pi-persona resolver decides persona semantics: baseline merge, docs,
  role type, native skill selection, agent roster awareness, and round-table
  protocol.
- Active persona mode compiles `docs` into prompt-level read guidance. Consult
  and round-table child runs compile `docs` into `pi-subagents` `reads`. Users
  express document intent through `docs`, not `defaultReads`.
- Pi Persona passes `skills` through as native `pi-subagents` skill names for
  child runs and names them in active persona instructions for direct mode. It
  does not define a separate skill-breadcrumb runtime.
- `pi-subagents` executes the resolved consult and round-table child runs.
- Pi Persona does not use `pi-intercom` as its semantic consult protocol. Child
  progress and result UI remain owned by the native `pi-subagents` runtime.
- Pi Persona does not hard-enforce doc, skill, or tool boundaries. Pi,
  `pi-subagents`, and the host filesystem own access. Pi Persona provides
  semantic routing and setup guidance that nudge the agent toward the intended
  operating context.

Non-goal: building a second agent platform beside Pi. DRY, SOC, and KISS apply:
reuse proven `pi-subagents` and `pi-intercom` mechanisms, keep pi-persona as a
higher-value semantic layer, and avoid duplicate runtime machinery.

---

## 5. File And Directory Layout

```text
.pi/
  agents/
    _baseline.md              # pi-persona baseline; excluded from subagent runs
    generalist.md             # primary generalist
    backup-generalist.md      # optional non-primary generalist/draft
    brand-strategist.md       # specialist
    launch-reviewer.md        # specialist
    guideline-reviewer.md     # specialist
    secretary.md              # specialist
    docs-librarian.md         # specialist
    runtime/
      worker.md               # copied/adapted pi-subagents builtin, package: runtime
      reviewer.md             # copied/adapted pi-subagents builtin, package: runtime
      oracle.md               # copied/adapted pi-subagents builtin, package: runtime
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
frontmatter fields such as `role`, `docs`, `skills`, and `primary`, but
`/persona doctor` must verify that the resulting files remain compatible with
`pi-subagents` discovery.

Files prefixed with `_`, such as `_baseline.md`, are pi-persona control files,
not launchable agents.

Runtime support roles from `pi-subagents` should be copied into the project
when the project wants to pin or adapt them. Prefer copied files with provenance
metadata over symlinks for repo portability. Symlinks are acceptable for local
experimentation, but committed project behavior should not depend on machine-
specific npm package paths.

**Awareness rule:** a doc or skill becomes shared by living in `_baseline.md`,
`docs/shared/`, or the baseline `skills` list. A specialist becomes specialized
by declaring its own docs and native `pi-subagents` skill names. The generalist
receives shared foundations and the agent roster, but it is not given
specialist document read paths unless the user deliberately puts those materials
in the shared foundation. This is a prompting and runtime-field assembly rule,
not an access restriction; a Pi session can still discover files and tools
through normal Pi permissions.

**Writes:** inherited from Pi and the host filesystem. The extension does not
model per-agent write access by default.

**Primary generalist constraint:** multiple files may have `role: generalist`,
but exactly one launchable generalist must be selected with `primary: true`.
Additional generalists are allowed as drafts, backups, or directly launched
named agents when they use `primary: false`. Primary selection is for
role-based routing and round-table moderation; it is not a write guardrail.

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
docs: docs/workstreams/brand/
skills: market-research, brand-review
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
primary: true
description: Domain-aware generalist. Routes to specialists or answers directly.
model: default
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
docs: docs/shared/
skills: safe-bash
---
Shared operating principles and baseline instructions injected into every
persona session.
```

Required fields for persona agents:

- `name` - command-safe unique name.
- `role` - `generalist` or `specialist`.
- `primary` - required only for `role: generalist`; one and only one generalist
  should have `primary: true`, later generalists should use `primary: false`.
- `description` - short natural-language routing hint.

Recommended user-facing fields:

- `docs` - pi-persona doc paths relative to the workspace root. These inform
  what should be provided as `pi-subagents` `reads`; they do not restrict
  discovery. File paths are exact read paths. Directory paths use progressive
  discovery: only first-layer files, especially `_index.md`, are included in
  `reads` by default.
- `skills` - native `pi-subagents` skill names, such as `safe-bash` or
  `chrome-devtools`. These select skills in the runtime substrate; they are not
  file paths and pi-persona does not define a separate skill-breadcrumb layer.

Control and runtime files:

- `_baseline.md` is pi-persona control data and is not launchable.
- Copied runtime support roles may use `role: runtime`; they are launchable
  through `pi-subagents` but excluded from generalist routing and round-table
  selection unless the user explicitly invokes them.
- `primary: true` is only valid for `role: generalist`; specialists should omit
  the field.

Adapter-derived runtime fields:

- `docs` is the authoritative user-facing doc field.
- `skills` is the native `pi-subagents` skill-name field.
- The resolver derives `pi-subagents` runtime read fields such as `reads` or
  `defaultReads` from
  `docs`; users should not maintain both. If a declared doc path is a directory,
  the resolver expands only first-layer files, with `_index.md` first when
  present, into concrete workspace file paths for runtime reads. Nested files
  are deliberately deferred and surfaced as progressive-discovery material in
  the child prompt.
- The resolver passes `skills` through as native `pi-subagents` skills. It must
  not expand skill folders into reads, inject `skills.md`, or translate `skills`
  into a tool allowlist.
- Runtime details such as `systemPromptMode`, `inheritProjectContext`, and
  `inheritSkills` belong in the adapter defaults unless an advanced project
  deliberately overrides them.
- Advanced `pi-subagents` fields such as `fallbackModels`, `thinking`,
  `extensions`, and `maxSubagentDepth` may be supported, but they should not be
  required for ordinary persona authoring.

Legacy fields:

- `tools` is deprecated in pi-persona metadata. Actual tool registration and
  permission remain Pi concerns; pi-persona should express tool-use guidance
  through native `pi-subagents` skills where appropriate.
- `consults` is deprecated. Agents should learn who to consult from the roster
  of agent names and descriptions, not from an allowlist.
- `tags` is optional legacy metadata. Prefer concise, high-signal
  descriptions; routing can inspect tags when present, but tags should not be
  required for useful agents.

Optional fields:

- `model` - only honored if Pi exposes model choice to the extension.
- `owner` - human owner or team.
- `version` - user-maintained schema/content version.

---

## 7. The Remaining 20%: User Setup Path

The blueprint must explicitly support how a user turns the generic extension
into their local operating layer. The setup path has four parts: required
runtime packages, project initialization, agents, docs, and skills.

### 7.0 Installing Runtime Dependencies

Pi Persona consult and round-table workflows require:

- `pi-subagents`
- `pi-intercom`

The setup path should install or verify both packages through Pi's normal
package ecosystem. `/persona doctor` should report actionable readiness
warnings if either package is missing, disabled, or not visible to the active
Pi session; direct persona mode still works without these child-runtime
packages.

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

### 7.1 Project Initialization

`/persona init` creates the minimal usable project layer without inventing a
business-specific agent set:

- `.pi/agents/_baseline.md`
- `.pi/agents/generalist.md` with `role: generalist` and `primary: true`
- `docs/shared/_index.md`

The command should preserve existing files and report what it created versus
what it left alone. It is setup assistance, not a policy gate. Users still add
their real operating layer through `/persona new`, direct file edits, or
conversational authoring.

Manifest-backed init is the richer setup layer. The target flow is:

```text
/persona init draft --out init-data/business-operating-layer.yaml
/persona init --plan --from init-data/business-operating-layer.yaml
/persona init --from init-data/business-operating-layer.yaml
/persona init status --from init-data/business-operating-layer.yaml
/persona doctor
/persona-list
```

The split is deliberate:

- `/persona init draft` writes a starter YAML manifest. The agentic authoring
  aid is optional and happens against that manifest: the user can ask Pi to
  revise the YAML, propose agents/docs/native skill names, and then review the
  file before applying it.
- `/persona init --from <file>` is mechanical. It parses YAML, validates it,
  writes files, preserves existing content unless an explicit overwrite mode is
  added, and makes no creative decisions.
- `/persona init --plan --from <file>` is a dry run. It shows what would be
  created, preserved, warned, or rejected.
- `/persona init status --from <file>` is a progress checklist derived from the
  manifest and filesystem. It should not create a separate state database.

The manifest's required fields are intentionally small:

```yaml
version: 1
project:
  name: business-operating-layer

baseline:
  prompt: |
    Shared operating principles for every persona.
  docs:
    - docs/shared/
  skills: []

agents:
  - name: generalist
    role: generalist
    primary: true
    description: Routes requests and synthesizes specialist input.
    prompt: |
      Answer directly when shared context is enough.
      Consult specialists when the request clearly needs them.
```

Required contents:

- `version`.
- `project.name`.
- `baseline.prompt`.
- `agents`.
- Each agent has `name`, `role`, `description`, and `prompt`.
- Exactly one `role: generalist` agent has `primary: true`.

Optional contents:

- `baseline.docs` and `baseline.skills`.
- Top-level `docs.files`, mapping workspace paths to initial file content.
- Agent `docs`, `skills`, `model`, and `primary`.
- Agent-specific initial doc files under `docs.files`.

Skills in the manifest are native `pi-subagents` skill names. They are not
paths. The manifest should not contain `tools`, `defaultReads`, or path-style
skill entries such as `.pi/skills/workstreams/brand/`.

The progress checklist should be plain and actionable:

```text
Pi Persona Init Status

[done] dependencies installed
[done] baseline exists
[done] primary generalist exists
[todo] missing docs/workstreams/research/_index.md
[warn] skill researcher not confirmed by doctor
[next] run /persona index --all
```

### 7.2 Defining Agents

Users should be able to define agents in three ways:

1. **Conversational authoring.** In a normal Pi session, the user says what role
   they want. The `agent-authoring` skill writes or edits the agent file.
2. **Scaffold command.** `/persona new <name>` creates a minimal valid agent file.
3. **Manual editing.** The user edits `.pi/agents/<name>.md` directly.

Agent files must remain launchable through `pi-subagents`. Pi Persona may add
semantic fields, but it should not create a second agent registry.

`/persona new <name>` should scaffold only the user-facing fields:

- `name`
- `role`
- `primary` for generalist agents
- `description`
- `docs`
- `skills`
- prompt body

Runtime adapter fields stay out of the scaffold unless the user explicitly asks
for an advanced override. Direct persona mode does not require a
`.pi/settings.json` `tools: ["subagent"]` override because peer consults are
owned by the top-level `persona_consult` tool, not by every child persona.

When `/persona new <name> --role generalist` creates the first generalist, it
should write `primary: true`. When a generalist already exists, it should still
create the new file with `primary: false` and emit an immediate warning: one
and only one generalist must be set to `primary: true` before
primary-generalist routing and round-table moderation can run. Creation remains
low-friction; the readiness gate is `/persona doctor` plus runtime commands
that need a primary generalist.

The authoring flow should ask only for missing essentials:

- Agent name.
- Role purpose.
- Docs/workstreams it should read.
- Native `pi-subagents` skill names that explain relevant tool use or workflows.

Everything else gets a conservative default. The user can refine the agent over
time by editing the file or asking Pi to edit it. The authoring flow should not
ask users to set `pi-subagents` compatibility fields unless they are making an
advanced runtime override.

### 7.3 Deploying Docs

Docs should be ordinary workspace files. The extension should not require a
separate knowledge-base product, special file format, or mandatory indexing
step.

Recommended pattern:

- Put universal references in `docs/shared/`.
- Put agent-specific references in `docs/workstreams/<domain>/`.
- Reference those paths in `_baseline.md` or the relevant agent file.
- Add `_index.md` to any docs directory that contains nested material.
- Run `/persona doctor` to confirm paths exist and are readable by Pi.

Document deployment is intentionally file-native. Users can use git, sync
folders, shared drives, generated markdown, PDFs, or whatever Pi can already
read. Pi Persona Agents only loads or references the paths declared in agent
files.

Directory paths use a progressive-discovery pattern:

- The resolver includes only the first layer of files in the declared directory
  in runtime reads.
- `_index.md` is treated as the navigation catalogue and is ordered first when
  present.
- Nested files are not included recursively in runtime reads. The agent should
  read `_index.md` first, then deliberately open deeper files only when the task
  needs them.
- The child prompt notes when nested files were deferred, so absence from
  runtime reads is visible rather than mysterious.

This keeps directory docs ergonomic without turning every workstream folder
into an accidental context dump. It also matches how a human consultant would
work: receive the folder brief or catalogue first, then pull precise files as
needed.

Indexing should stay boring and file-native. `/persona index <docs-dir>` writes
or refreshes a managed catalogue block inside `<docs-dir>/_index.md` by crawling
the tree. `/persona index --all` refreshes all declared doc directories. Human
or agent-authored annotations should live outside the managed block and are
preserved. Agentic summarization can be added later if users need richer
catalogue notes; the baseline mechanism is deterministic tree crawl plus
editable markdown.

### 7.4 Setting Up And Deploying Skills

Skills are native `pi-subagents` skills. Pi Persona does not create its own
skill-breadcrumb system and does not treat skill entries as paths. Skills make
workflows and tool-use habits available through the existing runtime substrate;
they do not grant or deny tool access by themselves.

Recommended pattern:

- Install or enable real tools through Pi's normal ecosystem.
- Use native `pi-subagents` skill names in `_baseline.md` for shared skills.
- Use native `pi-subagents` skill names in specialist agent files for
  specialist behavior.
- Run `/persona doctor` to catch path-style skill misuse such as
  `.pi/skills/workstreams/brand/`.

If Pi or `pi-subagents` supports project-local native skills, users should
register those skills through the native package mechanism and reference them by
name. Pi Persona should not index skill folders, inject `skills.md`, or maintain
a second skill registry.

---

## 8. Resolver

```text
function assemble(agentName):
    base  = parse(".pi/agents/_baseline.md")
    agent = parse(".pi/agents/<agentName>.md")
    validate(base, agent)

    docs      = unique(base.docs + agent.docs)
    skills    = unique(base.skills + agent.skills)
    roster    = summarizeAgentsByNameRoleDescription()
    prompt    = base.body + "\n\n" + roster + "\n\n" + agent.body
    model    = agent.model ?? base.model ?? piDefaultModel
    runtime  = deriveSubagentRuntime(agent, docs, skills)

    return subagentRunSpec({
      agent: agent.name,
      docs,
      skills,
      prompt,
      model,
      reads: runtime.reads,
      skill: runtime.skills,
      systemPromptMode: runtime.systemPromptMode,
      inheritProjectContext: runtime.inheritProjectContext,
      inheritSkills: runtime.inheritSkills
    })
```

The resolver is the single assembly machine for:

- Direct specialist launch.
- Primary generalist launch.
- Specialist consult.
- Round-table participant launch.

For docs directories, `deriveSubagentRuntime` applies progressive discovery
instead of recursive read expansion. It resolves:

- top-level files in the declared directory;
- `_index.md` first, when present;
- a manifest note that nested files exist but were deliberately omitted from
  `reads`.

The agent can still read deeper files through normal Pi capabilities when the
task calls for it. Pi Persona should not hide those files or create a new access
control layer; it should simply avoid adding the entire tree to runtime reads by
accident.
- Agent validation previews.

The resolver should be strict about file schema and path existence. It should be
minimal about policy. It assembles what the user declared; it does not second
guess the user's write permissions or tool permissions.

The resolver owns awareness assembly. `pi-subagents` owns execution. A
deliberate forked consult may carry requester conversation context, but it must
not automatically inherit requester docs or skills unless those are also part of
the consultant's own resolved awareness package. This is not a security claim;
it is the intended prompt, read-path, and native-skill shape.

---

## 9. Invocation Model

### Tier 1 - Primary Generalist: `/<primary-generalist-name>`

Activates the primary generalist in the current Pi session, usually
`/generalist` when the agent is named `generalist`. If the command includes a
query, Pi answers that query as the generalist. Follow-up user messages keep the
generalist active until another persona command switches personas or
`/persona clear` exits persona mode. The primary generalist answers directly
when shared context is enough and consults specialists only when the task
clearly needs a specialist perspective.

### Tier 2 - Direct Specialist: `/<specialist-name>`

Activates a role-aware specialist in the current Pi session, such as
`/brand-strategist` or `/launch-reviewer`. If the command includes a query, Pi
answers that query as the specialist. Follow-up user messages keep the
specialist active until another persona command switches personas or
`/persona clear` exits persona mode.

The specialist can consult known peers from the agent roster. Consulted agents
receive a summarized/fresh consult by default, and their awareness package is
assembled from their own files. The requester may deliberately choose forked
context in the consult envelope when the consultant needs the full conversation
history.

### Tier 3 - Round-table: `/persona-roundtable <query>`

The primary generalist selects up to five relevant specialists and convenes
them into a short Delphi-style process. This is an explicit multi-persona
workflow and may use `pi-subagents` internally.

### Discovery: `/persona-list`

Lists the primary generalist, any non-primary generalists, and all specialists.
It is read-only and does not launch anything. The list should show each
persona's role, primary status where relevant, description, docs, and skills.
Users activate agents directly with `/<agent-name>`.

### Persona State: `/persona status` and `/persona clear`

`/persona status` shows the active persona for the current Pi session.
`/persona clear` exits persona mode and returns the session to normal Pi
behavior. Persona state is stored in the transcript so resumed sessions restore
the latest selected persona.

### Persona State In The Footer

Pi Persona publishes the active persona through Pi's extension status API with
the stable status key `pi-persona-active`. When no persona is active, the key is
cleared. When a persona is active, the value is compact status text such as
`persona /generalist`.

This makes the state visible to Pi status surfaces without coupling Pi Persona
to a specific footer implementation. With `npm:pi-powerline-footer`, users can
promote the status key into a dedicated powerline item through
`powerline.customItems`:

```json
{
  "powerline": {
    "preset": "default",
    "customItems": [
      {
        "id": "persona",
        "statusKey": "pi-persona-active",
        "position": "secondary",
        "color": "accent"
      }
    ]
  }
}
```

Pi Persona should not rewrite user footer settings automatically. Footer
placement is a user preference; the extension's contract is the stable status
key and timely updates on session start, persona switch, persona clear,
`/persona status`, and agent turns.

### Setup Helper: `/persona init`

Creates the minimal baseline, primary generalist, and shared docs index for an
empty project. It preserves existing files and leaves real specialist content to
the user.

Manifest-backed variants support richer setup:

- `/persona init draft --out <file>` for a starter manifest that can be edited
  directly or revised with optional agentic help.
- `/persona init --plan --from <file>` for a dry-run checklist.
- `/persona init --from <file>` for deterministic file creation.
- `/persona init status --from <file>` for progress and next-step reporting.

### Docs Catalogue Helper: `/persona index [docs-dir]`

Refreshes `_index.md` for one docs directory, or all declared docs directories
when called with `--all` or no path. This is setup assistance only. It should
not launch an agent and should not create a second docs system.

Direct persona commands do not launch a child subagent. They activate persistent
persona mode in the current Pi session by injecting the resolved persona
instructions before agent turns. Agent-to-agent consults use fresh child context
by default, seeded with a consult envelope and summary. Context forking is a
deliberate consult option for cases that genuinely need the full history.

### Current Direction - Active Persona And Consult Boundary

These decisions supersede earlier Phase 4/7/8 proof language that treated
direct persona commands as `pi-subagents` child runs:

- Direct `/<persona> <query>` answers in the active Pi chat session.
- Direct persona mode persists across follow-up turns until `/persona clear` or
  another persona command.
- `/generalist` is registered as a bootstrap command. Before `.pi/agents`
  contains a `generalist` agent, it returns setup guidance to run
  `/persona init` instead of falling through as ordinary prompt text.
- Direct persona mode uses Pi's prompt hook for persona instructions and doc
  read guidance. It does not depend on `pi-subagents` runtime `reads` or native
  skill selection.
- `persona_consult` is the semantic consult boundary. The active persona calls
  it when peer expertise is needed; the tool executes `pi-subagents`
  internally and returns the consultant result plus compact provenance.
- Raw `subagent` guidance should not appear in direct persona prompts.
- `subagent list` lists global Pi subagents: builtins, user package agents, and
  project `.pi/agents` files. It is not the Pi Persona consultant roster.
- `persona_consult` only accepts project Pi Persona agents discovered from the
  active workspace. Global package agents can still be launched with raw
  `subagent`, but doing so bypasses Pi Persona consult semantics, active
  persona state, and provenance.
- `/persona-roundtable` remains an explicit multi-persona workflow that may use
  `pi-subagents` directly.
- When `PI_SUBAGENT_CHILD=1`, Pi Persona stays inert and does not register
  persona commands, `persona_consult`, or active-persona prompt injection. A
  child run is already executing as the selected leaf persona.
- Consult and round-table child prompts are leaf tasks. They must not call
  `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or
  `intercom`; if blocked, they report the blocker in the returned answer.

---

## 10. Consult Mechanism

An active persona can invoke another agent by name from the known agent roster
through `persona_consult`. The tool resolves the consultant, runs the consulted
agent through `pi-subagents`, and returns the consultant answer to the active
persona for synthesis.

There is no user-maintained consult allowlist. Agent descriptions are the
primary routing signal: a requester should consult the persona whose
description says it owns the needed expertise. This keeps consultation
low-friction and avoids a second configuration system that users must remember
to maintain.

Default context policy:

- Consults use summarized/fresh child context by default.
- The requester may deliberately choose forked requester context instead.
- The requesting agent writes the summary because it knows what is relevant
  from its own conversation. The tool transports the summary; it does not decide
  what matters.
- A summarized consult uses a structured consult envelope plus the requester
  agent's concise summary.
- Forked context, when selected, is reference context, not awareness-package
  inheritance.
- The consultant's prompt, docs, skills, and model are resolved from the
  consultant's own agent file plus `_baseline.md`.

The default should feel like a concise specialist handoff: enough context to act
without forcing the consultant to absorb the entire thread. Forked context is
the email-chain option: use it deliberately when the specialist cannot answer
well from the summary and envelope alone. There is no dedicated user-facing flag
for this. The requesting agent chooses the context mode in the consult envelope;
if the user wants a mode, they can say it naturally.

Summary shape should start from Pi's native summarization behavior. During the
runtime audit, inspect how Pi summarizes sessions and use that as the baseline
for summary length, artifact references, and excerpts. Add pi-persona-specific
summary rules only if actual use shows Pi's baseline is insufficient.

Every consult also includes a small consult envelope so the consultant knows
what to do with the provided context:

```yaml
consult:
  requester: brand-strategist
  consultant: guideline-reviewer
  context: fresh
  summary: "Requester-authored summary of relevant history."
  question: "What guideline risks or required edits do you see?"
  constraints:
    - "Answer from your guideline-reviewer role."
  expectedOutput:
    - risks
    - required edits
    - optional improvements
```

If the requester chooses forked context, runtime mapping is:

```yaml
consult:
  context: fork
  note: "Forward requester conversation as reference context."
```

After consults complete, the requesting agent synthesizes the answer and adds a
compact provenance footer. The user does not see the full sub-dialogue by
default.

```text
Consulted:
- guideline-reviewer (answered): "Flagged tone mismatch and required policy citation."
- docs-librarian (failed: docs/workstreams/librarian/ missing)
```

Topology:

- Default operating depth is one hop; nested consults are discouraged in direct
  persona prompts and forbidden in consult child prompts.
- Width open for parallel fan-out.
- Barrier fan-in: wait for all consults to settle.
- Independent failure: partial results are returned with explicit failures.
- No awareness-package inheritance from caller: consulted agents receive their
  own resolved docs, skills, and model by default.
- If a consulted child is blocked, it reports the blocker in its returned answer
  instead of calling supervisor/intercom tools.
- Direct persona mode does not require every persona to have a child-safe
  `subagent` tool. The top-level active persona owns normal consult decisions
  through `persona_consult`.

One-hop consults are the default operating pattern because they are easier to
debug and summarize. Pi Persona should discourage nested consults in active
persona prompts and make consult children explicit leaf workers; it should not
add a permission system just to block them. Nested consult support is not a
direct-launch requirement and should not drive scaffold or doctor requirements
by default.

---

## 11. Round-table Protocol

When the user invokes `/persona-roundtable <query>`:

### Step 0 - Convene

The primary generalist selects up to five specialists using simple relevance over
`description`, declared `docs`, and declared `skills`. Optional legacy `tags`
may be used when present, but concise descriptions should be sufficient. The
roster is shown to the user before round 1 begins.

The roster preview is visible before execution. Phase 6A keeps override manual
and minimal: the user can relaunch with a clearer query if the roster is wrong.
Later, if Pi exposes a clean non-blocking confirmation surface, the user may say
something like "drop docs-librarian, add secretary." If the user does not correct
the roster, the round-table proceeds.

This selection should be understandable, not over-engineered. Advanced routing
quality work belongs later, after users report concrete misses.

### Step 1 - Independent Positions

Each selected specialist receives the query independently through a
`pi-subagents` parallel run. By default, each specialist receives the
moderator's query-specific summary and consult envelope, not the full
requester/generalist conversation. The moderator may deliberately choose forked
context when the full conversation is needed. No specialist sees another
specialist's first response.

Forking requester context, when deliberately selected, does not violate Delphi
independence. Independence means specialists do not see peer outputs before
round 2; it does not require discarding the original request history.

### Step 2 - Reveal And Revise

All first-round positions are revealed to all selected specialists. Each
specialist revises, qualifies, reinforces, or concedes.

### Step 3 - Moderator Synthesis

The primary generalist synthesizes:

- Where specialists converged.
- Where tensions remain.
- Recommended next action.
- Any specialist failures and their impact.

The round-table is the multi-agent interaction. Specialists inside a
round-table receive leaf task instructions: do not call nested consult,
subagent, supervisor, or intercom tools; report blockers in the returned answer.

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

- Agent `description`.
- Declared `docs` paths.
- Declared `skills` paths.
- Explicit user command.
- Generalist judgment from the active query.
- Optional legacy `tags`, if present.

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

## 14. Validation: `/persona doctor`

`/persona doctor` checks only the things the extension can know cheaply and
reliably:

- `pi-subagents` is installed, enabled, and discovering project agents when
  consult or round-table workflows are expected.
- `pi-intercom` is installed, enabled, and available for native child result
  delivery when consult or round-table workflows are expected.
- Agent markdown parses.
- Required frontmatter exists.
- Agent files are compatible with `pi-subagents` project-level discovery.
- `name` values are unique.
- Exactly one primary generalist resolves for role-based routing.
- Declared doc paths exist.
- Declared doc directories with nested files have `_index.md` or receive a
  warning that points to `/persona index`.
- Declared skills look like native `pi-subagents` skill names, not file paths.
- Legacy `tools`, `consults`, and `tags` fields are reported with migration
  guidance when present.
- Copied runtime support roles include provenance metadata.
- Copied runtime support roles are checked for drift against installed
  `pi-subagents` builtins when feasible.
- Baseline merge previews look sane.

Dependency checks should run first, followed by schema, path, uniqueness,
skill-awareness, and provenance checks. It should produce actionable errors, not
policy lectures.

Examples:

- `brand-strategist: docs/workstreams/brand/ does not exist`
- `brand-strategist: skills entry looks like a path, but Pi Persona skills are native pi-subagents skill names: .pi/skills/workstreams/brand/`
- `brand-strategist: legacy field tools found; migrate tool-use guidance to native pi-subagents skills`
- `doctor: multiple primary generalist agents: generalist, backup-generalist`
- `doctor: found 0 primary generalists among 2 generalists`
- `runtime.worker: copied from pi-subagents 0.31.0; installed builtin changed`
- `dependency: pi-intercom is installed but not loaded in this Pi session`

---

## 15. Authoring Agents

The `agent-authoring` skill is the user's main path from generic base to local
customization.

It should support:

- Create a new agent from a plain-English role description.
- Edit an existing agent's docs, skills, description, primary status, or body.
- Move docs or skills between shared foundation and specialist awareness.
- Improve descriptions so requesters know who to consult.
- Run `/persona doctor` after edits.
- Preserve user wording unless cleanup is necessary.
- Preserve `pi-subagents` compatibility while adding pi-persona metadata.

The skill should not over-interview. Ask only for information needed to produce
a valid file. The user can iterate.

---

## 16. Build Order

1. **Runtime capability audit.** Confirm Pi command, transcript-entry,
   `sendUserMessage`, and `before_agent_start` hooks are available for active
   persona mode. Confirm `pi-subagents` and `pi-intercom` are available for
   consults, round-tables, and native child result delivery.
2. **Project agent surface.** Confirm `.pi/agents/**/*.md` discovery through
   `pi-subagents`, including how to exclude `_baseline.md` and how copied
   runtime roles should be named.
3. **Schema and parser.** Lock the pi-persona metadata contract while retaining
   `pi-subagents` compatibility.
4. **Resolver.** Merge baseline plus agent into active persona instructions and
   consult/round-table child run specs.
5. **Consult summary audit.** Inspect Pi's native session summary behavior and
   use it as the baseline for consult summaries.
6. **Baseline wiring.** Support `_baseline.md` and `docs/shared/`.
7. **Direct specialist activation.** Activate `/<specialist-name>` in the
   current Pi session.
8. **Doctor.** Validate dependencies, schema, docs, skills, runtime
   compatibility, copied builtin provenance, and primary-generalist uniqueness.
9. **Project init.** Add `/persona init` for the minimal baseline, primary
   generalist, and shared docs index.
10. **Conversational authoring.** Create/edit agents through Pi.
11. **Primary generalist activation.** Support direct activation of the
    configured primary generalist, usually `/generalist`.
12. **Consult mechanism.** Add `persona_consult` as the one-hop peer consult
    boundary, with summarized/fresh context by default and forked requester
    context as a deliberate envelope option.
13. **Round-table.** Add Delphi-style multi-specialist discourse through
    parallel `pi-subagents` runs.
14. **Persona list.** Add read-only `/persona-list`.
15. **Progressive docs discovery.** Include shallow directory docs in reads,
    support
    `_index.md`, and provide `/persona index` for managed catalogue refresh.
16. **Initial agent port.** Port the user's initial agent set into the
    project-level format. Generic sample agents can be extracted later for
    documentation and onboarding.

Steps 1-8 prove the runtime-backed role-aware file model.
Steps 9-11 make the system user-customizable.
Steps 12-13 add multi-agent leverage.
Step 14 improves discovery ergonomics.
Step 15 reduces directory-doc runtime friction.
Step 16 makes the user's initial operating layer real.

---

## 17. Settled Decisions

| Decision | Resolution |
|---|---|
| Product boundary | Pi extension, not separate agent platform |
| Runtime dependencies | Pi active-session hooks are required for direct persona mode; `pi-subagents` and `pi-intercom` support consults, round-tables, and native child result delivery |
| Runtime design | Reuse required packages; do not build a parallel subagent system |
| Default write policy | Inherit Pi and filesystem permissions |
| User customization | 80% generic base, 20% user-defined agents/docs/skills |
| Agent definition | Project-level `pi-subagents` markdown files with pi-persona metadata |
| Runtime support roles | Copy/adapt builtins locally with provenance; symlinks only for local experiments |
| Skill setup | Native `pi-subagents` skills; no custom Pi Persona skill-breadcrumb layer |
| Doc setup | Workspace files referenced by path |
| Docs transport | Active persona mode injects doc-read guidance; consult and round-table child runs compile `docs` to `pi-subagents` `reads` |
| Direct persona behavior | `/<agent-name> [query]` activates that persona in the current Pi session; no direct child subagent run; bootstrap `/generalist` guides users to `/persona init` before setup |
| Persona lifecycle | Another persona command switches personas; `/persona clear` exits; `/persona status` reports current state |
| Persona discovery | `/persona-list` is read-only; activate with `/<agent-name>` |
| Consult context | Summarized/fresh context by default; requester-context fork is deliberate |
| Consult summary author | Requesting agent writes the summary |
| Consult summary baseline | Use Pi native summary behavior first; add rules only if needed |
| Consult provenance | Compact footer in the requester synthesis |
| Consult awareness | Consultant awareness package resolves from consultant file plus baseline |
| Consult execution | `persona_consult` executes `pi-subagents` internally and returns the consultant result for active-persona synthesis |
| Consult topology | One-hop by default, parallel fan-out when explicitly requested, barrier fan-in through `pi-subagents` |
| Consult routing | Any known persona may be consulted; descriptions guide who to ask |
| Primary generalist | Exactly one `role: generalist` with `primary: true` |
| Round-table membership | Ad hoc, up to five specialists |
| Round-table execution | `/persona-roundtable` remains an explicit multi-persona workflow and may use `pi-subagents` directly |
| Discourse protocol | Independent, reveal/revise, synthesize |
| Child escalation | Consult and round-table children are leaf workers; blockers return in the child answer instead of supervisor/intercom calls |
| Routing | Simple first; optimize only after user-reported misses |
| Validation | Cheap structural checks through `/persona doctor` |
| Restriction policy | Inform and nudge through semantic context; do not create a permission system |

---

## 18. Test Content Strategy

Testing should verify Pi integration boundaries first, then the persona
features.

### Phase 1 - Runtime Adapter

**Test 1.1 - Required dependency audit.**
Run `/persona doctor` in a session with both packages installed and in a session
where one package is missing or disabled. Pass: both packages are detected when
present; missing or disabled `pi-subagents`/`pi-intercom` produces actionable
consult/round-table readiness guidance without blocking direct persona mode.

**Test 1.2 - Project agent discovery.**
Create a valid `.pi/agents/<name>.md` persona file. Pass: `pi-subagents`
discovers it as a project-level agent, while `_baseline.md` is not launchable.

**Test 1.3 - Native skill boundary.**
Reference native skill names and one path-style skill entry. Run
`/persona doctor`. Pass: native names are accepted as runtime skill names, while
path-style entries get actionable guidance to use native `pi-subagents` skills.

**Test 1.4 - Permission inheritance.**
Attempt writes through a persona session using normal Pi permissions. Pass:
behavior matches Pi and filesystem permissions, with no extra pi-persona write
gate.

**Test 1.5 - Runtime support role provenance.**
Copy a `pi-subagents` builtin into `.pi/agents/runtime/`. Pass: `/persona doctor`
reports provenance and, when feasible, drift against the installed builtin.

### Phase 2 - Schema, Resolver, Baseline

**Test 2.1 - Schema validation.**
Create a valid agent and malformed variants. Pass: valid file passes; malformed
files get specific errors without breaking `pi-subagents` compatibility.

**Test 2.2 - Baseline merge.**
Create a minimal specialist with one additive native skill name and one additive
doc dir. Pass: assembled runtime includes baseline plus specialist docs and
native skill names.

**Test 2.3 - No accidental specialist material.**
Assemble two specialists. Pass: the resolver emits only baseline docs plus the
selected specialist's declared docs as `reads`, and emits only baseline plus
selected specialist native skill names as `skill`.

### Phase 3 - User Setup Path

**Test 3.0 - Project init.**
Run `/persona init` in an empty project. Pass: `_baseline.md`,
`generalist.md`, and `docs/shared/_index.md` are created; running it again
preserves existing files.

**Test 3.1 - Conversational agent creation.**
Ask Pi to create a new specialist for a concrete workstream. Pass: a valid
`.pi/agents/<name>.md` file is created with description, docs, native skills, and
body.

**Test 3.2 - Minimal scaffold.**
Run `/persona new <name>`. Pass: the file contains only user-facing fields and a
prompt body; runtime adapter fields are omitted.

**Test 3.3 - Doc deployment.**
Add a file under `docs/workstreams/<domain>/`, reference it from an agent, and
run `/persona doctor`. Pass: the path validates and appears in resolver preview.

**Test 3.3a - Progressive docs catalogue.**
Add a nested file under a declared docs directory with no `_index.md`. Pass:
`/persona doctor` warns without blocking. Run `/persona index <docs-dir>`.
Pass: `_index.md` is created or refreshed, handwritten notes outside the managed
block are preserved, and the warning clears.

**Test 3.4 - Native skill selection.**
Reference a native skill name from an agent and run `/persona doctor`. Pass: no
path warning appears, and launch/consult/round-table requests pass the skill
name through to `pi-subagents` as native skill selection.

### Phase 4 - Direct Launch

**Test 4.1 - Specialist command.**
Invoke `/<specialist-name>`. Pass: the active Pi session records that specialist
as the active persona and future agent turns receive the specialist prompt,
baseline context, roster, and doc-read guidance.

**Test 4.1a - Directory docs are shallow by default.**
Declare a docs directory containing `_index.md`, a first-layer file, and a
nested file. Pass: active persona prompt guidance names `_index.md` and the
first-layer file, does not eagerly list the nested file as a direct read target,
and states that nested docs are available through progressive discovery.

**Test 4.2 - Persistent persona mode.**
Activate a specialist and send a follow-up user message. Pass: the follow-up
turn still receives that specialist's active persona instructions.

**Test 4.3 - Clear and switch.**
Run `/persona clear` and then a follow-up user message. Pass: persona
instructions are no longer injected. Activate another persona. Pass: the new
persona replaces the previous one.

### Phase 5 - Primary Generalist And Consults

**Test 5.1 - Direct primary generalist answer.**
Ask a question answerable from shared docs. Pass: the primary generalist answers
without consulting a specialist.

**Test 5.2 - Specialist consult.**
Ask a question that clearly needs a peer described in the roster. Pass: the
active persona calls `persona_consult`, the tool runs the peer through
`pi-subagents`, and the active persona receives the result for synthesis.

**Test 5.2a - Summarized/fresh default.**
Create requester context, then trigger a consult without specifying context
mode. Pass: the consultant receives the consult envelope and summary, not the
full requester conversation.

**Test 5.2b - Requester-authored summary.**
Trigger a consult from a specialist. Pass: the consult envelope contains a
summary written by the requesting agent, not by the adapter or an unrelated
generalist.

**Test 5.2c - Summary baseline.**
Compare consult summary shape to Pi's native session summary behavior. Pass:
pi-persona uses the native baseline unless a real gap is identified.

**Test 5.2d - Awareness package does not fork.**
Give the requester a specialist-only doc or skill not declared by the
consultant. Pass: the consultant receives the consultant's own doc reads and
native skills, not the requester's specialist-only context hints.

**Test 5.2e - Forked context envelope option.**
Trigger a consult where the requester chooses `context: fork` in the envelope.
Pass: the consultant receives requester conversation context as reference
context, while still using the consultant's resolved awareness package.

**Test 5.2f - Consult provenance.**
Run a consult with one success and one failure. Pass: the final requester answer
contains a compact `Consulted:` footer with consultant names, statuses, and
short summaries or failure reasons.

**Test 5.3 - Consult by description.**
Ask for a consult to a peer that is not listed in a requester-specific
allowlist. Pass: the consult can still be invoked because the roster and
description are the routing mechanism.

**Test 5.4 - Partial failure.**
Break one consulted agent's doc path. Pass: successful consults return, failure
is reported, and work continues.

**Test 5.5 - Nested consult guidance.**
Have a consulted agent attempt a nested consult. Pass: pi-persona discourages
the nested consult in active-persona instructions, forbids
`persona_consult`/raw `subagent`/`subagent list`/`contact_supervisor`/`intercom`
inside consult child instructions, and returns blockers in the child answer.
Scaffold and doctor do not require every direct persona to have child-safe
`subagent` fanout. There is no separate Pi Persona consult permission system.

**Test 5.6 - Blocked consultant.**
Have a consulted agent encounter a blocking decision. Pass: it reports the
blocker in its returned answer; routine completion still returns through
`pi-subagents`.

### Phase 6 - Round-table

**Test 6.1 - Convene roster.**
Invoke `/persona-roundtable` with a cross-functional question. Pass: the primary
generalist selects up to five plausible specialists and shows the roster.

**Test 6.2 - Roster override.**
After roster preview, ask to remove one specialist and add another. Pass: the
updated roster is used for round 1. If the user gives no correction, the
original roster proceeds.

**Test 6.3 - Independent first round.**
Pass: first-round specialist outputs may use the moderator's summary/envelope,
or deliberately forked requester context if selected, but do not reference each
other.

**Test 6.4 - Reveal and revise.**
Pass: second-round outputs react to the revealed peer positions.

**Test 6.5 - Synthesis.**
Pass: the moderator identifies convergence, unresolved tensions, and a next
action without flattening disagreement.

### Phase 7 - Integration

**Test 7.1 - Full workflow.**
Run: verify dependencies, create agent, deploy docs, deploy skills, doctor,
direct persona activation, generalist consult, round-table. Pass: each layer
works without changing extension code or choosing between two agent systems.

**Test 7.2 - Persona listing.**
Run `/persona-list`. Pass: it lists role, description, docs, and skills,
and does not launch anything.

**Test 7.3 - Add agent without breakage.**
Add a new specialist file. Pass: existing agents keep working; the new agent
appears in `/persona-list` and can be launched directly with `/<agent-name>`.

**Test 7.4 - Secondary generalist and duplicate primary.**
Create a second generalist through `/persona new`. Pass: the new file is created
with `primary: false`, the user sees an immediate warning, `/persona doctor`
still passes, and round-table continues to use the existing primary generalist.
Then manually set both generalists to `primary: true`. Pass: `/persona doctor`
flags multiple primary generalists and round-table refuses ambiguous moderation
until one and only one generalist is set to `primary: true`.

---

## 19. Open Questions For Pi Integration

These are implementation questions, not product blockers:

- What exact command surface should the extension use in Pi?
- What is the cleanest programmatic call path into `pi-subagents` for consult,
  parallel round-table, status, resume, and interrupt?
- Does `pi-subagents` tolerate all pi-persona metadata fields directly, or
  should `/persona doctor` constrain field shape more tightly?
- What is the exact convention for excluding `_baseline.md` from launchable
  project agents?
- Should copied runtime support roles use `package: runtime`, another package
  name, or project-specific names?
- How does Pi summarize session context, and what summary length/artifact
  behavior should pi-persona inherit before adding its own rules?
- Can Pi expose registered tool names for informational skill authoring without
  turning pi-persona into a tool policy layer?
- Can Pi expose model choice to extensions?
- Can Pi load declared docs as context without granting broad doc access?
- Can Pi expose parent-chat runtime `reads` or native skill selection to
  extensions, or should active persona mode remain prompt-injection based?

Answer these during the runtime dependency audit. Keep the blueprint thin until
the actual scaffold proves what is possible.
