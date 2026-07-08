# Onboarding Authoring Design

Date: 2026-07-08

## Goal

Close the onboarding gap by making first-time Pi Persona setup feel guided while
keeping the system file-native and reviewable.

The product shape is:

```text
conversation produces files
commands validate files
runtime consumes files
```

This keeps Pi Persona out of the business of hidden setup state, custom
databases, and wizard orchestration. The extension already has the right
mechanical primitives: `/persona init`, manifest-backed init, `/persona new`,
`/persona index`, `/persona doctor`, and `/persona-list`. The missing piece is a
documented authoring path that tells the assistant how to help the user create
or revise the setup files.

## Decision

Use guided manifest authoring as the primary onboarding path.

Do not add an interactive `/persona setup` wizard for this phase. A wizard would
need progress state, resume behavior, correction flows, and another validation
surface. The manifest flow already provides all durable state in ordinary files.

`/persona init draft --out <file>` is the handoff into agent-assisted setup. It
should not leave a clueless user with "review or edit the YAML" as the next
step. The command creates the manifest draft and then starts an assisted
interview in the active Pi session.

The authoring layer should ask only for information that materially changes the
persona layer, edit the YAML manifest or direct project files for the user, and
then run the existing validation commands.

## User Flow

### Fresh Project

1. User runs `/generalist` or `/persona doctor`.
2. If no persona project exists, the user is guided to initialize:

   ```text
   /persona init draft --out init-data/my-operating-layer.yaml
   ```

3. The command starts an agentic setup interview in the Pi session.
4. The assistant treats the user as new and asks one question at a time.
5. The assistant edits `init-data/my-operating-layer.yaml` for the user as
   answers arrive.
6. The assistant previews the result:

   ```text
   /persona init --plan --from init-data/my-operating-layer.yaml
   ```

7. The assistant summarizes the plan and asks before applying.
8. User approves, then the assistant applies the manifest:

   ```text
   /persona init --from init-data/my-operating-layer.yaml
   ```

9. The assistant completes readiness:

   ```text
   /persona init status --from init-data/my-operating-layer.yaml
   /persona index --all
   /persona doctor
   /persona-list
   ```

10. User activates a persona:

   ```text
   /generalist
   /operator
   /brand
   ```

### Existing Project

For a project that already has `.pi/agents` or docs, the assistant should not
force manifest re-application. It may still use a manifest as a planning artifact
when the user is adding several personas at once, but small changes should edit
the target `.pi/agents/*.md` and docs directly, then run `/persona doctor`.

## Components

### Authoring Guide

Permanent documentation that defines the assistant behavior for onboarding:

- Explain when to use manifest-backed setup versus direct file edits.
- Give the short interview questions.
- Define what the assistant may infer and what it must not invent.
- Require the assistant to edit the manifest for the user.
- Forbid ending draft setup by telling the user to manually review or edit YAML.
- Require `/persona init --plan` before applying a new manifest.
- Require `/persona doctor` after applying or editing project files.

This can start as a docs file. It does not need a new runtime module.

### Draft Authoring Handoff

Existing command path: `/persona init draft --out <file>`.

Responsibilities:

- Create the starter manifest.
- Show a visible report that an assisted setup interview is starting.
- Send a follow-up user message into the Pi session that asks the agent to help
  shape the manifest.
- Instruct the agent to treat the user as new, ask one question at a time, edit
  the YAML directly, run `/persona init --plan`, summarize the plan, and ask
  before applying.

This is the agentic support layer. It is deliberately small: the active Pi
session owns the interview; the manifest remains the durable working artifact.

### Manifest Primitives

Existing module: `src/persona/init-manifest.js`.

Responsibilities:

- Create starter manifests.
- Parse and validate manifest YAML.
- Plan file creation.
- Apply missing files without overwriting existing content.
- Report status from the manifest and filesystem.

The authoring guide depends on these commands but does not duplicate them.

### Scaffold Primitives

Existing module: `src/persona/scaffold.js`.

Responsibilities:

- Create minimal project scaffolds with `/persona init`.
- Create one agent with `/persona new`.
- Keep scaffold output limited to user-facing fields.

The authoring guide should prefer `/persona new` for single-agent additions and
manifest init for multi-agent setup.

### Validation

Existing module: `src/persona/doctor.js`.

Responsibilities:

- Report dependency readiness.
- Require exactly one effective primary generalist.
- Validate docs paths and workspace boundaries.
- Warn on nested docs without `_index.md`.
- Warn on path-style skills and legacy `tools`, `consults`, and `tags`.

Onboarding should treat doctor as the readiness gate. It should not create a
second validation system.

