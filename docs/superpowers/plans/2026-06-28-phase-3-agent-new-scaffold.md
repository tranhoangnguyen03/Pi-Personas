# Phase 3 Agent New Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first user setup command: `/persona new <name>` creates a minimal valid pi-persona agent file.

**Architecture:** Keep scaffold generation in a pure module with filesystem helpers, then call it from the existing Pi `/persona` command wrapper. The scaffold emits only user-facing schema fields and avoids runtime adapter fields.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing Pi extension wrapper.

---

## Scope

Phase 3 includes:

- Agent name normalization for scaffold file names.
- Minimal `.pi/agents/<name>.md` generation.
- Overwrite protection.
- `/persona new <name>` command routing.

Phase 3 excludes conversational authoring, doc deployment helpers, tool setup helpers, direct launch, consults, and round-table.

## Files

- Modify: `test/persona-core.test.js`
- Create: `src/persona/scaffold.js`
- Modify: `src/persona/index.js`
- Modify: `extensions/pi-persona.ts`

## Tasks

### Task 1: Failing Scaffold Tests

- [x] Add tests for scaffold creation, runtime-field exclusion, name normalization, and overwrite protection.
- [x] Run `npm test` and confirm scaffold export is missing.

### Task 2: Scaffold Module

- [x] Implement `src/persona/scaffold.js`.
- [x] Export `normalizeAgentName`, `renderAgentScaffold`, and `createAgentScaffold`.
- [x] Run `npm test`.

### Task 3: Command Wrapper

- [x] Wire `/persona new <name>` in `extensions/pi-persona.ts`.
- [x] Keep `/persona doctor` unchanged.
- [x] Run syntax/import smoke checks.

### Task 4: Verification

- [x] Run `npm test`.
- [x] Run ASCII and trailing-whitespace checks.
- [x] Run `git status --short --untracked-files=all`.
