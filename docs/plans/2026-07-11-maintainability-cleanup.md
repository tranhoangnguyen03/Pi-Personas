# Pi Persona Maintainability Cleanup Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Remove the six identified maintainability risks, close one confirmed settings-file security gap, and strengthen release confidence without changing Pi Persona's public behavior or redesigning its architecture.

**Architecture:** Keep `extensions/pi-persona.ts` as the lifecycle/registration entry point and keep domain behavior in `src/persona/`. Add only two focused shared modules: one for command argument tokenization and one for child-answer value handling. Centralize role and skill-name policy in `schema.js`, automate syntax discovery, add real TypeScript checking for the extension, and preserve settings-file permissions during duplicate-runtime repair.

**Tech Stack:** Node.js 22.19+, ESM, TypeScript, TypeBox, Node's built-in test runner and assertion library.

---

## Scope and constraints

Address these issues only:

1. Repeated `tokenizeArgs` implementations.
2. Repeated consult/roundtable answer helpers.
3. Repeated skill path heuristic.
4. Repeated and ambiguously different role constants.
5. File-by-file syntax-check script.
6. Large, loosely typed `extensions/pi-persona.ts`.
7. Duplicate-runtime repair replaces private Pi settings files with default-permission temporary files.

Do not add caching, redesign persona discovery, remove `resolveAgentPreview`, inline `pi-output.js`, or change public commands. Those were lower-priority observations, not part of this cleanup.

The final verification also adds behavior-level coverage for the successful consult adapter path and validates the shipped init-data fixtures. These are test-only release-confidence additions, not new product scope.

Before implementation, commit or stash the existing release-cleanup changes. Execute this plan in a dedicated worktree so refactoring commits do not mix with the pending release cleanup.

---

### Task 0: Preserve private settings permissions during runtime repair

**Files:**
- Modify: `src/persona/doctor.js:1,219-249`
- Modify: `test/persona-core.test.js` near the duplicate-runtime repair tests

This task is a pre-release security gate and should run before the refactors below. The current atomic rewrite creates the temporary file with default permissions. On a typical `022` umask, repairing a `0600` Pi settings file replaces it with a `0644` file even though the backup remains `0600`. Pi settings can contain unrelated private configuration, so repair must not broaden access.

**Step 1: Add a failing permission-preservation test**

Create duplicate project runtime declarations as the existing repair test does, set `.pi/settings.json` to mode `0600`, run `repairRuntimePackageDuplicates()`, and assert that the repaired file and backup remain `0600`. Also assert that no process temporary file remains:

```js
test("runtime duplicate repair preserves private settings permissions", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-private-settings-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-private-agent-"));
  const settingsPath = path.join(root, ".pi/settings.json");
  await writeText(settingsPath, `${JSON.stringify({
    packages: ["npm:pi-subagents", "github:example/pi-subagents"],
  })}\n`);
  await chmod(settingsPath, 0o600);

  await repairRuntimePackageDuplicates(root, { agentDir });

  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(`${settingsPath}.pi-personas.bak`)).mode & 0o777, 0o600);
  assert.equal(
    (await readdir(path.dirname(settingsPath))).some((name) => name.endsWith(".tmp")),
    false,
  );
});
```

Add the required `chmod`, `readdir`, and `stat` imports from `node:fs/promises`. Reuse the test suite's normal cleanup hooks.

**Step 2: Run the focused test and verify failure**

Run:

```sh
node --test --test-name-pattern="preserves private settings permissions" test/persona-core.test.js
```

Expected on POSIX: FAIL because the repaired file is currently created with mode `0644` under the usual test umask.

**Step 3: Preserve mode and clean up temporary files**

In `repairSettingsRuntimePackages()`:

1. Read the original settings file's permission bits with `stat()`.
2. Copy the backup and explicitly `chmod()` it to the original mode, including when an older backup already exists.
3. Write the temporary file with the original mode and explicitly `chmod()` it before rename so umask cannot silently narrow or broaden the intended bits.
4. Wrap the temporary write and rename in `try/finally`, removing the temporary path with `rm(..., { force: true })` on either success or failure.

Do not change the JSON transformation, backup name, kept-package policy, repair report, or reload requirement.

**Step 4: Run focused and full verification**

Run:

```sh
node --test --test-name-pattern="runtime duplicate repair" test/persona-core.test.js
npm test
```

Expected: PASS; repaired settings content is unchanged from current behavior and original permissions are retained.

