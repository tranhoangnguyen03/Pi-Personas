# Pi Persona Setup Data

This directory holds the project-foundation record created by guided
onboarding. Most users never need to edit it directly.

## Guided Onboarding

Onboarding is optional. Persona packs are global and work without it. Open Pi
from the project you want to set up, then run:

```text
/persona onboard
```

The walkthrough takes roughly 2–5 minutes. It explains the project-local
library, asks what this project is for, previews the files it will create, and
waits for explicit approval.

Onboarding creates only the shared foundation:

- `.pi/agents/_baseline.md` supplies common instructions.
- `library/shared/` holds editable context available to every persona.
- `library/shared/_index.md` describes what that library contains.

When the draft is ready, the assistant previews the plan, asks for explicit
approval, applies it, and runs a readiness check (`/persona doctor`). Apply creates missing files and never
overwrites files that already exist. If doctor finds errors after files are
applied, onboarding reports **Applied — Needs Attention** and leaves the files
in place for correction; it does not claim the apply was rolled back.

Onboarding creates no personas and does not choose a team. To get a team, ask
in chat (for example "What persona teams can I use?") or use
`/persona pack install <name>` or `/persona pack create <name>`, then pick it
for the session. Each pack supplies its own on-theme `[G]` lead and
specialists.

The default record is `init-data/my-persona-setup.yaml`. Rerunning onboarding
resumes an unfinished record or reports the existing foundation without
overwriting it. `/persona init` does the same thing.

Choose another record path only when needed:

```text
/persona onboard --out init-data/team-persona-setup.yaml
```

## Custom Records (Rarely Needed)

### What the Record Contains

The assistant manages these fields:

- `project.name`: a short, stable name for the project scope.
- `baseline.docs`: shared library directories.
- `baseline.skills`: Pi skill names.
- `baseline.prompt`: common instructions for every persona.
- `docs.files`: project-relative starter library files.
- `agents`: left empty; persona packs own persona definitions.

[`[EXAMPLE]business-persona-setup.yaml`](%5BEXAMPLE%5Dbusiness-persona-setup.yaml)
shows a completed foundation record.

### Editing Rules

- Keep paths inside the physical project; symlink escapes are rejected.
- Use project-relative paths.
- Put broadly useful facts in `library/shared/`.
- Use native skill names, not filesystem paths, in `skills`.
- Resolve every starter placeholder before approving the plan.
