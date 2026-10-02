# Changelog

All notable changes to Pi Persona are documented here.

## 0.4.0 - 2026-10-02

Persona packs are now global, each session uses one team, and you manage
everything by asking in chat. Slash commands remain as the advanced route.

### Added

- Global persona packs stored in Pi's agent directory and usable from any
  project. Official packs install from the bundled catalog (`philosopher-7`);
  custom packs are created from scratch or forked, then changed through a
  draft, a preview and an approved apply.
- One team per session and one default team for new sessions. Installing or
  editing a pack never activates it. A session keeps the copy of its pack it
  loaded until you refresh or switch, and switching replaces the team's
  `/` commands.
- Chat-first management: browse, install, fork, edit, switch this session's
  team, set or clear the default, and migrate an older project setup in plain
  language. Every change is shown as
  a plan first. Pi accepts a confirmation only for an exact plan it showed in
  this session, that is still unchanged, and only after you have sent another
  message; whether that message means yes is left to the assistant.
- Migration of older project setups (`.pi/agents/` with its own generalist)
  into a global custom pack, in chat or with `/persona migrate
  inspect/preview/apply/status/cancel/rollback`. Migration copies; the
  originals are never changed and the new pack is not selected or made the
  default.

### Changed

- Consults and round-tables run only on Pi Persona's own native child runner.
  `pi-subagents` is no longer used or a peer dependency, and an installed copy
  never affects Pi Persona. An explicit `legacy` (or any non-`native`)
  `PI_PERSONA_BACKEND`/`.pi/persona.json` backend now stops with an error
  naming the setting.
- Onboarding (`/persona onboard`) is optional and creates only the project
  foundation: `.pi/agents/_baseline.md` and `library/shared/`. It creates no
  personas.
- Round-tables use this session's team and its `[G]` lead.
- `/persona pack author` and `/persona pack configure`, project-local pack
  installs under `.pi/persona-packs/`, and copying pack references into
  `library/` are removed. `philosopher-7` no longer ships a `configure.md`.

### Upgrading from 0.3.x

- A workspace with an older setup (its own `.pi/agents/` generalist) starts
  sessions with no team and its personas paused until you migrate it or pick
  an installed team. Pi says so at startup.
- Packs that 0.3.x installed into a project are not converted. Install the
  global version and pick it as a team; the old project files and your
  `library/` folders are left alone.
- Remove any `PI_PERSONA_BACKEND=legacy` or `{ "backend": "legacy" }`
  setting.

### Downgrading to pi-personas 0.3.x

- 0.3.x does not know about global persona packs. Your packs, default and
  migration receipts are left untouched on disk, but 0.3.x will not show or
  use them. Sessions bound to a global team show no personas.
- In a workspace you already migrated, 0.3.x uses the original `.pi/agents`
  team again.
- `/persona pack`, `/persona team` and `/persona migrate` only print 0.3.x
  usage text.
- If you edit `.pi/agents` while on 0.3.x, upgrading again marks that
  workspace's migration `changed-source`. New sessions there get no default
  team until you run `/persona migrate inspect/preview/apply` again.
- 0.3.x may clear a session's active persona. After upgrading again, the
  session keeps its team; pick the lead again (for example `/symposium`).
- Migration rollback is a different operation; it does not downgrade.

### Fixed

- A session with no team, or one whose workspace needs migration, no longer
  gets an old workspace persona injected into its replies when a persona
  saved by an earlier version is restored.
- Starting a new session over RPC no longer leaves behind one private pack
  copy per new session.
- A pack operation interrupted by a crash no longer leaves the pack store
  locked: the next operation clears a lock whose process is gone.
- Installing an official pack from a local path is refused up front with a
  clear message; official packs come only from the bundled catalog.

### Known limitation

- If Pi is killed (`kill -9`, power loss), the session's private pack copy
  under `<agentDir>/persona/.runtime-sessions/` is not cleaned up
  automatically. With no Pi running, delete everything inside that
  directory.

## 0.3.0 - 2026-09-14

- Added a private Pi child runner, tested with Pi 0.85.1, for consultations and fixed
  round-tables. With no explicit `PI_PERSONA_BACKEND` or `.pi/persona.json`
  backend, Pi Persona now defaults to `legacy` when `pi-subagents` is
  installed and to `native` otherwise; explicit selection and startup
  validation for invalid or missing backends are unchanged.
- Added exact skill and declared built-in tool controls, active-branch fork snapshots,
  normalized progress and usage, cancellation escalation, and phase-stop
  behavior without automatic cross-backend retries.
- Updated Pi package dependency ownership, type checking, doctor output,
  onboarding guidance, and maintainer/release documentation for Pi 0.85.1.
- Kept legacy consults foreground-only and adapted round-tables to the current
  `pi-subagents` workflow API while retaining the 0.34.0 chain path.


## 0.2.1 - 2026-07-18

- Restored `pi-subagents` 0.34.0 round-table compatibility and removed the
  unsupported private delivery parameter from bridge requests.

## 0.2.0 - 2026-07-12

- Made `/persona onboard` the primary resumable setup command with a default
  `init-data/my-operating-layer.yaml` manifest.
- Added `/persona quick-start` for the minimal scaffold and kept `/persona init`
  as a compatibility alias for onboarding.
- Guided apply now indexes docs, runs doctor, lists personas, and activates the
  primary generalist; empty states consistently direct users to onboarding.

## 0.1.0 - 2026-07-11

- Added project-local active personas with baseline, docs, and native skill awareness.
- Added canonical `/persona use`, direct aliases, active state, and footer status.
- Added focused persona consults and primary-generalist-selected round-tables.
- Added assisted manifest authoring, strict schema validation, doctor, and docs indexing.
- Added safe multiline YAML rendering and automatic doctor verification after assisted apply.
- Added physical workspace path containment, automatic duplicate-runtime repair,
  live consult progress, idle cancellation, and release smoke tests.
- Added transparent consult panels with delegated query, context mode, and
  native `Ctrl+O` expanded request details.
- Reworked round-tables so the active primary generalist selects the roster and
  one `persona_roundtable` call runs both rounds plus synthesis, with advisory
  acceptance, correlated result extraction, phase-aware live progress, and no
  automatic runtime or inactivity cancellation after the bridge starts.
- Added in-process bridge delivery for round-tables and deterministic rejection
  of known unresolved onboarding placeholders during manifest and doctor
  validation.
- Added consult-style round-table transparency with collapsed and expanded
  selection panels, accumulated per-child progress, human-readable activity,
  phase and next-step guidance, and a final execution summary.