**Step 5: Commit**

```sh
git add src/persona/doctor.js test/persona-core.test.js
git commit -m "fix: preserve settings permissions during runtime repair"
```

---

### Task 1: Make syntax checks discover source files automatically

**Files:**
- Create: `scripts/check-syntax.js`
- Modify: `package.json:43-47`
- Modify: `test/persona-core.test.js:280-320`

**Step 1: Write a failing checker test**

Add a test that creates a temporary directory containing `valid.js` and `nested/broken.js`, then executes the future checker against that directory:

```js
test("syntax checker discovers nested JavaScript files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-syntax-"));
  await writeText(path.join(root, "valid.js"), "export const ok = true;\n");
  await writeText(path.join(root, "nested/broken.js"), "export const = broken;\n");

  await assert.rejects(
    () => execFileAsync(process.execPath, ["scripts/check-syntax.js", root], {
      cwd: process.cwd(),
    }),
    /broken\.js/,
  );
});
```

**Step 2: Run the test and verify failure**

Run:

```sh
node --test --test-name-pattern="syntax checker discovers" test/persona-core.test.js
```

Expected: FAIL because `scripts/check-syntax.js` does not exist.

**Step 3: Implement the recursive checker**

Create `scripts/check-syntax.js` using only Node standard library APIs. It should recursively collect `.js` files from command-line roots, defaulting to `src/persona`, sort paths for deterministic output, and run `node --check` once per file:

