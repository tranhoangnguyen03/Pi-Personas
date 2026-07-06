# Pi Persona Init Data

This directory holds YAML manifests for bootstrapping a Pi Persona project.
These files are user-editable setup inputs, not generated runtime state.

Start from `_template.yaml` when creating a new operating layer:

```sh
cp init-data/_template.yaml init-data/my-operating-layer.yaml
```

Then edit the copied file and apply it with Pi Persona commands.

## Command Flow

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
- Ask only for missing facts that materially change the persona layer.
- Keep the template copy editable by humans.
- Do not invent secrets, private business facts, or unsupported skills.
- Prefer small, named specialists with clear routing descriptions.
- Keep generated docs concise enough that the user can review them.
- After editing, tell the user to run the plan command before applying.

Use `_template.yaml` as the minimal reference. Use
`business-operating-layer.yaml` as a fuller example of a multi-persona setup.