### Docs Indexing

Existing module: `src/persona/doc-index.js`.

Responsibilities:

- Create or refresh `_index.md` files for declared docs directories.
- Preserve user-written notes outside the generated block.

Onboarding should call `/persona index --all` when manifest status reports docs
index tasks.

### Runtime Consumers

Existing modules: `src/persona/resolver.js`, `src/persona/launch.js`,
`src/persona/consult.js`, and `src/persona/roundtable.js`.

Responsibilities:

- Consume finalized `.pi/agents/*.md` and docs.
- Resolve baseline-plus-agent awareness.
- Run active persona mode, consults, and round-tables.

Runtime modules should not know whether files came from a manifest, `/persona
new`, manual editing, or assistant authoring.

## Artifacts

### Permanent

- `.pi/agents/_baseline.md`
- `.pi/agents/<agent>.md`
- `docs/shared/**`
- `docs/workstreams/<name>/**`
- `docs/**/_index.md`
- `init-data/<layer>.yaml` when used as setup provenance
- onboarding authoring documentation

Permanent artifacts are committed project files and are the only artifacts the
runtime should consume.

### Temporary

- Chat interview notes.
- `/persona init --plan` output.
- `/persona init status` output.
- `/persona doctor` output.
- `/persona-list` output.
- Resolver or launch previews.
- Active persona session state.

Temporary artifacts guide setup but should not be treated as source of truth.

### Transitional

`init-data/<layer>.yaml` starts as a draft setup input. After apply, it becomes
optional provenance. The default should be to keep it because it records the
intended operating layer and supports reruns that preserve existing files.

During draft authoring, the manifest is not homework for the user. It is the
assistant's working file. The user answers product and workflow questions; the
assistant updates the YAML.

## Authoring Rules

Ask only for the essentials:

- Workspace purpose.
- Generalist responsibility.
- Specialist names and responsibilities.
- Existing or desired docs/workstream paths.
- Native `pi-subagents` skill names, when the user already knows them.

The first assistant turn after `/persona init draft --out <file>` should not ask
the user to inspect YAML. It should start with the workspace purpose and desired
help, then proceed one question at a time.

Do not invent:

- Secrets.
- Private business facts.
- Unsupported skill names.
- Runtime-only fields such as `defaultReads`, `systemPromptMode`,
  `inheritSkills`, or `inheritProjectContext`.
- Legacy `tools`, `consults`, or `tags` metadata.

Prefer conservative defaults:

- One primary `generalist`.
- Small specialists with clear descriptions.
- Shared facts in `baseline` or `docs/shared/`.
- Specialist facts in `docs/workstreams/<name>/`.
- `_index.md` for docs directories with nested material.

## Error Handling

- If manifest validation fails, fix the YAML and rerun `/persona init --plan`.
- If apply preserves existing files, tell the user which files were preserved and
  edit them directly if changes are needed.
- If doctor reports missing docs, create the docs or remove stale references.
- If doctor warns about path-style skills, replace them with native
  `pi-subagents` skill names or leave them intentionally with the warning.
- If runtime packages are missing or unconfigured, direct persona mode may still
  work, but consults and round-tables should remain blocked by runtime preflight.

## Testing Strategy

Add or maintain focused tests for:

- The onboarding guide references current command syntax.
- `/persona init draft --out <file>` sends an agentic authoring prompt after
  creating the starter manifest.
- The draft report says an assisted setup interview is starting and does not say
  "review or edit the YAML" as the user's next responsibility.
- Manifest draft, plan, apply, and status remain the canonical multi-agent setup
  path.
- `/persona new` remains the canonical single-agent setup path.
- No onboarding path writes `.pi/settings.json` runtime overrides.
- Doctor remains the only readiness gate for docs, primary generalist state,
  dependency warnings, legacy metadata, and skill path warnings.

Existing full workflow tests should continue to prove setup, list, doctor,
direct launch, consult, round-table, and add-agent composition.

## Non-Goals

- No `/persona setup` wizard in this phase.
- No hidden onboarding state file.
- No setup database.
- No second agent registry.
- No new validation layer outside `/persona doctor`.
- No automatic runtime package install.
- No attempt to migrate all historical docs in this phase.

## Implementation Slice

The first implementation slice should be small:

1. Change `/persona init draft --out <file>` to start an agentic authoring
   prompt after creating the manifest.
2. Add onboarding authoring documentation.
3. Link it from the blueprint and init-data README.
4. Update stale setup-ergonomics references that still mention legacy
   `--tools`, `--consults`, or `--tags` as current onboarding metadata.
5. Add tests that pin the current onboarding command contract.
6. Run `npm test`.