```js
import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function listJavaScriptFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

const roots = process.argv.slice(2);
const files = (await Promise.all((roots.length ? roots : ["src/persona"]).map(listJavaScriptFiles)))
  .flat()
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

Change package scripts to separate syntax and later type checking:

```json
"check:syntax": "node scripts/check-syntax.js && node --experimental-strip-types --check extensions/pi-persona.ts",
"check": "npm run check:syntax",
```

Keep `test`, `test:unit`, and `test:smoke` unchanged for now.

**Step 4: Run targeted and full checks**

Run:

```sh
node --test --test-name-pattern="syntax checker discovers" test/persona-core.test.js
npm run check
```

Expected: both PASS; every current `src/persona/**/*.js` file is checked without a manifest list.

**Step 5: Commit**

```sh
git add scripts/check-syntax.js package.json test/persona-core.test.js
git commit -m "chore: discover source files during syntax checks"
```

---

### Task 2: Consolidate command argument tokenization

**Files:**
- Create: `src/persona/command-args.js`
- Modify: `src/persona/doc-index.js:350-393`
- Modify: `src/persona/init-manifest.js:524-550`
- Modify: `src/persona/scaffold.js:343-386`
- Modify: `test/persona-core.test.js` near the parser tests at approximately lines 1409, 2719, and 2950

**Step 1: Add characterization tests for the shared semantics**

Add public-parser tests covering spaces, both quote styles, an explicitly empty quoted token, and caller-specific unterminated-quote errors:

```js
test("persona argument parsers share shell-like quote handling", () => {
  assert.deepEqual(parsePersonaIndexArgs('"docs/workstreams/brand assets/"'), {
    all: false,
    target: "docs/workstreams/brand assets/",
  });
  assert.equal(
    parsePersonaNewArgs('Brand --description "Brand reviewer"').options.description,
    "Brand reviewer",
  );
  assert.deepEqual(parsePersonaInitArgs("--from 'init-data/my layer.yaml'"), {
    mode: "apply",
    from: "init-data/my layer.yaml",
  });

  assert.throws(() => parsePersonaIndexArgs('"unfinished'), /persona index arguments/);
  assert.throws(() => parsePersonaNewArgs('Brand --description "unfinished'), /persona new arguments/);
  assert.throws(() => parsePersonaInitArgs('--from "unfinished'), /persona init arguments/);
});
```

Also add a direct test for the shared tokenizer's empty-token behavior by dynamically importing `../src/persona/command-args.js`:

```js
const { tokenizeArgs } = await import("../src/persona/command-args.js");
assert.deepEqual(tokenizeArgs('one "" two', "unterminated"), ["one", "", "two"]);
```

**Step 2: Run the new tests and verify failure**

Run:

```sh
node --test --test-name-pattern="argument parsers|empty-token" test/persona-core.test.js
```

Expected: FAIL because `command-args.js` does not exist and the init parser currently has different empty-token behavior.

**Step 3: Add the minimal shared tokenizer**

Create `src/persona/command-args.js` with the `tokenStarted` implementation currently used by `doc-index.js` and `scaffold.js`:

```js
export function tokenizeArgs(input, unterminatedMessage) {
  const tokens = [];
  let current = "";
  let quote = null;
  let tokenStarted = false;

  for (const char of String(input)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) tokens.push(current);
      current = "";
      tokenStarted = false;
      continue;
    }
    current += char;
    tokenStarted = true;
  }

  if (quote) throw new Error(unterminatedMessage);
  if (tokenStarted) tokens.push(current);
  return tokens;
}
```

Import it in the three callers and pass the existing caller-specific error strings:

```js
tokenizeArgs(args, "unterminated quoted value in /persona init arguments");
tokenizeArgs(args, "unterminated quoted value in /persona new arguments");
tokenizeArgs(args, "unterminated quote in /persona index arguments");
```

Delete all three local implementations.

**Step 4: Run targeted and full tests**

Run:

```sh
node --test --test-name-pattern="argument parsers|parsePersona(Index|Init|New)Args" test/persona-core.test.js
npm test
```

Expected: PASS with unchanged command behavior except standardized support for explicit empty quoted tokens.

**Step 5: Commit**

```sh
git add src/persona/command-args.js src/persona/doc-index.js src/persona/init-manifest.js src/persona/scaffold.js test/persona-core.test.js
git commit -m "refactor: share persona command tokenization"
```

---

### Task 3: Centralize role and skill-name policy in the schema module

**Files:**
- Modify: `src/persona/schema.js:1-4,100-125`
- Modify: `src/persona/doctor.js:430-450`
- Modify: `src/persona/init-manifest.js:1-15,375-440,566-568`
- Modify: `src/persona/scaffold.js:8-17,285-300`
- Modify: `test/persona-core.test.js` near schema, doctor, manifest, and scaffold tests

**Step 1: Add a failing ownership test**

This repository already uses source-boundary tests. Add one that verifies policy lives in `schema.js`, while behavior tests continue proving that runtime files are launchable and user-authored runtime roles are rejected:

```js
test("schema owns persona role and skill-name policy", async () => {
  const schema = await readFile(path.join(process.cwd(), "src/persona/schema.js"), "utf8");
  const doctor = await readFile(path.join(process.cwd(), "src/persona/doctor.js"), "utf8");
  const manifest = await readFile(path.join(process.cwd(), "src/persona/init-manifest.js"), "utf8");
  const scaffold = await readFile(path.join(process.cwd(), "src/persona/scaffold.js"), "utf8");

  assert.match(schema, /isAuthorablePersonaRole/);
  assert.match(schema, /isPathLikeSkillName/);
  assert.doesNotMatch(doctor, /function looksLikePath/);
  assert.doesNotMatch(manifest, /function looksLikePath|const VALID_ROLES/);
  assert.doesNotMatch(scaffold, /const VALID_ROLES/);
});
```

**Step 2: Run the ownership test and verify failure**

Run:

```sh
node --test --test-name-pattern="schema owns persona role" test/persona-core.test.js
```

Expected: FAIL because policy is still duplicated.

**Step 3: Implement named policy functions**

In `schema.js`, keep sets private and export intent-revealing predicates:

```js
const ALLOWED_ROLES = new Set(["generalist", "specialist", "runtime"]);
const AUTHORABLE_ROLES = new Set(["generalist", "specialist"]);

export function isPersonaRole(value) {
  return typeof value === "string" && ALLOWED_ROLES.has(value);
}

export function isAuthorablePersonaRole(value) {
  return typeof value === "string" && AUTHORABLE_ROLES.has(value);
}

