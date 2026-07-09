# Pi Persona Maintainer Docs

These docs describe the current product and implementation shape. They are the
source of truth for maintainers and should stay aligned with the code in this
repo.

## Reading Order

1. [`../../README.md`](../../README.md) - user-facing install, quickstart, and
   troubleshooting.
2. [`blueprint.md`](blueprint.md) - product boundary, persona model, command
   surface, setup model, and settled decisions.
3. [`design.md`](design.md) - implementation responsibilities, data flow,
   integration points, and verification strategy.
4. [`../../init-data/README.md`](../../init-data/README.md) - manifest-backed project
   initialization inputs.

## Repo Docs Versus Generated Project Docs

The `docs/` directory in this repository is maintainer documentation.

Pi Persona also creates or references user-project docs such as:

- `docs/shared/`
- `docs/workstreams/<name>/`

Those paths appear in tests, templates, and generated project files because
they are part of a user's persona workspace. They are not additional maintainer
documentation folders in this repository.

## Maintenance Rules

- Keep these docs about the current state, not implementation history.
- When behavior changes, update `blueprint.md` or `design.md` in the same
  change as the code and tests.
- Keep install claims conservative while `package.json` is private.
- Do not reintroduce historical phase logs or transcript dumps into this folder.
- Prefer one consolidated design section over several stale narrow documents.
