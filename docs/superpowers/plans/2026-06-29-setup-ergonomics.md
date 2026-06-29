# Setup Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-time Pi Persona setup practical from the `/persona new` path by letting users define an agent, docs, tools, consult peers, and tags in one file-native command.

**Architecture:** Keep setup ergonomic behavior inside the existing scaffold module and `/persona` command wrapper. The command still writes ordinary `.pi/agents/*.md` files with only user-facing schema fields; runtime adapter fields remain derived later by the resolver/adapter.

**Tech Stack:** Node.js ESM, built-in `node:test`, Pi Coding Agent extension command wrapper, existing markdown frontmatter parser.

---

## Scope

This phase includes:

- `/persona new <name>` remains the minimal path.
- `/persona new <name> --role generalist|specialist --description "..." --docs docs/... --tools read,subagent --consults peer --tags tag`
- Option parsing for quoted values, `--key value`, and `--key=value`.
- Scaffold output that contains only `name`, `role`, `description`, `tools`, `docs`, `consults`, `tags`, and prompt body.
- Creation feedback that tells the user the direct launch command and to run `/persona doctor`.
- Tests proving parsed setup inputs become discoverable/resolvable persona metadata.

This phase excludes:

- A conversational wizard.
- Doc indexing or special knowledge-base formats.
- Tool installation or tool discovery beyond existing doctor validation.
- A separate picker command.

## Files

- Modify: `test/persona-core.test.js`
- Modify: `src/persona/scaffold.js`
- Modify: `src/persona/index.js`
- Modify: `extensions/pi-persona.ts`

## Tasks

### Task 1: Failing Scaffold Ergonomics Tests

- [x] Add imports for `parsePersonaNewArgs` and `formatAgentScaffoldCreatedMessage`.

```js
import {
  createAgentScaffold,
  formatAgentScaffoldCreatedMessage,
  parsePersonaNewArgs,
} from "../src/persona/index.js";
```

- [x] Add a parser test.

```js
test("parsePersonaNewArgs accepts setup metadata options", () => {
  const parsed = parsePersonaNewArgs(
    'Market Research --role specialist --description "Market research specialist." --docs docs/workstreams/market/ --tools read,subagent --consults guideline,pricing --tags market,research',
  );

  assert.equal(parsed.rawName, "Market Research");
  assert.equal(parsed.options.role, "specialist");
  assert.equal(parsed.options.description, "Market research specialist.");
  assert.deepEqual(parsed.options.docs, ["docs/workstreams/market/"]);
  assert.deepEqual(parsed.options.tools, ["read", "subagent"]);
  assert.deepEqual(parsed.options.consults, ["guideline", "pricing"]);
  assert.deepEqual(parsed.options.tags, ["market", "research"]);
});
```

- [x] Add a scaffold metadata test.

```js
test("createAgentScaffold writes provided setup metadata without runtime fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-"));
  await writeText(path.join(root, "docs/workstreams/market/brief.md"), "Market doc\n");

  const result = await createAgentScaffold(root, "Market Research", {
    role: "specialist",
    description: "Market research specialist.",
    docs: ["docs/workstreams/market/"],
    tools: ["read", "subagent"],
    consults: ["guideline"],
    tags: ["market", "research"],
  });
  const content = await readFile(result.filePath, "utf8");

  assert.match(content, /role: specialist/);
  assert.match(content, /description: Market research specialist\./);
  assert.match(content, /tools: read, subagent/);
  assert.match(content, /docs: docs\/workstreams\/market\//);
  assert.match(content, /consults: guideline/);
  assert.match(content, /tags: market, research/);
  assert.doesNotMatch(content, /defaultReads/);
  assert.doesNotMatch(content, /systemPromptMode/);
  assert.doesNotMatch(content, /inheritSkills/);

  const project = await discoverPersonaProject(root);
  const agent = project.agents.find((candidate) => candidate.name === "market-research");
  assert.equal(agent.description, "Market research specialist.");
  assert.deepEqual(agent.docs, ["docs/workstreams/market/"]);
  assert.deepEqual(agent.tools, ["read", "subagent"]);
  assert.deepEqual(agent.consults, ["guideline"]);
});
```

- [x] Run `rtk npm test -- --test-name-pattern "parsePersonaNewArgs|createAgentScaffold writes provided setup metadata"` and confirm it fails because the new exports do not exist.

### Task 2: Scaffold Parser and Renderer

- [x] Implement `parsePersonaNewArgs(args)` in `src/persona/scaffold.js`.
- [x] Support `--key value`, `--key=value`, quoted values, and comma-separated lists.
- [x] Reject unknown options with `unknown /persona new option: --x`.
- [x] Reject invalid roles with `role must be generalist or specialist`.
- [x] Keep `createAgentScaffold(root, rawName)` backward compatible.
- [x] Add `formatAgentScaffoldCreatedMessage(result)` for concise setup feedback.
- [x] Export the new functions from `src/persona/index.js`.
- [x] Run the focused tests and confirm they pass.

### Task 3: Command Wrapper

- [x] Update `extensions/pi-persona.ts` imports.
- [x] Change `/persona new` to parse args with `parsePersonaNewArgs(rawName)`.
- [x] Call `createAgentScaffold(ctx.cwd, parsed.rawName, parsed.options)`.
- [x] Send `formatAgentScaffoldCreatedMessage(result)` instead of only `Created <path>`.
- [x] Update usage text to show the richer syntax while preserving `/persona new <name>`.
- [x] Add or update a source-level test that checks the extension uses the parser and feedback formatter.

### Task 4: Verification

- [x] Run `rtk npm test`.
- [x] Run `rtk git diff --check HEAD`.
- [x] Run a live Pi CLI smoke test with a temporary session directory:

```bash
rtk env PI_OFFLINE=1 pi --approve --mode json --session-dir /tmp/pi-persona-setup-proof -p '/persona new setup-proof --description "Setup proof specialist." --docs docs/workstreams/setup-proof/ --tools read --tags setup,proof'
rtk env PI_OFFLINE=1 pi --approve --mode json --session-dir /tmp/pi-persona-setup-proof -p '/persona-list'
```

- [x] Remove only the temporary setup-proof scaffold if created during the proof.

### Task 5: Commit

- [ ] Review `rtk git status --short`.
- [ ] Stage the implementation and plan.
- [ ] Commit with `feat: improve persona setup ergonomics`.