export function isPathLikeSkillName(value) {
  return typeof value === "string"
    && (/[\\/]/.test(value) || value.startsWith(".") || value.endsWith(".md"));
}
```

Use `isPersonaRole(role)` inside schema validation. Import and use `isAuthorablePersonaRole()` in `init-manifest.js` and `scaffold.js`. Import and use `isPathLikeSkillName()` in `doctor.js` and `init-manifest.js`. Delete duplicated sets and `looksLikePath` functions.

Do not export the sets themselves; callers should depend on policy, not mutate shared sets.

**Step 4: Run focused behavior tests**

Run:

```sh
node --test --test-name-pattern="schema owns|runtime role|role must be|skills entry looks like a path|manifest validation" test/persona-core.test.js
npm test
```

Expected: PASS. Runtime role files remain valid when discovered; init and scaffold still reject user-authored `runtime`; path-like skills still produce the existing validation messages.

**Step 5: Commit**

```sh
git add src/persona/schema.js src/persona/doctor.js src/persona/init-manifest.js src/persona/scaffold.js test/persona-core.test.js
git commit -m "refactor: centralize persona schema policy"
```

---

### Task 4: Share consult and roundtable answer-value handling

**Files:**
- Create: `src/persona/answer-values.js`
- Modify: `src/persona/consult.js:140-215`
- Modify: `src/persona/roundtable.js:300-345`
- Modify: `test/persona-core.test.js:1968-2075,2357-2395`

**Step 1: Add regression tests for the intentional transport difference**

Consult extraction may expose `response.errorText` as its final fallback; roundtable extraction must not expose private bridge errors. Add tests making that difference explicit:

```js
test("consult may use bridge error text while roundtable keeps it private", async () => {
  assert.deepEqual(await extractConsultAnswer({ errorText: "consult failed" }), {
    text: "consult failed",
    source: "bridge",
  });

  const roundtable = await extractRoundtableAnswer({
    errorText: "private /tmp/roundtable error",
    result: { details: { results: [] } },
  }, "generalist");
  assert.equal(roundtable.source, "missing");
  assert.doesNotMatch(roundtable.text, /private|\/tmp/);
});
```

Add a source-ownership assertion that both modules import `answer-values.js` and no longer define the shared helpers locally.

**Step 2: Run the new tests and verify the structural test fails**

Run:

```sh
node --test --test-name-pattern="bridge error text|answer-value" test/persona-core.test.js
```

Expected: behavioral assertions pass, ownership assertion fails because helpers are duplicated.

**Step 3: Create the focused shared module**

Create `src/persona/answer-values.js`:

```js
export function childResults(response) {
  const results = response?.result?.details?.results;
  return Array.isArray(results) ? results : [];
}

export function stringifyAnswerValue(value) {
  if (typeof value === "string") return value.trim() || undefined;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value, null, 2);
}

export function normalizeAnswerText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "(no output)";
}

export function isIntercomReceiptText(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim());
  return /^Delivered (?:single subagent result|parallel subagent results|chain subagent results) via intercom\.$/.test(lines[0] ?? "")
    && lines.includes("Full grouped output was sent over intercom.");
}

