# Phase 1 Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first pi-persona implementation slice: a thin runtime adapter and `/persona doctor` command that validate project persona files against the Phase 0 runtime contract.

**Architecture:** Keep the implementation small and testable. Pure ESM modules parse `.pi/agents/**/*.md`, validate schema/docs/tools/consults, and resolve an agent preview. A tiny Pi extension wrapper registers `/persona doctor` and calls the pure modules using `ctx.cwd`.

**Tech Stack:** Node.js ESM, built-in `node:test`, Pi extension TypeScript wrapper, no external runtime dependencies.

---

## Scope

Phase 1 includes:

- Minimal package/test scaffold.
- User-facing pi-persona schema parser.
- Project agent discovery from `.pi/agents/**/*.md`.
- `_baseline.md` control-file handling.
- `/persona doctor` report generation.
- Resolver preview for one agent.
- Pi command wrapper for `/persona doctor`.

Phase 1 excludes:

- Direct agent launch commands.
- Consults.
- Round-table.
- `/persona-list`.
- Conversational authoring.
- Porting real business agents.

## Files

- Create: `package.json`
- Create: `src/persona/frontmatter.js`
- Create: `src/persona/agents.js`
- Create: `src/persona/doctor.js`
- Create: `src/persona/index.js`
- Create: `extensions/pi-persona.ts`
- Create: `test/persona-core.test.js`

## Tasks

### Task 1: Test Contract

- [x] Add `package.json` with `npm test`.
- [x] Add `test/persona-core.test.js` with failing tests for discovery, doctor, and resolver preview.
- [x] Run `npm test` and confirm it fails because implementation modules do not exist yet.

### Task 2: Parser And Discovery

- [x] Implement frontmatter parsing for the user-facing schema fields.
- [x] Implement `.pi/agents/**/*.md` discovery.
- [x] Exclude underscore-prefixed control files from launchable agents.
- [x] Run tests and confirm parser/discovery cases pass.

### Task 3: Doctor And Resolver Preview

- [x] Implement dependency checks against installed `pi-subagents` and `pi-intercom` package paths.
- [x] Implement structural doctor issues: duplicate names, multiple generalists, missing docs, unknown consults, launchable control files, and unknown tools.
- [x] Implement resolver preview with baseline-plus-agent docs/tools and derived `defaultReads`.
- [x] Run tests and confirm all pure module tests pass.

### Task 4: Pi Command Wrapper

- [x] Add `extensions/pi-persona.ts`.
- [x] Register `/persona doctor`.
- [x] Format doctor output for `ctx.ui.notify`.
- [x] Run static import smoke checks.

### Task 5: Verification

- [x] Run `npm test`.
- [x] Run ASCII and trailing-whitespace checks on new files.
- [x] Run `git status --short --untracked-files=all`.
