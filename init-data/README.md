# Pi Persona Init Data

This directory holds YAML manifests for bootstrapping a Pi Persona project.
These files are durable setup inputs, not generated runtime state.

New users should start with the assisted draft command:

```text
/persona init draft --out init-data/my-operating-layer.yaml
```

The command creates a starter manifest and starts an agentic setup interview in
the Pi session. Answer the questions in chat; the assistant should edit the YAML
for you, then preview the result before applying it.

Advanced users can still copy `_template.yaml` by hand when they already know
the exact operating layer they want.

## Command Flow

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

- Keep paths inside the workspace.
- Use relative paths, not absolute paths.
- Use command-safe agent names: lowercase letters, numbers, and hyphens.
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
- Run or tell the user to run the plan command before applying.

Use `_template.yaml` as the minimal reference. Use
`business-operating-layer.yaml` as a fuller example of a multi-persona setup.
