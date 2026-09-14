# Changelog

All notable changes to Pi Persona are documented here.

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