export function requireText(value, errorMessage) {
  if (typeof value !== "string" || !value.trim()) throw new Error(errorMessage);
  return value.trim();
}
```

Import these helpers in `consult.js` and `roundtable.js`. Adapt their local calls so exact error messages remain unchanged:

```js
requireText(name, `consult ${label} is required`);
requireText(selection.reason, `roundtable selection[${index}].reason is required`);
```

Delete the local copies. Keep separate `bridgeResponseText()` functions and add this comment above the roundtable version:

```js
// Round-table output must not expose bridge errorText, run ids, or artifact paths.
```

**Step 4: Run focused and full tests**

Run:

```sh
node --test --test-name-pattern="extractConsultAnswer|extractRoundtableAnswer|bridge error text|consult summary is required|roundtable selection" test/persona-core.test.js
npm test
```

Expected: PASS with identical answer precedence and privacy behavior.

**Step 5: Commit**

```sh
git add src/persona/answer-values.js src/persona/consult.js src/persona/roundtable.js test/persona-core.test.js
git commit -m "refactor: share child answer handling"
```

---

### Task 5: Add real TypeScript checking and remove `any` from the extension

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `extensions/pi-persona.ts`
- Modify: `src/persona/progress.js`
- Modify: `src/persona/index.js`
- Modify: `test/persona-core.test.js` near progress tests

**Step 1: Add the failing no-`any` guard and the typecheck gate**

First add this source assertion so the task has a deterministic red test before types change:

```js
test("extension has no explicit any escape hatches", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  assert.doesNotMatch(source, /:\s*any\b|as\s+any\b/);
});
```

Run it and expect FAIL on the current explicit `any` annotations:

```sh
node --test --test-name-pattern="explicit any" test/persona-core.test.js
```

Then install compiler-only development dependencies:

```sh
npm install --save-dev typescript@^5.9.3 @types/node@^22.19.0
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": false,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "target": "ES2022",
    "types": ["node"]
  },
  "include": ["extensions/**/*.ts"]
}
```

Add:

```json
"typecheck": "tsc -p tsconfig.json",
"check": "npm run check:syntax && npm run typecheck"
```

**Step 2: Run typecheck and capture its actual baseline**

Run:

```sh
npm run typecheck
```

TypeScript permits explicitly written `any`, so the command may pass or may expose inferred boundary errors. Record the actual output; the failing source assertion from Step 1 is the deterministic red gate. Do not weaken `strict` or replace errors with `unknown as any`.

**Step 3: Move pure roundtable process summarization out of the extension**

Move these pure functions from `extensions/pi-persona.ts` into `src/persona/progress.js`:

- `createRoundtableProcessDetails`
- `formatRoundtableProcessLine`
- its private duration formatter

Export the first two through `src/persona/index.js`. Add focused tests with a small roster, completed/failed child results, and a tracker summary. This removes pure formatting from the 784-line registration file without creating a framework or splitting stateful Pi lifecycle code.

Example test shape:

```js
const details = createRoundtableProcessDetails(
  { roster: [{ name: "brand" }], generalist: { name: "generalist" } },
  { result: { details: { results: [{ status: "completed" }, { status: "failed" }] } } },
  { elapsedMs: 2_000, toolCount: 1, turns: 2, categories: {}, sources: 0, recoverableErrors: 0 },
);
assert.equal(details.expectedSteps, 3);
assert.equal(details.completedSteps, 1);
assert.equal(details.failedSteps, 1);
assert.match(formatRoundtableProcessLine(details), /1\/3 steps complete/);
```

**Step 4: Replace extension `any` with real or local structural types**

Import Pi's exported type:

```ts
import {
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
```

Use `ExtensionContext` for `updateActivePersonaStatus`, `restoreActivePersona`, `setActivePersona`, and `activatePersona`.

Define only the local shapes the extension owns:

```ts
type TextContent = { type: "text"; text: string };
type ToolUpdate = { content: TextContent[]; details?: unknown };
type ToolUpdateCallback = ((update: ToolUpdate) => void) | undefined;
type ToolResultLike = {
  content?: Array<{ type?: string; text?: string }>;
};

type ResolvedRoundtable = Awaited<ReturnType<typeof resolveRoundtableLaunchRequest>>;
type BridgeResponse = Awaited<ReturnType<typeof runSubagentBridgeRequest>>;
type RoundtableTracker = ReturnType<typeof createRoundtableProgressTracker>;
type RoundtableProgressSummary = ReturnType<RoundtableTracker["snapshot"]>;
```

Then:

- Type `firstToolResultText(result: ToolResultLike)` and remove callback `any`.
- Type roundtable reporter/process inputs with `ResolvedRoundtable`, `BridgeResponse`, and `RoundtableProgressSummary`.
- Type `onUpdate` with `ToolUpdateCallback`.
- Let typed arrays infer map/filter callback types; remove callback annotations.
- Replace `(heartbeat as any).unref?.()` with `heartbeat.unref()` under Node types.
- For genuinely external payloads, use `unknown` plus existing runtime narrowing rather than `any`.

Do not split command/tool registration into classes or factories. The shared closure over active persona and pending roundtable state is simpler and safer in one entry point.

**Step 5: Confirm the no-`any` guard is green**

Run the source assertion added in Step 1. It deliberately checks explicit escape hatches, not incidental prose.

**Step 6: Run type and runtime verification**

Run:

```sh
npm run typecheck
node --test --test-name-pattern="roundtable process|explicit any" test/persona-core.test.js
npm test
```

Expected: TypeScript passes under `strict`; all unit and RPC smoke tests pass.

**Step 7: Commit**

```sh
git add tsconfig.json package.json package-lock.json extensions/pi-persona.ts src/persona/progress.js src/persona/index.js test/persona-core.test.js
git commit -m "refactor: type extension integration boundaries"
```

---

### Task 6: Align maintainer design documentation and run release verification

**Files:**
- Modify: `docs/_about_pi_persona/design.md:7-38, Documentation And Test Strategy`

**Step 1: Update module responsibilities**

Document:

- `command-args.js` owns shared slash-command tokenization.
- `answer-values.js` owns shared child-result value normalization, while consult and roundtable retain distinct privacy/fallback policy.
- `schema.js` owns accepted-role and path-like skill-name policy.
- `progress.js` owns pure roundtable process summaries as well as live progress formatting.
- `extensions/pi-persona.ts` remains lifecycle glue and is checked with strict TypeScript.

Keep the documentation about current behavior, not refactoring history.

**Step 2: Run the complete automated release gate**

Run from a clean install:

```sh
npm ci
npm test
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

Expected:

- All unit tests pass.
- Real Pi RPC smoke test passes.
- Audit reports zero production vulnerabilities.
- Tarball contains both new runtime `.js` modules and excludes `docs/plans/` and `docs/superpowers/`.
- No whitespace errors.

**Step 3: Run focused manual runtime smoke**

In a disposable Pi project with `npm:pi-personas` and `npm:pi-subagents >=0.35.0` loaded:

1. Run `/persona init`, `/persona doctor`, and `/persona-list`.
2. Activate `/generalist`, send a follow-up, then `/persona clear`.
3. Run one `persona_consult`; verify final answer and compact provenance.
4. Run one `/persona-roundtable`; verify one managed synthesis and no raw bridge metadata.
5. Exercise quoted paths/options:
   - `/persona index "docs/shared/"`
   - `/persona init --plan --from "init-data/example layer.yaml"` using a disposable valid manifest path

Expected: no behavior change from the pre-refactor runtime.

**Step 4: Commit documentation**

```sh
git add docs/_about_pi_persona/design.md
git commit -m "docs: document shared persona boundaries"
```

---

### Task 7: Close automated release-confidence gaps

**Files:**
- Modify: `test/persona-core.test.js` near the extension consult and package tests
- Modify: `test/pi-rpc-smoke.test.js`
- Modify: `.github/workflows/ci.yml`

The domain modules have strong behavior coverage, and the round-table adapter already has a successful extension-harness test. The corresponding successful `persona_consult` adapter path is not exercised end to end, while the real Pi RPC smoke currently proves only extension loading and `/persona-list`. The shipped init-data examples are also not executed by tests.

**Step 1: Add a successful consult adapter test**

Using `createExtensionHarness()`, a disposable workspace, and the existing fake bridge event bus:

1. Configure a disposable `pi-subagents` package and Pi settings.
2. Activate a requester persona.
3. Execute `persona_consult` with a different known persona.
4. Emit matching `started`, `update`, and `response` events.
5. Assert exactly one bridge request, fresh context by default, resolved consultant reads and skills, progress publication, returned answer, compact provenance, and no raw intercom receipt.

This should be a behavior test. Do not add another source-text regular-expression assertion for this path.

**Step 2: Exercise setup in the real Pi RPC smoke**

Run the RPC process in a disposable workspace rather than the repository root. Execute `/persona init`, then `/persona-list`, and assert that the generated primary generalist is visible. Keep the process offline and continue loading the extension from its absolute repository path.

This verifies real command routing, scaffold writes, subsequent discovery, and visible command output without invoking a model or external child runtime.

**Step 3: Validate shipped init-data fixtures**

Add package-fixture tests that assert:

- `init-data/[EXAMPLE]business-operating-layer.yaml` successfully plans and produces the expected multi-persona entries.
- `init-data/_template.yaml` is intentionally rejected until its documented placeholders are replaced.
- both files remain included in `npm pack --dry-run --json`.

**Step 4: Keep whitespace validation in CI**

Add `git diff --check` to `.github/workflows/ci.yml` so the documented automated gate also runs on every push and pull request.

Do not add a coverage dependency or a brittle global coverage threshold in this task. The aim is to cover the known adapter and fixture gaps directly.

**Step 5: Run verification**

Run:

```sh
node --test --test-name-pattern="successful consult|init-data fixtures" test/persona-core.test.js
node --test test/pi-rpc-smoke.test.js
npm test
git diff --check
```

Expected: PASS with no production behavior changes.

**Step 6: Commit**

```sh
git add test/persona-core.test.js test/pi-rpc-smoke.test.js .github/workflows/ci.yml
git commit -m "test: cover consult and packaged setup paths"
```

---

## Completion criteria

- Runtime duplicate repair preserves the original permissions of Pi settings and backup files and leaves no temporary file behind.
- One `tokenizeArgs` implementation exists.
- One answer-value helper implementation exists for the shared behavior.
- Role and skill-name policy is defined only in `schema.js`.
- New `src/persona/**/*.js` files are syntax-checked automatically.
- `extensions/pi-persona.ts` passes strict TypeScript and contains no explicit `any`.
- Pure process summarization no longer lives in the extension entry point.
- The successful consult adapter path and shipped init-data fixtures have behavior-level coverage.
- All automated and manual release gates pass.
- Public commands, tool schemas, answer precedence, and roundtable privacy remain unchanged.
