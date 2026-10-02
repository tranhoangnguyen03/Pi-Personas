# Pi Persona Maintainer Docs

These docs describe the current product and implementation shape. They are the
source of truth for maintainers and should stay aligned with the code in this
repo.

## Reading Order

1. [`../../README.md`](../../README.md) - user-facing installation, onboarding, and
   troubleshooting.
2. [`blueprint.md`](blueprint.md) - product boundary, persona model, command
   surface, setup model, and settled decisions.
3. [`design.md`](design.md) - implementation responsibilities, data flow,
   integration points, and verification strategy.
4. [`../../init-data/README.md`](../../init-data/README.md) - manifest-backed project
   initialization inputs.
5. [`../../RELEASING.md`](../../RELEASING.md) - release verification and publish procedure.
6. [`migration-runbook.md`](migration-runbook.md) - converting an older
   (pre-global-pack) project setup, in chat or with exact `/persona migrate`
   commands, and how migration rollback differs from a package downgrade.

## Repo Docs Versus Generated Project Docs

The `docs/` directory in this repository is maintainer documentation.

Pi Persona also creates or references user-project context libraries such as
`library/shared/` and `library/personal/<persona>/`. Those paths appear in
tests, templates, and generated project files because they are part of a
user's workspace. They are not maintainer documentation folders.

Persona packs themselves are global: they live under Pi's agent directory
(`<agentDir>/persona/{official,custom,drafts}`), not in any project, and
nothing copies pack content into a project.

## Maintenance Rules

- Keep these docs about the current state, not implementation history.
- When behavior changes, update `blueprint.md` or `design.md` in the same
  change as the code and tests.
- Keep install and compatibility claims aligned with the tested public package metadata.
- Keep user-visible backend selection, native limitations, privacy, progress,
  cancellation, and failure semantics aligned across README, blueprint,
  design, init-data guidance, and releasing checks.
- Do not reintroduce historical phase logs or transcript dumps into this folder.
- Prefer one consolidated design section over several stale narrow documents.
