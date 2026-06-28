# Phase 2 Schema Resolver Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden pi-persona schema validation and produce a formal resolver scope for baseline-plus-agent assembly.

**Architecture:** Keep validation and resolution in pure ESM modules. Doctor calls schema validation and resolver utilities, while the Pi command wrapper remains unchanged. Runtime-only fields stay derived in code, not required in user-authored agent files.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing Phase 1 modules.

---

## Scope

Phase 2 includes:

- Launchable agent schema validation.
- Runtime-field leakage warnings.
- Specialist `consults: all` validation.
- A formal `resolveAgentScope(root, agentName)` API.
- Baseline-plus-agent doc/tool/body assembly.
- Protection against accidental inclusion of unrelated specialist docs.

Phase 2 excludes:

- Actual agent launching.
- Consult orchestration.
- Round-table.
- `/persona-list`.
- `/agent new`.

## Files

- Modify: `test/persona-core.test.js`
- Create: `src/persona/schema.js`
- Create: `src/persona/resolver.js`
- Modify: `src/persona/doctor.js`
- Modify: `src/persona/index.js`

## Tasks

### Task 1: Failing Schema Tests

- [x] Add tests for malformed launchable files, unknown roles, specialist `consults: all`, and runtime-only fields.
- [x] Run `npm test` and confirm the new tests fail against Phase 1 code.

### Task 2: Failing Resolver Tests

- [x] Add tests for `resolveAgentScope` baseline merge and unrelated specialist doc exclusion.
- [x] Run `npm test` and confirm the resolver export is missing.

### Task 3: Schema Module

- [x] Implement `src/persona/schema.js`.
- [x] Wire schema validation into `runDoctor`.
- [x] Run `npm test`.

### Task 4: Resolver Module

- [x] Implement `src/persona/resolver.js`.
- [x] Export `resolveAgentScope`.
- [x] Keep `resolveAgentPreview` as a compatibility alias to the same scope resolver.
- [x] Run `npm test`.

### Task 5: Verification

- [x] Run `npm test`.
- [x] Run syntax/import checks.
- [x] Run ASCII and trailing-whitespace checks.
- [x] Run `git status --short --untracked-files=all`.
