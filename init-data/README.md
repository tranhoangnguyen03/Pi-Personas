# Pi Persona Init Data

This directory holds YAML manifests for bootstrapping a Pi Persona project.
These files are durable setup inputs, not generated runtime state.

New users should start with the assisted draft command:

```text
/persona init draft --out init-data/my-operating-layer.yaml
```

The command creates a starter manifest and starts an agentic setup interview in
the Pi session. Answer the questions in chat; the assistant should edit the YAML
for you, call `persona_init` to preview the result, ask for explicit approval,
and only then apply it with `confirmed: true`. Apply includes a doctor report so
schema or runtime failures cannot be mistaken for successful onboarding.

Advanced users can still copy `_template.yaml` by hand when they already know
the exact operating layer they want.

## Manual Command Flow

The assistant uses the equivalent `persona_init` tool during guided setup.
Advanced users can run these slash commands directly.

Create a working draft and start the assisted setup interview:

```text
/persona init draft --out init-data/my-operating-layer.yaml
```

Preview what the manifest would create:

```text
/persona init --plan --from init-data/my-operating-layer.yaml
```

Apply the manifest:

```text
/persona init --from init-data/my-operating-layer.yaml
```

Check setup progress after applying:

```text
/persona init status --from init-data/my-operating-layer.yaml
```

Validate the resulting persona project:

```text
/persona doctor
```

The apply command creates missing files and preserves files that already exist.
It should be safe to rerun after editing the manifest, but it will not overwrite
existing agent or docs files.

## What To Edit

If you are using assisted setup, these fields are what the assistant edits for
you. You do not need to know the YAML structure before starting.

`project.name` is a human-readable setup name. Use a short, stable name.

`baseline` defines shared context for every persona:

- `baseline.docs` lists shared docs or docs directories.
- `baseline.skills` lists native `pi-subagents` skill names.
- `baseline.prompt` is the shared operating prompt.

`docs.files` maps workspace paths to initial file contents. Use it for starter
docs that should be created with the persona layer, such as shared context,
workstream briefs, and `_index.md` files.

`agents` defines launchable personas. Each agent needs:

- `name`: command-safe lowercase name, such as `generalist` or `content-writer`.
- `role`: `generalist` or `specialist`.
- `primary: true`: exactly one generalist must have this.
- `description`: the routing description used by the active persona.
- `docs`: docs or docs directories for that persona.
- `skills`: native `pi-subagents` skill names.
- `prompt`: the persona-specific operating instructions.

## Editing Rules

- Keep paths inside the physical workspace; symlink escapes are rejected.
- Use relative paths, not absolute paths.
- Use command-safe agent names beginning with a lowercase letter, followed by
  lowercase letters, numbers, or hyphens.
- Keep exactly one primary generalist.
- Put shared facts in `baseline` or shared docs.
- Put specialist-specific facts in that specialist's docs and prompt.
- Use native skill names only; do not put filesystem paths in `skills`.
- Prefer docs directories with `_index.md` files for anything larger than one
  short note.

## Guidance For AI Assistants

When helping edit these manifests:

- Preserve the YAML structure and `version: 1`.
- Treat the user as new to Pi Persona; do not ask them to manually edit YAML.
- Ask one question at a time and edit the manifest for the user.
- Ask only for missing facts that materially change the persona layer.
- Keep the template copy editable by humans.
- Do not invent secrets, private business facts, or unsupported skills.
- Prefer small, named specialists with clear routing descriptions.
- Keep generated docs concise enough that the user can review them.
- Call `persona_init` with `action: plan` before applying.
- Summarize the plan and ask for explicit approval.
- Only after approval, call `persona_init` with `action: apply` and
  `confirmed: true`, then call it with `action: status`.
- Treat the doctor report returned by apply as the readiness check.
- Explain activation with `/persona use <name>` or the direct command shown by
  `/persona-list`; never use `@name` syntax.

Use `_template.yaml` as the minimal reference. Use
`[EXAMPLE]business-operating-layer.yaml` as a fuller example of a multi-persona
setup.
