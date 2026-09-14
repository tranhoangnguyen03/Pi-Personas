# Pi Persona Init Data

This directory documents the setup files used by Pi Persona. Most users do not
need to edit these files directly.

## Guided Onboarding

Open Pi from the project you want to configure, then run:

```text
/persona onboard
```

Pi Persona starts a setup interview, asks one question at a time, and builds a
persona team for this project. You answer questions about the workspace and the
help you want; the assistant handles the setup file.

The default file is `init-data/my-operating-layer.yaml`. It is a durable,
reviewable record of the intended setup, not hidden runtime state. Its filename
is not part of the interview.

When the draft is ready, the assistant previews the plan, asks for explicit
approval, applies it, builds declared docs indexes, runs doctor verification,
lists the available personas, and activates the primary generalist.
If doctor finds errors after files are applied, onboarding reports **Applied —
Needs Attention** and leaves the files in place for correction; it does not
claim the apply was rolled back.

The command is safe to rerun:

- If the draft exists but setup is incomplete, onboarding resumes from it.
- If personas already exist, Pi Persona reports the current roster instead of
  overwriting files.

Choose another manifest path only when needed:

```text
/persona onboard --out init-data/team-operating-layer.yaml
```

For a minimal baseline and generalist without guided setup, run:

```text
/persona quick-start
```

`/persona init` remains an alias for `/persona onboard`.

## Advanced Manual Flow

The rest of this document is for users who want direct control over the setup
manifest. Guided onboarding uses the equivalent `persona_init` tool.
Advanced users can still control each stage directly:

```text
/persona init draft --out init-data/my-operating-layer.yaml
/persona init --plan --from init-data/my-operating-layer.yaml
/persona init --from init-data/my-operating-layer.yaml
/persona init status --from init-data/my-operating-layer.yaml
```

Manual slash-command apply does not run doctor automatically, so follow it with:

```text
/persona doctor
```

Apply creates missing files and preserves files that already exist. It is safe
to rerun after editing the manifest, but it does not overwrite existing agent
or docs files.

## Manifest Fields

If you use assisted setup, the assistant edits these fields for you:

- `project.name`: short, stable human-readable setup name.
- `baseline.docs`: shared docs or docs directories.
- `baseline.skills`: Pi skill names available in the parent session.
- `baseline.prompt`: shared operating instructions.
- `docs.files`: workspace paths and starter file contents.
- `agents`: launchable generalists and specialists.

Each agent needs:

- `name`: command-safe lowercase name, such as `generalist` or `content-writer`.
- `role`: `generalist` or `specialist`.
- `primary: true`: exactly one generalist must have this.
- `description`: concise routing description.
- `docs`: that persona's docs or docs directories.
- `skills`: Pi skill names available in the parent session.
- `prompt`: persona-specific operating instructions.

When the native backend is selected (explicitly, or by default when
`pi-subagents` is not installed), baseline and agent `tools` combine into one
allowlist. Omit `tools` for the read-only default (`read`, `grep`, `find`,
`ls`), or name any Pi built-in tools the persona needs. Loaded skills,
model/auth availability, and tool names are checked when used. Native children
inherit the parent environment and filesystem permissions and are not an OS
sandbox.

## Editing Rules

- Keep paths inside the physical workspace; symlink escapes are rejected.
- Use relative paths, not absolute paths.
- Use names beginning with a lowercase letter and containing only lowercase
  letters, numbers, or hyphens.
- Keep exactly one primary generalist.
- Put shared facts in `baseline` or shared docs.
- Put specialist facts in specialist docs and prompts.
- Use native skill names only; do not put filesystem paths in `skills`.
- Resolve every starter placeholder before planning or applying.
