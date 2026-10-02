// Host-lifecycle regressions for the global persona pack work (implementation
// plan Task 1: docs/plans/2026-09-21-global-persona-pack-implementation.md).
//
// These are HOST PROBES, not tests of an implemented pi-persona feature: no
// production pack-binding/session-switching code exists yet (that is Task 5).
// Each test here spawns a real `pi` RPC process against a small fixture
// extension under test/.fixtures/persona-team-rpc/ext/ and exercises actual
// Pi host mechanics (ctx.reload(), pi.appendEntry()/getBranch(), fork) that
// the eventual feature will depend on. They promote three probes verified in
// docs/plans/persona-pack-probes/ (gitignored, not release evidence) to
// committed regressions, per the implementation plan's evidence-and-gates
// section and Task 1 step 1.
//
// No paid model calls; no ~/.pi/settings.json or ~/.pi/auth.json touched. See
// .fixtures/persona-team-rpc/rpc-harness.mjs for the isolation mechanism
// (throwaway PI_CODING_AGENT_DIR + --no-skills/--no-prompt-templates/--no-themes/
// --no-context-files per spawned process).
import { writeFileSync, existsSync, unlinkSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { startPi, send, stop, answerConfirm } from "./.fixtures/persona-team-rpc/rpc-harness.mjs";
import { readPortablePersonaPack } from "../src/persona/pack-source.js";
import { applyCustomPersonaPackDraft, stageCustomPersonaPackDraft } from "../src/persona/global-pack-store.js";
import { readGlobalDefaultPack, writeGlobalDefaultPack } from "../src/persona/pack-session.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(HERE, ".fixtures", "persona-team-rpc", "ext");
const REPO_ROOT = path.join(HERE, "..");
const REAL_EXTENSION = path.join(REPO_ROOT, "extensions", "pi-persona.ts");

function commandNames(commandsResponse) {
  return commandsResponse.data.commands.map((c) => c.name);
}

function isNotify(m, prefix) {
  return m.type === "extension_ui_request" && m.method === "notify" && String(m.message).startsWith(prefix);
}

// extensions/pi-persona.ts sends output via pi.sendMessage({customType:
// "pi-persona", ...}), not ctx.ui.notify(), so its own output surfaces over
// RPC as message_end events (same shape test/pi-rpc-smoke.test.js's
// "real Pi RPC loads the extension and executes persona-list" test asserts
// on), not extension_ui_request/notify like the toy Task 1 fixtures above.
function isPersonaMessage(m, substring) {
  return m.type === "message_end" && m.message?.customType === "pi-persona" && String(m.message.content).includes(substring);
}

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function teamAgentSource(name, role) {
  return `---\nname: ${name}\nrole: ${role}\ndescription: ${name} ${role}.\n---\n${name} prompt body.\n`;
}

// A minimal, real schema 2 pack: one generalist lead, one specialist. Used
// to populate the global store with genuinely installed packs (not toy
// fixtures) for the real extensions/pi-persona.ts to bind sessions to.
async function installRealTeamPack(storeRoot, { name, leadName, specialistName }) {
  const sourceDir = await mkdtemp(path.join(tmpdir(), `pi-persona-rpc-pack-src-${name}-`));
  try {
    await writeText(path.join(sourceDir, "pack.yaml"), [
      "schema: 2",
      `name: ${name}`,
      "version: 1.0.0",
      `description: ${name} test pack.`,
    ].join("\n") + "\n");
    await writeText(path.join(sourceDir, "agents", `${leadName}.md`), teamAgentSource(leadName, "generalist"));
    await writeText(path.join(sourceDir, "agents", `${specialistName}.md`), teamAgentSource(specialistName, "specialist"));
    await writeText(path.join(sourceDir, "references", "_index.md"), `# ${name}\n`);
    const source = await readPortablePersonaPack(sourceDir, { type: "path", ref: sourceDir });
    await stageCustomPersonaPackDraft(storeRoot, name, source);
    await applyCustomPersonaPackDraft(storeRoot, name);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

// Seeds a store with two installed custom packs (marketing/philosophy,
// matching the design draft's acceptance-matrix example: "Marketing default
// with one Philosophy session") and sets the global default to marketing.
// Returns the store root; the caller is responsible for the parent agentDir
// (passed to startPi as PI_CODING_AGENT_DIR).
async function seedMarketingDefaultStore(agentDir) {
  const storeRoot = path.join(agentDir, "persona");
  await installRealTeamPack(storeRoot, { name: "marketing", leadName: "market-lead", specialistName: "market-analyst" });
  await installRealTeamPack(storeRoot, { name: "philosophy", leadName: "philo-lead", specialistName: "philo-scout" });
  await writeGlobalDefaultPack(storeRoot, "custom/marketing");
  return storeRoot;
}

async function tempAgentDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function startPersonaPi(agentDir, extraArgs = [], { envExtra = {}, cwd } = {}) {
  return startPi(
    ["--mode", "rpc", "--offline", "--extension", REAL_EXTENSION, "--approve", ...extraArgs],
    { PI_CODING_AGENT_DIR: agentDir, ...envExtra },
    { cwd },
  );
}

async function getCommandNames(child, rpc) {
  const cursor = rpc.cursor();
  const id = `cmds-${Date.now()}-${Math.random()}`;
  send(child, { id, type: "get_commands" });
  const response = await rpc.waitFor((m) => m.type === "response" && m.command === "get_commands" && m.id === id, "get_commands", 15000, cursor);
  return commandNames(response);
}

async function runPersonaCommand(child, rpc, message, label) {
  const cursor = rpc.cursor();
  const id = `prompt-${Date.now()}-${Math.random()}`;
  send(child, { id, type: "prompt", message });
  return rpc.waitFor((m) => m.id === id && m.type === "response", label ?? `prompt ${message}`, 15000, cursor);
}

// Throws on timeout rather than returning the last (non-matching) snapshot:
// a caller that only asserts on the returned names would otherwise get a
// confusing downstream assertion failure (or a TypeError if no response was
// ever received) instead of a clear "polling timed out" diagnosis.
async function pollUntilCommand(child, rpc, predicate, label, deadlineMs = 10000) {
  const deadline = Date.now() + deadlineMs;
  let last;
  while (Date.now() < deadline) {
    const pollCursor = rpc.cursor();
    const reqId = `poll-${Date.now()}-${Math.random()}`;
    send(child, { id: reqId, type: "get_commands" });
    last = await rpc.waitFor((m) => m.type === "response" && m.command === "get_commands" && m.id === reqId, "get_commands poll", 5000, pollCursor);
    if (predicate(commandNames(last))) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`pollUntilCommand timed out after ${deadlineMs}ms waiting for ${label}; last seen commands: ${JSON.stringify(last ? commandNames(last) : last)}`);
}

test("command refresh: reload swaps team commands, preserves unrelated extension, exposes name collisions, stays isolated from real ~/.pi state", { timeout: 30_000 }, async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-persona-rpc-test-state-"));
  const stateFile = path.join(stateDir, "state.json");
  if (existsSync(stateFile)) unlinkSync(stateFile);
  writeFileSync(stateFile, JSON.stringify({ team: "alpha" }));

  const { child, rpc } = startPi(
    [
      "--mode", "rpc",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--extension", path.join(EXT_DIR, "team-toggle.ts"),
      "--extension", path.join(EXT_DIR, "unrelated.ts"),
      "--approve",
    ],
    { PERSONA_PROBE_STATE: stateFile },
    {
      // Deterministic isolation probe: plant a prompt-template file in this
      // process's own throwaway agent dir (not this machine's real ~/.pi/agent,
      // whose contents are environment-dependent and not under test control)
      // and assert below that it never reaches get_commands. A broken
      // --no-prompt-templates flag, or a dropped PI_CODING_AGENT_DIR override,
      // would leak it regardless of what this machine happens to have installed.
      seedAgentDir: (agentDir) => {
        const promptsDir = path.join(agentDir, "prompts");
        mkdirSync(promptsDir, { recursive: true });
        writeFileSync(path.join(promptsDir, "isolation-canary.md"), "Deterministic isolation canary; must never reach get_commands.\n");
      },
    },
  );
  // Registered before the stateDir cleanup below: node:test runs t.after
  // hooks in registration order, so the child is always killed before its
  // state file's directory is removed out from under it.
  t.after(() => stop(child));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  let cursor = rpc.cursor();
  send(child, { id: "c1", type: "get_commands" });
  const before = await rpc.waitFor((m) => m.id === "c1" && m.type === "response", "get_commands #1", 15000, cursor);
  const namesBefore = commandNames(before);

  assert.ok(namesBefore.includes("team-alpha"), "team-alpha command present before reload");
  assert.ok(!namesBefore.includes("team-beta"), "team-beta command absent before reload");
  assert.ok(namesBefore.includes("unrelated-cmd"), "unrelated-cmd present before reload");
  const sharedBefore = namesBefore.filter((n) => n.startsWith("shared-name"));
  assert.equal(sharedBefore.length, 2, `expected 2 shared-name entries, got ${JSON.stringify(sharedBefore)}`);
  assert.notEqual(sharedBefore[0], sharedBefore[1], "colliding command names are suffixed apart, not silently dropped/overwritten");

  // Isolation regression: the parent-flagged real leak (2026-09-20 feasibility
  // review) was an unrelated prompt-template command ("hey_agy") from this
  // machine's real ~/.pi/agent leaking into get_commands because only
  // --no-extensions was passed. Asserting the absence of that specific,
  // machine-specific name is not deterministic (a machine/CI box without a
  // "hey_agy" prompt template would pass this vacuously either way), so this
  // probes the same isolation flags against a canary planted in this
  // process's own throwaway agent dir instead (see seedAgentDir above).
  assert.ok(!namesBefore.includes("isolation-canary"), "isolated harness must not leak a prompt-template command seeded in its own throwaway agent dir");

  cursor = rpc.cursor();
  send(child, { id: "p1", type: "prompt", message: "/persona-current" });
  const notify1 = await rpc.waitFor((m) => isNotify(m, "persona-current"), "persona-current notify before reload", 15000, cursor);
  assert.equal(notify1.message, "persona-current team: alpha");

  cursor = rpc.cursor();
  send(child, { id: "p2", type: "prompt", message: "/toggle-and-reload" });
  await rpc.waitFor((m) => isNotify(m, "toggled team"), "toggle notify", 15000, cursor);

  // No session_start{reason:"reload"} bare RPC event is exposed in this
  // protocol version, so detect reload completion by polling get_commands.
  const after = await pollUntilCommand(child, rpc, (names) => names.includes("team-beta"), "team-beta after alpha->beta reload");
  const namesAfter = commandNames(after);

  assert.ok(namesAfter.includes("team-beta"), "team-beta command present after reload");
  assert.ok(!namesAfter.includes("team-alpha"), "team-alpha command disappeared after reload");
  assert.ok(namesAfter.includes("unrelated-cmd"), "unrelated-cmd survives reload");
  assert.ok(namesAfter.includes("persona-current"), "persona-current survives reload (re-registered fresh)");
  const sharedAfter = namesAfter.filter((n) => n.startsWith("shared-name"));
  assert.equal(sharedAfter.length, 2, "shared-name collision still exposed after reload");

  cursor = rpc.cursor();
  send(child, { id: "p3", type: "prompt", message: "/persona-current" });
  const notify2 = await rpc.waitFor((m) => isNotify(m, "persona-current"), "persona-current notify after reload", 15000, cursor);
  assert.equal(notify2.message, "persona-current team: beta", "overlap-name routing goes to the freshly registered instance");

  cursor = rpc.cursor();
  send(child, { id: "p4", type: "prompt", message: "/unrelated-cmd" });
  const notify3 = await rpc.waitFor((m) => isNotify(m, "unrelated-cmd"), "unrelated-cmd notify after reload", 15000, cursor);
  assert.equal(notify3.message, "unrelated-cmd ok", "unrelated command still dispatches correctly after reload");

  // Both-direction switch: a single alpha->beta transition can't tell a real
  // toggle apart from "whatever the reload happens to produce the first
  // time". Switching back proves the cleanup/registration cycle is
  // symmetric, not a one-shot artifact of the initial state.
  cursor = rpc.cursor();
  send(child, { id: "p5", type: "prompt", message: "/toggle-and-reload" });
  await rpc.waitFor((m) => isNotify(m, "toggled team"), "toggle-back notify", 15000, cursor);

  const backToAlpha = await pollUntilCommand(child, rpc, (names) => names.includes("team-alpha"), "team-alpha after beta->alpha reload");
  const namesBackToAlpha = commandNames(backToAlpha);
  assert.ok(namesBackToAlpha.includes("team-alpha"), "team-alpha command present after switching back");
  assert.ok(!namesBackToAlpha.includes("team-beta"), "team-beta command disappeared after switching back");
  assert.ok(namesBackToAlpha.includes("unrelated-cmd"), "unrelated-cmd survives the second reload");

  cursor = rpc.cursor();
  send(child, { id: "p6", type: "prompt", message: "/persona-current" });
  const notify4 = await rpc.waitFor((m) => isNotify(m, "persona-current"), "persona-current notify after switching back", 15000, cursor);
  assert.equal(notify4.message, "persona-current team: alpha", "dispatch routes to the freshly re-registered alpha instance, not a stale beta one");
});

test("blocked/failing reload: prompt-dispatch success does not imply reload success, and no stale commands survive", { timeout: 30_000 }, async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-persona-rpc-test-flaky-state-"));
  const stateFile = path.join(stateDir, "state.json");
  if (existsSync(stateFile)) unlinkSync(stateFile);
  writeFileSync(stateFile, JSON.stringify({ broken: false }));

  const { child, rpc } = startPi(
    [
      "--mode", "rpc",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--extension", path.join(EXT_DIR, "flaky-team.ts"),
      "--extension", path.join(EXT_DIR, "unrelated.ts"),
      "--approve",
    ],
    { PERSONA_PROBE_STATE: stateFile },
  );
  // Registered before the stateDir cleanup below, same reasoning as the
  // command-refresh test: kill the child before removing the directory its
  // state file lives in.
  t.after(() => stop(child));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  let cursor = rpc.cursor();
  send(child, { id: "c1", type: "get_commands" });
  const before = await rpc.waitFor((m) => m.id === "c1" && m.type === "response", "get_commands #1", 15000, cursor);
  const namesBefore = commandNames(before);
  assert.ok(namesBefore.includes("flaky-current"), "flaky-current present before break");
  assert.ok(namesBefore.includes("mark-broken-and-reload"), "mark-broken-and-reload present before break");
  assert.ok(namesBefore.includes("unrelated-cmd"), "unrelated-cmd present before break");

  cursor = rpc.cursor();
  send(child, { id: "p1", type: "prompt", message: "/flaky-current" });
  const notify1 = await rpc.waitFor((m) => isNotify(m, "flaky-current"), "flaky-current notify", 15000, cursor);
  assert.equal(notify1.message, "flaky-current: ok");

  // Trigger the break: flip state to broken=true and reload. The command
  // handler itself only claims "reload requested", never "succeeded" -- the
  // exact conflation design draft §3/§9 warns against.
  cursor = rpc.cursor();
  send(child, { id: "p2", type: "prompt", message: "/mark-broken-and-reload" });
  const reloadRequestedNotify = await rpc.waitFor((m) => isNotify(m, "reload requested"), "reload-requested notify", 15000, cursor);
  assert.equal(reloadRequestedNotify.message, "reload requested (outcome not yet known)", "reload-requested notify carries no success claim");

  const promptResponse = await rpc.waitFor((m) => m.id === "p2" && m.type === "response", "prompt command response", 15000, cursor);
  // Dispatch itself is accepted (success: true) -- yet the reload it triggered
  // will be shown below to have FAILED. A caller that stopped here and
  // reported "team switched" would be reporting a false success.
  assert.equal(promptResponse.success, true);

  // This test covers a FACTORY-failed reload: the extension's factory
  // function itself throws when re-invoked after ctx.reload() (flaky-team.ts
  // above). That is a distinct failure mode from a NON-IDLE-blocked reload
  // (a future ctx.reload() caller refusing to run while the agent is mid-turn
  // streaming a response) -- the implementation plan's Task 5 step 4 ("wait
  // for idle") describes that second mode as a requirement for the
  // not-yet-built pack-binding feature, not a behavior of today's host.
  // Source-checked (dist/core/agent-session.js AgentSession.reload(), current
  // package version): reload() has no isStreaming/idle check at all -- it
  // shuts down the old extension runner and rebuilds unconditionally. There
  // is therefore no host mechanism to probe for a non-idle guard today; that
  // guard is Task 5 product code to be added (and regression-tested) when
  // pack-session.js implements it, not a gap in the current host. Deferred,
  // not silently dropped.
  //
  // Source-confirmed finding (dist/core/extensions/loader.js
  // initializeExtension()/loadExtension()): a factory-level throw during
  // reload is caught and accumulated in ResourceLoader.getExtensions().errors,
  // never re-thrown and never routed through the extension_error RPC event
  // (that event is wired to a different mechanism: runtime event-handler/
  // tool-call errors during an active session, not extension-load failures).
  // getExtensions().errors has exactly one consumer in the whole package --
  // the interactive TUI's startup diagnostics panel -- so RPC mode gives no
  // error-shaped signal at all for this failure mode.
  //
  // The "no error-shaped event" check below is scoped to [cursor, reload
  // actually confirmed complete] rather than an arbitrary fixed sleep: a
  // blind delay is either too short (misses a late event, flaky) or wastes
  // time once the reload is already done, and it can't prove anything about
  // what happens between "sleep ends" and "reload actually finishes".
  // Anchoring the window to pollUntilCommand's deterministic completion
  // signal (flaky-current disappearing) covers the exact interval that
  // matters and nothing before/after it.
  const after = await pollUntilCommand(child, rpc, (names) => !names.includes("flaky-current"), "flaky-current gone after factory-failed reload");
  const namesAfter = commandNames(after);

  const errorLike = rpc.getMessages().slice(cursor).filter((m) => m.type === "extension_error" || m.type === "error");
  assert.equal(errorLike.length, 0, `expected no error-shaped RPC events for a factory-load failure, got ${JSON.stringify(errorLike)}`);
  assert.equal(rpc.getStderr().trim(), "", `expected empty stderr, got: ${rpc.getStderr()}`);

  assert.ok(!namesAfter.includes("flaky-current"), "flaky-current is gone after the failed reload (no stale pre-break command left registered)");
  assert.ok(!namesAfter.includes("mark-broken-and-reload"), "mark-broken-and-reload is gone after the failed reload (broken instance registered nothing)");
  assert.ok(namesAfter.includes("unrelated-cmd"), "unrelated-cmd survives the failed reload (fail-safe boundary: other extensions unaffected)");

  cursor = rpc.cursor();
  send(child, { id: "p3", type: "prompt", message: "/unrelated-cmd" });
  const notify3 = await rpc.waitFor((m) => isNotify(m, "unrelated-cmd"), "unrelated-cmd notify after break", 15000, cursor);
  assert.equal(notify3.message, "unrelated-cmd ok", "unrelated command still actually dispatches (not just listed) after the failed reload");

  cursor = rpc.cursor();
  send(child, { id: "s1", type: "get_state" });
  const state = await rpc.waitFor((m) => m.id === "s1" && m.type === "response", "get_state after break", 15000, cursor);
  assert.equal(state.success, true, "process remains alive and responsive after the failed reload (not fatal to the whole runtime)");
});

test("branch-before-binding fork: forking from a point predating a binding entry does not inherit that entry", { timeout: 30_000 }, async (t) => {
  const sessionDir = mkdtempSync(path.join(tmpdir(), "pi-persona-rpc-test-sessions-"));
  t.after(() => rmSync(sessionDir, { recursive: true, force: true }));
  // Resuming a session file across separate startPi() calls requires the
  // same cwd every time: Pi's session file records its original working
  // directory and refuses to resume against a different (or since-removed)
  // one. The harness's own default cwd is a fresh throwaway temp dir per
  // call, so a resume/fork scenario spanning multiple startPi() calls must
  // supply one explicit, shared workspace instead of relying on that default.
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "pi-persona-rpc-test-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  const base = [
    "--mode", "rpc",
    "--offline",
    "--no-extensions",
    "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts"),
    "--session-dir", sessionDir,
    "--approve",
  ];

  async function seed(child, rpc) {
    const cursor = rpc.cursor();
    send(child, { id: `seed-${Date.now()}-${Math.random()}`, type: "prompt", message: "/seed" });
    const notify = await rpc.waitFor((m) => isNotify(m, "seeded:"), "seed notify", 15000, cursor);
    return notify.message.split("seeded:")[1];
  }

  async function recall(child, rpc) {
    const cursor = rpc.cursor();
    send(child, { id: `recall-${Date.now()}-${Math.random()}`, type: "prompt", message: "/recall" });
    const notify = await rpc.waitFor((m) => isNotify(m, "recall:"), "recall notify", 15000, cursor);
    return notify.message;
  }

  // --- Build the original session: a user message (E1, pre-binding), then a
  // custom binding entry, then a second user message (E2, post-binding). ---
  let { child, rpc } = startPi(base, {}, { cwd: workspaceRoot });
  let sessionFile;
  let preBindingEntryId;
  let postBindingEntryId;
  try {
    let cursor = rpc.cursor();
    send(child, { id: "s1", type: "get_state" });
    const state1 = await rpc.waitFor((m) => m.id === "s1", "get_state #1", 15000, cursor);
    sessionFile = state1.data.sessionFile;

    preBindingEntryId = await seed(child, rpc);

    cursor = rpc.cursor();
    send(child, { id: "r1", type: "prompt", message: "/remember hello-1" });
    await rpc.waitFor((m) => isNotify(m, "remembered:hello-1"), "remembered notify", 15000, cursor);

    // Flip Pi's disk-flush gate (>=1 assistant message required) with no real
    // LLM call, so the session file resuming below actually contains the
    // entries built up in this process.
    cursor = rpc.cursor();
    send(child, { id: "sa1", type: "prompt", message: "/seed-assistant" });
    await rpc.waitFor((m) => isNotify(m, "seeded-assistant:"), "seed-assistant notify", 15000, cursor);

    postBindingEntryId = await seed(child, rpc);

    const recallInOriginal = await recall(child, rpc);
    assert.equal(recallInOriginal, 'recall:{"value":"hello-1"}', "binding entry is visible on the original (unforked) branch");
  } finally {
    await stop(child);
  }

  // --- Fork at the PRE-binding point: the forked branch must not see the
  // custom entry that was appended after that point on the parent branch. ---
  ({ child, rpc } = startPi([...base, "--session", sessionFile], {}, { cwd: workspaceRoot }));
  try {
    let cursor = rpc.cursor();
    send(child, { id: "gfm1", type: "get_fork_messages" });
    const forkMessages = await rpc.waitFor((m) => m.id === "gfm1", "get_fork_messages", 15000, cursor);
    const forkable = forkMessages.data.messages.map((m) => m.entryId);
    assert.ok(forkable.includes(preBindingEntryId), `expected pre-binding entry ${preBindingEntryId} to be forkable, got ${JSON.stringify(forkable)}`);

    cursor = rpc.cursor();
    send(child, { id: "fork-pre", type: "fork", entryId: preBindingEntryId });
    const forkResult = await rpc.waitFor((m) => m.id === "fork-pre", "fork response (pre-binding)", 15000, cursor);
    assert.equal(forkResult.success, true);
    assert.equal(forkResult.data.cancelled, false);

    const recallAfterPreFork = await recall(child, rpc);
    assert.equal(
      recallAfterPreFork,
      "recall:none",
      "forking from a point predating the binding correctly reports no binding, rather than borrowing the parent branch's later entry",
    );
  } finally {
    await stop(child);
  }

  // --- Control: fork at the POST-binding point on a fresh resume of the same
  // original (unforked) session file -- the binding must still be inherited. ---
  ({ child, rpc } = startPi([...base, "--session", sessionFile], {}, { cwd: workspaceRoot }));
  try {
    const cursor = rpc.cursor();
    send(child, { id: "fork-post", type: "fork", entryId: postBindingEntryId });
    const forkResult = await rpc.waitFor((m) => m.id === "fork-post", "fork response (post-binding)", 15000, cursor);
    assert.equal(forkResult.success, true);
    assert.equal(forkResult.data.cancelled, false);

    const recallAfterPostFork = await recall(child, rpc);
    assert.equal(
      recallAfterPostFork,
      'recall:{"value":"hello-1"}',
      "forking from a point after the binding inherits it (control case, proves the pre-binding result above isn't just fork being broken)",
    );
  } finally {
    await stop(child);
  }
});

test("binding entries: an explicitly recorded value is distinguishable from no binding entry at all", { timeout: 30_000 }, async (t) => {
  // Design draft/implementation plan: "Missing binding is not explicit none"
  // -- a session that never recorded a binding must be treated differently
  // from one that explicitly recorded "no team". No production binding-entry
  // schema exists yet (Task 5), but the underlying host primitive it will
  // rest on -- pi.appendEntry()/getBranch() reverse-scan, already exercised
  // by entry-persistence-probe.ts's remember/recall pair -- must actually be
  // able to tell the two apart. This probes that primitive directly, offline,
  // with no forking/resuming required.
  const sessionDir = mkdtempSync(path.join(tmpdir(), "pi-persona-rpc-test-explicit-none-"));
  t.after(() => rmSync(sessionDir, { recursive: true, force: true }));

  const { child, rpc } = startPi([
    "--mode", "rpc",
    "--offline",
    "--no-extensions",
    "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts"),
    "--session-dir", sessionDir,
    "--approve",
  ]);
  t.after(() => stop(child));

  async function recall() {
    const cursor = rpc.cursor();
    send(child, { id: `recall-${Date.now()}-${Math.random()}`, type: "prompt", message: "/recall" });
    const notify = await rpc.waitFor((m) => isNotify(m, "recall:"), "recall notify", 15000, cursor);
    return notify.message;
  }

  const missing = await recall();
  assert.equal(missing, "recall:none", "no binding entry recorded at all reads as the missing sentinel");

  const cursor = rpc.cursor();
  send(child, { id: "r1", type: "prompt", message: "/remember none" });
  await rpc.waitFor((m) => isNotify(m, "remembered:none"), "remembered notify", 15000, cursor);

  const explicitNone = await recall();
  assert.equal(
    explicitNone,
    'recall:{"value":"none"}',
    "an explicitly recorded entry carrying the value \"none\" is a real entry (JSON-wrapped), not the missing-entry sentinel string",
  );
  assert.notEqual(missing, explicitNone, "missing binding and explicit-none binding must not collapse to the same observable state");
});

// ---------------------------------------------------------------------------
// Task 5: session binding and /persona team, against the REAL
// extensions/pi-persona.ts (not a toy fixture), with genuinely installed
// schema 2 packs. No paid model calls: these exercise command
// registration/dispatch and session-entry state, never a native child launch.
// ---------------------------------------------------------------------------

test("default/session binding: Marketing default applies to new sessions; switching one session both directions leaves a parallel session unaffected", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-default-");
  await seedMarketingDefaultStore(agentDir);
  const workspace1 = mkdtempSync(path.join(tmpdir(), "pi-persona-team-ws1-"));
  const workspace2 = mkdtempSync(path.join(tmpdir(), "pi-persona-team-ws2-"));
  t.after(() => rmSync(workspace1, { recursive: true, force: true }));
  t.after(() => rmSync(workspace2, { recursive: true, force: true }));

  const session1 = startPersonaPi(agentDir, ["--no-session"], { cwd: workspace1 });
  t.after(() => stop(session1.child));
  const session2 = startPersonaPi(agentDir, ["--no-session"], { cwd: workspace2 });
  t.after(() => stop(session2.child));

  const namesBefore1 = await getCommandNames(session1.child, session1.rpc);
  assert.ok(namesBefore1.includes("market-lead"), "genuinely new session 1 receives the configured Marketing default");
  assert.ok(!namesBefore1.includes("philo-lead"), "session 1 does not also expose the other installed team");

  const namesBefore2 = await getCommandNames(session2.child, session2.rpc);
  assert.ok(namesBefore2.includes("market-lead"), "a second, independent new session also receives the same configured default");

  const status1 = await runPersonaCommand(session1.child, session1.rpc, "/persona status");
  const statusMsg1 = await session1.rpc.waitFor((m) => isPersonaMessage(m, "Persona team:"), "status message", 15000, 0);
  assert.match(statusMsg1.message.content, /Persona team: custom\/marketing/);

  // Switch session 1 to Philosophy; session 2 must not observe this at all.
  const switchCursor = session1.rpc.cursor();
  send(session1.child, { id: "switch-1", type: "prompt", message: "/persona team custom/philosophy" });
  await session1.rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/philosophy'"), "switching notice", 15000, switchCursor);
  const namesAfterSwitch1 = (await pollUntilCommand(session1.child, session1.rpc, (names) => names.includes("philo-lead"), "philo-lead after switch")).data.commands.map((c) => c.name);
  assert.ok(namesAfterSwitch1.includes("philo-lead"), "session 1 now exposes Philosophy's commands");
  assert.ok(!namesAfterSwitch1.includes("market-lead"), "session 1's Marketing commands disappeared");
  assert.ok(namesAfterSwitch1.includes("persona"), "management commands survive the switch");

  const namesSession2AfterSwitch = await getCommandNames(session2.child, session2.rpc);
  assert.ok(namesSession2AfterSwitch.includes("market-lead"), "parallel session 2 is unaffected by session 1's switch");
  assert.ok(!namesSession2AfterSwitch.includes("philo-lead"), "session 2 never adopts the team session 1 switched to");

  // Both directions: switch session 1 back to Marketing.
  const switchBackCursor = session1.rpc.cursor();
  send(session1.child, { id: "switch-2", type: "prompt", message: "/persona team custom/marketing" });
  await session1.rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/marketing'"), "switching back notice", 15000, switchBackCursor);
  const namesAfterSwitchBack = (await pollUntilCommand(session1.child, session1.rpc, (names) => names.includes("market-lead"), "market-lead after switching back")).data.commands.map((c) => c.name);
  assert.ok(namesAfterSwitchBack.includes("market-lead"), "session 1 exposes Marketing's commands again");
  assert.ok(!namesAfterSwitchBack.includes("philo-lead"), "session 1's Philosophy commands disappeared");

  // Explicit none: both installed teams' commands disappear, management stays.
  const noneCursor = session1.rpc.cursor();
  send(session1.child, { id: "switch-3", type: "prompt", message: "/persona team none" });
  await session1.rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to none"), "switching to none notice", 15000, noneCursor);
  const namesAfterNone = (await pollUntilCommand(session1.child, session1.rpc, (names) => !names.includes("market-lead"), "market-lead gone after switching to none")).data.commands.map((c) => c.name);
  assert.ok(!namesAfterNone.includes("market-lead") && !namesAfterNone.includes("philo-lead"), "no team commands remain after explicit none");
  assert.ok(namesAfterNone.includes("persona") && namesAfterNone.includes("persona-list"), "management commands remain registered even with no bound team");
});

test("RPC new_session does not leak a retained snapshot when Pi emits session_start twice on one runtime", { timeout: 30_000 }, async (t) => {
  // Pi 0.85.1's RPC new_session rebinds extensions twice (runtimeHost's own
  // rebind plus rpc-mode's), so the fresh instance sees two session_start
  // events. Each loaded a snapshot; the first was never disposed.
  const agentDir = await tempAgentDir(t, "pi-persona-team-new-session-");
  const storeRoot = await seedMarketingDefaultStore(agentDir);
  const snapshots = () => readdirSync(path.join(storeRoot, ".runtime-sessions")).filter((name) => !name.endsWith(".owner.json"));
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session"]);
  t.after(() => stop(child));

  assert.ok((await getCommandNames(child, rpc)).includes("market-lead"));
  assert.equal(snapshots().length, 1);
  for (const id of ["new-1", "new-2"]) {
    const cursor = rpc.cursor();
    send(child, { id, type: "new_session" });
    await rpc.waitFor((m) => m.type === "response" && m.id === id, id, 15000, cursor);
    assert.ok((await getCommandNames(child, rpc)).includes("market-lead"), "the new session still gets the default");
    assert.equal(snapshots().length, 1, `exactly one live snapshot after ${id}: ${snapshots()}`);
  }
  await stop(child);
  assert.deepEqual(snapshots(), [], "graceful shutdown leaves no snapshot behind");
});

test("invalid switch target is rejected before any pending intent or reload", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-invalid-");
  await seedMarketingDefaultStore(agentDir);
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session"]);
  t.after(() => stop(child));

  const namesBefore = await getCommandNames(child, rpc);
  assert.ok(namesBefore.includes("market-lead"));

  const cursor = rpc.cursor();
  send(child, { id: "bad-switch", type: "prompt", message: "/persona team custom/does-not-exist" });
  const errorMessage = await rpc.waitFor((m) => isPersonaMessage(m, "is not installed"), "not-installed error", 15000, cursor);
  assert.match(errorMessage.message.content, /custom\/does-not-exist/);

  // No pending intent, no reload: the store's actual default binding must
  // still be exactly what it was, immediately (no polling needed: an invalid
  // target never gets far enough to persist intent or reload at all).
  const namesAfter = await getCommandNames(child, rpc);
  assert.deepEqual(namesAfter, namesBefore, "an invalid switch target changes nothing: no pending write, no reload");
});

test("a committed binding that becomes invalid before a later plain reload recovers instead of silently losing the team", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-recover-");
  const storeRoot = await seedMarketingDefaultStore(agentDir);
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session", "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts")]);
  t.after(() => stop(child));

  const switchCursor = rpc.cursor();
  send(child, { id: "switch", type: "prompt", message: "/persona team custom/philosophy" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/philosophy'"), "switching notice", 15000, switchCursor);
  await pollUntilCommand(child, rpc, (names) => names.includes("philo-lead"), "philo-lead after switch");

  // Invalidate the bound pack on disk directly (not through the extension):
  // simulates the pack having been removed/corrupted between this commit and
  // a later reload, e.g. by a separate `/persona pack remove` elsewhere.
  rmSync(path.join(storeRoot, "custom", "philosophy"), { recursive: true, force: true });

  // Trigger a plain reload with NO pending switch in flight (unlike the
  // command-driven switch above) -- this is rehydrateBinding's path, not
  // completePendingSwitch's: resume/reload of an already-committed binding
  // that has since gone missing.
  const reloadCursor = rpc.cursor();
  send(child, { id: "reload", type: "prompt", message: "/probe-reload" });
  const recoveryMessage = await rpc.waitFor((m) => isPersonaMessage(m, "could not be loaded"), "recovery notice", 15000, reloadCursor);
  assert.match(recoveryMessage.message.content, /custom\/philosophy/);

  const namesAfter = await pollUntilCommand(child, rpc, (names) => names.includes("persona") && !names.includes("philo-lead"), "philo-lead gone, management intact, after failed rehydrate");
  const commandNamesAfter = commandNames(namesAfter);
  assert.ok(!commandNamesAfter.includes("philo-lead"), "the now-invalid team's commands are gone, not left stale");
  assert.ok(!commandNamesAfter.includes("market-lead"), "recovery never silently substitutes the default (or any other team)");
  assert.ok(commandNamesAfter.includes("persona") && commandNamesAfter.includes("persona-list"), "management/recovery commands remain available");

  // The user can still explicitly recover by choosing a valid team.
  const recoverCursor = rpc.cursor();
  send(child, { id: "recover", type: "prompt", message: "/persona team custom/marketing" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/marketing'"), "recovery switch notice", 15000, recoverCursor);
  await pollUntilCommand(child, rpc, (names) => names.includes("market-lead"), "market-lead after explicit recovery switch");
});

test("a bound team that goes missing before reload clears the stale active lead from display and stored state, with no misleading fallback text", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-missing-lead-");
  const storeRoot = await seedMarketingDefaultStore(agentDir);
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session", "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts")]);
  t.after(() => stop(child));

  // New session: the Marketing default is bound and its lead is active.
  const boundStatusCursor = rpc.cursor();
  send(child, { id: "status-bound", type: "prompt", message: "/persona status" });
  const boundStatus = await rpc.waitFor((m) => isPersonaMessage(m, "Active persona:"), "status (bound)", 15000, boundStatusCursor);
  assert.match(boundStatus.message.content, /Active persona: \[G\] market-lead/);

  rmSync(path.join(storeRoot, "custom", "marketing"), { recursive: true, force: true });
  const reloadCursor = rpc.cursor();
  send(child, { id: "reload", type: "prompt", message: "/probe-reload" });
  const notice = await rpc.waitFor((m) => isPersonaMessage(m, "could not be loaded"), "missing-team notice", 15000, reloadCursor);
  assert.doesNotMatch(notice.message.content, /own (project )?commands remain available/);
  assert.match(notice.message.content, /No persona is active/);
  // The status bar is cleared for the fresh instance, not left showing /market-lead.
  const statusBar = rpc.getMessages().slice(reloadCursor).filter((m) => m.type === "extension_ui_request" && m.method === "setStatus" && m.statusKey === "pi-persona-active");
  assert.ok(statusBar.length > 0, "the fresh instance updates the active-persona status bar");
  assert.equal(statusBar.at(-1).statusText, undefined, "the status bar no longer shows the vanished team's lead");

  const statusCursor = rpc.cursor();
  send(child, { id: "status-missing", type: "prompt", message: "/persona status" });
  const missingStatus = await rpc.waitFor((m) => isPersonaMessage(m, "Active persona:"), "status (missing)", 15000, statusCursor);
  assert.match(missingStatus.message.content, /Persona team: none \(the bound pack could not be loaded/);
  assert.match(missingStatus.message.content, /Active persona: none/);
  assert.doesNotMatch(missingStatus.message.content, /market-lead/);

  // Stored state, not just this instance's memory: a further plain reload
  // (which restores the active persona from session entries) still has none.
  const secondReloadCursor = rpc.cursor();
  send(child, { id: "reload2", type: "prompt", message: "/probe-reload" });
  await rpc.waitFor((m) => isPersonaMessage(m, "could not be loaded"), "missing-team notice after second reload", 15000, secondReloadCursor);
  const secondStatusCursor = rpc.cursor();
  send(child, { id: "status-missing-2", type: "prompt", message: "/persona status" });
  const secondStatus = await rpc.waitFor((m) => isPersonaMessage(m, "Active persona:"), "status (missing, second reload)", 15000, secondStatusCursor);
  assert.match(secondStatus.message.content, /Active persona: none/);
});

test("a failed pending switch settles durably: it does not retry itself on a later plain reload", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-pending-fail-");
  await seedMarketingDefaultStore(agentDir);
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session", "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts")]);
  t.after(() => stop(child));

  // Genuinely new session: the configured Marketing default is already bound.
  const namesBefore = await getCommandNames(child, rpc);
  assert.ok(namesBefore.includes("market-lead"), "Marketing default is bound at session start");

  // Inject a pending switch to a target that was never validated (bypasses
  // switchPersonaTeam's own upfront validation entirely), then reload: this
  // deterministically drives completePendingSwitch's failure path without
  // needing to race real file corruption against ctx.reload()'s timing.
  const injectCursor = rpc.cursor();
  send(child, { id: "inject", type: "prompt", message: "/inject-team-pending custom/does-not-exist" });
  await rpc.waitFor((m) => isNotify(m, "injected-pending:"), "injected-pending notify", 15000, injectCursor);

  const firstReloadCursor = rpc.cursor();
  send(child, { id: "reload1", type: "prompt", message: "/probe-reload" });
  const failureNotice = await rpc.waitFor((m) => isPersonaMessage(m, "failed and was not applied"), "switch-failed notice", 15000, firstReloadCursor);
  assert.match(failureNotice.message.content, /custom\/does-not-exist/);

  // The failure settles durably onto the previous binding (Marketing), not
  // "none": market-lead must reappear, proving recovery preserved identity
  // rather than erasing it.
  const namesAfterFirstReload = await pollUntilCommand(child, rpc, (names) => names.includes("market-lead"), "market-lead recovered after failed switch");
  assert.ok(commandNames(namesAfterFirstReload).includes("market-lead"));

  // A second, later PLAIN reload (no new pending switch injected) must not
  // retry the same failed switch again: if the failure had not settled
  // durably, the stale pending entry would still be the latest team entry
  // and every subsequent reload would re-attempt (and re-fail) it forever.
  const secondReloadCursor = rpc.cursor();
  send(child, { id: "reload2", type: "prompt", message: "/probe-reload" });
  await pollUntilCommand(child, rpc, (names) => names.includes("persona") && names.includes("persona-list"), "management commands present after second reload");
  const repeatedFailure = rpc.getMessages().slice(secondReloadCursor).filter((m) => isPersonaMessage(m, "failed and was not applied"));
  assert.deepEqual(repeatedFailure, [], "the failed switch must not be retried on a later plain reload (no infinite pending loop)");
  const namesAfterSecondReload = await getCommandNames(child, rpc);
  assert.ok(namesAfterSecondReload.includes("market-lead"), "Marketing remains bound after the second, unrelated reload");
});

test("explicit none and a missing-bound team report truthfully in /persona status and refuse to silently fall back for round-tables or direct activation", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-scope-guard-");
  const storeRoot = await seedMarketingDefaultStore(agentDir);
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session", "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts")]);
  t.after(() => stop(child));

  const status1 = await runPersonaCommand(child, rpc, "/persona status");
  const status1Msg = await rpc.waitFor((m) => isPersonaMessage(m, "Persona team:"), "status message (bound)", 15000, 0);
  assert.match(status1Msg.message.content, /Persona team: custom\/marketing/);

  // Explicit none: /persona status must say so plainly, not just "none" (as
  // if the team had simply never been configured), and round-tables must
  // refuse rather than silently falling back to some unrelated ctx.cwd
  // roster.
  const noneCursor = rpc.cursor();
  send(child, { id: "none", type: "prompt", message: "/persona team none" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to none"), "switch to none notice", 15000, noneCursor);
  await pollUntilCommand(child, rpc, (names) => !names.includes("market-lead"), "market-lead gone after explicit none");

  const statusNoneCursor = rpc.cursor();
  send(child, { id: "status-none", type: "prompt", message: "/persona status" });
  const statusNoneMsg = await rpc.waitFor((m) => isPersonaMessage(m, "Persona team:"), "status message (none)", 15000, statusNoneCursor);
  assert.match(statusNoneMsg.message.content, /Persona team: none \(no team is selected for this session/);

  const roundtableNoneCursor = rpc.cursor();
  send(child, { id: "roundtable-none", type: "prompt", message: '/persona-roundtable "Should we ship this?"' });
  const roundtableNoneError = await rpc.waitFor((m) => isPersonaMessage(m, "No persona team is bound"), "round-table guard (none)", 15000, roundtableNoneCursor);
  assert.match(roundtableNoneError.message.content, /Run \/persona team to choose one/);

  // The same guard blocks direct activation, not just round-tables.
  const useNoneCursor = rpc.cursor();
  send(child, { id: "use-none", type: "prompt", message: "/persona use market-lead" });
  const useNoneError = await rpc.waitFor((m) => isPersonaMessage(m, "No persona team is bound"), "direct activation guard (none)", 15000, useNoneCursor);
  assert.match(useNoneError.message.content, /Run \/persona team to choose one/);

  // Missing-bound: bind to Philosophy, invalidate it on disk, then reload
  // with no pending switch in flight (rehydrateBinding's path).
  const switchCursor = rpc.cursor();
  send(child, { id: "switch", type: "prompt", message: "/persona team custom/philosophy" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/philosophy'"), "switch notice", 15000, switchCursor);
  await pollUntilCommand(child, rpc, (names) => names.includes("philo-lead"), "philo-lead after switch");

  rmSync(path.join(storeRoot, "custom", "philosophy"), { recursive: true, force: true });
  const reloadCursor = rpc.cursor();
  send(child, { id: "reload", type: "prompt", message: "/probe-reload" });
  await rpc.waitFor((m) => isPersonaMessage(m, "could not be loaded"), "recovery notice", 15000, reloadCursor);
  await pollUntilCommand(child, rpc, (names) => !names.includes("philo-lead"), "philo-lead gone after failed rehydrate");

  const statusMissingCursor = rpc.cursor();
  send(child, { id: "status-missing", type: "prompt", message: "/persona status" });
  const statusMissingMsg = await rpc.waitFor((m) => isPersonaMessage(m, "Persona team:"), "status message (missing-bound)", 15000, statusMissingCursor);
  assert.match(statusMissingMsg.message.content, /Persona team: none \(the bound pack could not be loaded/);

  const roundtableMissingCursor = rpc.cursor();
  send(child, { id: "roundtable-missing", type: "prompt", message: '/persona-roundtable "Should we ship this?"' });
  const roundtableMissingError = await rpc.waitFor((m) => isPersonaMessage(m, "could not be loaded"), "round-table guard (missing-bound)", 15000, roundtableMissingCursor);
  assert.match(roundtableMissingError.message.content, /Run \/persona team to choose a valid pack/);

  // The same guard blocks direct activation, not just round-tables.
  const useMissingCursor = rpc.cursor();
  send(child, { id: "use-missing", type: "prompt", message: "/persona use philo-lead" });
  const useMissingError = await rpc.waitFor((m) => isPersonaMessage(m, "could not be loaded"), "direct activation guard (missing-bound)", 15000, useMissingCursor);
  assert.match(useMissingError.message.content, /Run \/persona team to choose a valid pack/);
});

test("recognized legacy project: a new session withholds the global default with a migration-required notice that blocks direct activation, but explicit /persona team still works", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-legacy-");
  await seedMarketingDefaultStore(agentDir);
  const workspace = mkdtempSync(path.join(tmpdir(), "pi-persona-team-legacy-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(path.join(workspace, ".pi/agents"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".pi/agents/coordinator.md"),
    "---\nname: coordinator\nrole: generalist\ndescription: Legacy project coordinator.\n---\nLegacy coordinator prompt.\n",
  );

  const { child, rpc } = startPersonaPi(agentDir, ["--no-session"], { cwd: workspace });
  t.after(() => stop(child));

  // The migration-required sendPersonaOutput() notice fires from the very
  // first session_start, before the RPC transport's own message listener is
  // attached (a host timing quirk confirmed by direct inspection, not
  // specific to this extension: a pi.sendMessage() call made synchronously
  // during process bootstrap is appended to the session and does reach
  // ctx.sessionManager.getBranch(), but its message_end event is emitted
  // before anything is listening for it over RPC and is never replayed).
  // Assert the behavior itself instead, which does not depend on that
  // timing: the default was withheld and the workspace's own legacy command
  // survives.
  const namesBefore = await getCommandNames(child, rpc);
  assert.ok(!namesBefore.includes("market-lead"), "the global default was withheld, not silently applied over the legacy project");
  assert.ok(namesBefore.includes("coordinator"), "the workspace's own legacy project command is still registered (visible), even though running it is now gated");

  // The migration gate blocks direct activation of that legacy command
  // instead of silently executing it against the unmigrated project: this is
  // the revised behavior (migration-required blocks incompatible persona
  // execution, not just status reporting), not the pre-existing ctx.cwd
  // fallback that "legacy" (never touched this feature) still keeps.
  const coordinatorCursor = rpc.cursor();
  send(child, { id: "coordinator-blocked", type: "prompt", message: "/coordinator" });
  const coordinatorError = await rpc.waitFor(
    (m) => isPersonaMessage(m, "Run /persona migrate inspect"),
    "migration gate blocks direct activation",
    15000,
    coordinatorCursor,
  );
  assert.match(coordinatorError.message.content, /run \/persona team to choose an already-installed persona team/);

  // Deliberate user action (Pi management / team recovery) still works: the
  // guard only blocks persona execution, never /persona team itself.
  const switchCursor = rpc.cursor();
  send(child, { id: "explicit-switch", type: "prompt", message: "/persona team custom/marketing" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/marketing'"), "explicit switch notice", 15000, switchCursor);
  const namesAfter = await pollUntilCommand(child, rpc, (names) => names.includes("market-lead"), "market-lead after explicit switch despite legacy guard");
  assert.ok(commandNames(namesAfter).includes("market-lead"));
});

test("a historical saved session predating this feature does not adopt the global default merely by being resumed with --session", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-historical-");
  await seedMarketingDefaultStore(agentDir);
  const sessionDir = mkdtempSync(path.join(tmpdir(), "pi-persona-team-historical-sessions-"));
  t.after(() => rmSync(sessionDir, { recursive: true, force: true }));
  // Same reasoning as the resume/fork tests above: resuming a session file
  // across separate startPi() calls needs one shared, explicit cwd.
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "pi-persona-team-historical-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  // Phase 1: build a session with a real prior conversation but WITHOUT
  // extensions/pi-persona.ts loaded at all -- exactly a session that
  // predates this feature, so it can never have recorded a team-binding
  // entry. entry-persistence-probe.ts's /seed appends a real "message" entry
  // (no LLM call); /seed-assistant flips Pi's disk-flush gate so the session
  // file resumed in phase 2 actually contains it.
  let sessionFile;
  {
    const { child, rpc } = startPi(
      ["--mode", "rpc", "--offline", "--no-extensions", "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts"), "--session-dir", sessionDir, "--approve"],
      { PI_CODING_AGENT_DIR: agentDir },
      { cwd: workspaceRoot },
    );
    try {
      let cursor = rpc.cursor();
      send(child, { id: "s1", type: "get_state" });
      const state1 = await rpc.waitFor((m) => m.id === "s1", "get_state #1", 15000, cursor);
      sessionFile = state1.data.sessionFile;

      cursor = rpc.cursor();
      send(child, { id: "seed", type: "prompt", message: "/seed" });
      await rpc.waitFor((m) => isNotify(m, "seeded:"), "seed notify", 15000, cursor);

      cursor = rpc.cursor();
      send(child, { id: "seed-assistant", type: "prompt", message: "/seed-assistant" });
      await rpc.waitFor((m) => isNotify(m, "seeded-assistant:"), "seed-assistant notify", 15000, cursor);
    } finally {
      await stop(child);
    }
  }

  // Phase 2: resume that historical session file, now WITH
  // extensions/pi-persona.ts loaded for the first time -- reason "startup",
  // same as any ordinary CLI boot, but with real prior "message" entries
  // already on the branch (unlike a genuinely fresh --no-session start).
  const { child, rpc } = startPi(
    ["--mode", "rpc", "--offline", "--extension", REAL_EXTENSION, "--session", sessionFile, "--session-dir", sessionDir, "--approve"],
    { PI_CODING_AGENT_DIR: agentDir },
    { cwd: workspaceRoot },
  );
  t.after(() => stop(child));

  const names = await getCommandNames(child, rpc);
  assert.ok(!names.includes("market-lead"), "the configured global default is withheld for a historical session that predates this feature");
  assert.ok(!names.includes("philo-lead"));
  assert.ok(names.includes("persona") && names.includes("persona-list"), "management commands are still available");

  // Explicit user action still works even though the default was withheld.
  const switchCursor = rpc.cursor();
  send(child, { id: "explicit-switch", type: "prompt", message: "/persona team custom/marketing" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/marketing'"), "explicit switch notice", 15000, switchCursor);
  await pollUntilCommand(child, rpc, (candidateNames) => candidateNames.includes("market-lead"), "market-lead after explicit switch on a historical session");
});

test("resume and fork preserve the team bound as of their branch point, not the current or default team", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-resume-fork-");
  await seedMarketingDefaultStore(agentDir);
  const sessionDir = mkdtempSync(path.join(tmpdir(), "pi-persona-team-resume-fork-sessions-"));
  t.after(() => rmSync(sessionDir, { recursive: true, force: true }));
  // Same reasoning as the branch-before-binding fork test above: resuming a
  // session file across separate startPi() calls needs one shared, explicit
  // cwd, not the harness's per-call default temp directory.
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "pi-persona-team-resume-fork-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  const base = ["--mode", "rpc", "--offline", "--extension", REAL_EXTENSION, "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts"), "--session-dir", sessionDir, "--approve"];
  const spawnBase = (extra = []) => startPi([...base, ...extra], { PI_CODING_AGENT_DIR: agentDir }, { cwd: workspaceRoot });

  // Build the original session: it starts with the Marketing default (this
  // store's only configured default), then switches to Philosophy. Two seed
  // points bracket that switch: preSwitchEntryId (Marketing still bound --
  // this is *after* the initial default, since that default is itself the
  // session's very first entry, before which there is nothing to fork to at
  // all) and postSwitchEntryId (Philosophy now bound). A synthetic assistant
  // message flips Pi's disk-flush gate so resuming below actually sees these
  // entries (same mechanism as the Task 1 branch-before-binding probe).
  let { child, rpc } = spawnBase();
  let sessionFile;
  let preSwitchEntryId;
  let postSwitchEntryId;
  try {
    let cursor = rpc.cursor();
    send(child, { id: "s1", type: "get_state" });
    const state1 = await rpc.waitFor((m) => m.id === "s1", "get_state #1", 15000, cursor);
    sessionFile = state1.data.sessionFile;

    cursor = rpc.cursor();
    send(child, { id: "seed1", type: "prompt", message: "/seed" });
    const seed1Notify = await rpc.waitFor((m) => isNotify(m, "seeded:"), "seed notify #1", 15000, cursor);
    preSwitchEntryId = seed1Notify.message.split("seeded:")[1];

    cursor = rpc.cursor();
    send(child, { id: "switch", type: "prompt", message: "/persona team custom/philosophy" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/philosophy'"), "switch notice", 15000, cursor);
    await pollUntilCommand(child, rpc, (names) => names.includes("philo-lead"), "philo-lead after switch");

    cursor = rpc.cursor();
    send(child, { id: "seed2", type: "prompt", message: "/seed" });
    const seed2Notify = await rpc.waitFor((m) => isNotify(m, "seeded:"), "seed notify #2", 15000, cursor);
    postSwitchEntryId = seed2Notify.message.split("seeded:")[1];

    cursor = rpc.cursor();
    send(child, { id: "seed-assistant", type: "prompt", message: "/seed-assistant" });
    await rpc.waitFor((m) => isNotify(m, "seeded-assistant:"), "seed-assistant notify", 15000, cursor);
  } finally {
    await stop(child);
  }

  // --- Resume: the freshly resumed process must rehydrate Philosophy (the
  // most recent binding), not fall back to the Marketing default or none. ---
  ({ child, rpc } = spawnBase(["--session", sessionFile]));
  try {
    const names = await getCommandNames(child, rpc);
    assert.ok(names.includes("philo-lead"), "resume preserves the most recently bound team identity");
    assert.ok(!names.includes("market-lead"), "resume does not fall back to the configured default");
  } finally {
    await stop(child);
  }

  // --- Fork before the switch: the forked branch inherits Marketing, the
  // team actually bound at that point in the source session -- not
  // Philosophy (the source session's *current* team) and not none. ---
  ({ child, rpc } = spawnBase(["--session", sessionFile]));
  try {
    const cursor = rpc.cursor();
    send(child, { id: "fork-pre", type: "fork", entryId: preSwitchEntryId });
    const forkResult = await rpc.waitFor((m) => m.id === "fork-pre", "fork response (pre-switch)", 15000, cursor);
    assert.equal(forkResult.success, true);
    assert.equal(forkResult.data.cancelled, false);

    const names = await getCommandNames(child, rpc);
    assert.ok(names.includes("market-lead"), "forking from before the switch inherits Marketing, the team bound at that branch point");
    assert.ok(!names.includes("philo-lead"), "forking from before the switch does not inherit Philosophy, the source session's later/current team");
  } finally {
    await stop(child);
  }

  // --- Control: fork after the switch, on a fresh resume of the same
  // original session file -- Philosophy must still be inherited here. ---
  ({ child, rpc } = spawnBase(["--session", sessionFile]));
  try {
    const cursor = rpc.cursor();
    send(child, { id: "fork-post", type: "fork", entryId: postSwitchEntryId });
    const forkResult = await rpc.waitFor((m) => m.id === "fork-post", "fork response (post-switch)", 15000, cursor);
    assert.equal(forkResult.success, true);
    assert.equal(forkResult.data.cancelled, false);

    const names = await getCommandNames(child, rpc);
    assert.ok(names.includes("philo-lead"), "forking from after the switch inherits Philosophy (control case, proves the pre-switch result above isn't just fork being broken)");
    assert.ok(!names.includes("market-lead"));
  } finally {
    await stop(child);
  }
});

// Writes a minimal, real legacy (pre-global-pack) Pi Persona project directly
// under workspace/.pi/agents/: one generalist lead plus one specialist, the
// smallest shape inspectLegacyMigration recognizes and previewPersonaMigration
// accepts (a lead alone is refused: "at least one approved specialist is
// required").
function writeLegacyProject(workspace, { leadName = "coordinator", specialistName = "writer" } = {}) {
  mkdirSync(path.join(workspace, ".pi/agents"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".pi/agents", `${leadName}.md`),
    `---\nname: ${leadName}\nrole: generalist\ndescription: Legacy project coordinator.\n---\nLegacy coordinator prompt.\n`,
  );
  writeFileSync(
    path.join(workspace, ".pi/agents", `${specialistName}.md`),
    `---\nname: ${specialistName}\nrole: specialist\ndescription: Legacy project specialist.\n---\nLegacy specialist prompt.\n`,
  );
}

test("historical resume of a genuine unmigrated legacy project evaluates the migration gate too, instead of silently keeping the pre-existing ctx.cwd fallback", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-historical-legacy-");
  const sessionDir = mkdtempSync(path.join(tmpdir(), "pi-persona-team-historical-legacy-sessions-"));
  t.after(() => rmSync(sessionDir, { recursive: true, force: true }));
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "pi-persona-team-historical-legacy-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  // Unlike the "historical saved session" test above, this workspace *is* a
  // recognized, unmigrated legacy project from the start -- the case that
  // test deliberately leaves untested (its workspace is an empty tempdir).
  writeLegacyProject(workspaceRoot);

  let sessionFile;
  {
    const { child, rpc } = startPi(
      ["--mode", "rpc", "--offline", "--no-extensions", "--extension", path.join(EXT_DIR, "entry-persistence-probe.ts"), "--session-dir", sessionDir, "--approve"],
      { PI_CODING_AGENT_DIR: agentDir },
      { cwd: workspaceRoot },
    );
    try {
      let cursor = rpc.cursor();
      send(child, { id: "s1", type: "get_state" });
      const state1 = await rpc.waitFor((m) => m.id === "s1", "get_state #1", 15000, cursor);
      sessionFile = state1.data.sessionFile;

      cursor = rpc.cursor();
      send(child, { id: "seed", type: "prompt", message: "/seed" });
      await rpc.waitFor((m) => isNotify(m, "seeded:"), "seed notify", 15000, cursor);

      cursor = rpc.cursor();
      send(child, { id: "seed-assistant", type: "prompt", message: "/seed-assistant" });
      await rpc.waitFor((m) => isNotify(m, "seeded-assistant:"), "seed-assistant notify", 15000, cursor);
    } finally {
      await stop(child);
    }
  }

  const { child, rpc } = startPi(
    ["--mode", "rpc", "--offline", "--extension", REAL_EXTENSION, "--session", sessionFile, "--session-dir", sessionDir, "--approve"],
    { PI_CODING_AGENT_DIR: agentDir },
    { cwd: workspaceRoot },
  );
  t.after(() => stop(child));

  const names = await getCommandNames(child, rpc);
  assert.ok(names.includes("coordinator"), "the workspace's own legacy command is still registered (visible)");

  // The old "legacy" exemption would have let this run against ctx.cwd
  // directly; the migration gate must refuse it instead, exactly like a
  // genuinely new session over the same workspace would (see "recognized
  // legacy project" above).
  const cursor = rpc.cursor();
  send(child, { id: "coordinator-blocked", type: "prompt", message: "/coordinator" });
  const blocked = await rpc.waitFor(
    (m) => isPersonaMessage(m, "Run /persona migrate inspect"),
    "migration gate blocks direct activation on a historical resume",
    15000,
    cursor,
  );
  assert.match(blocked.message.content, /run \/persona team to choose an already-installed persona team/);

  // Explicit /persona migrate status still works and agrees.
  const statusCursor = rpc.cursor();
  send(child, { id: "status", type: "prompt", message: "/persona migrate status" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Migration state: migration-required"), "migrate status on historical resume", 15000, statusCursor);
});

test("resolveMigrationGate fails closed (blocked) on a corrupted marker instead of defaulting to unblocked, and the underlying corruption is still an actionable diagnostic", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-team-corrupt-marker-");
  await seedMarketingDefaultStore(agentDir);
  const workspace = mkdtempSync(path.join(tmpdir(), "pi-persona-team-corrupt-marker-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeLegacyProject(workspace);
  mkdirSync(path.join(workspace, ".pi/persona-migration"), { recursive: true });
  writeFileSync(path.join(workspace, ".pi/persona-migration/marker.json"), "{ not valid json");

  const { child, rpc } = startPersonaPi(agentDir, ["--no-session"], { cwd: workspace });
  t.after(() => stop(child));

  // The session-start gate's own warning fires synchronously during process
  // bootstrap and is not reliably observable over RPC (same host timing
  // quirk the "recognized legacy project" test above documents); assert the
  // behavior it produces instead. A silently-unblocked gate (the pre-fix
  // behavior: `catch { return { blocked: false } }`) would have let the
  // configured global default apply here.
  const names = await getCommandNames(child, rpc);
  assert.ok(!names.includes("market-lead"), "no default is silently applied over a workspace whose migration state could not be determined");

  // The generic migration-required refusal (same wording regardless of
  // *why* the gate is blocked -- see assertPersonaExecutionAllowed) proves
  // this session actually landed in the blocked state, not just that the
  // default was withheld for some unrelated reason.
  const blockedCursor = rpc.cursor();
  send(child, { id: "coordinator-blocked", type: "prompt", message: "/coordinator" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Run /persona migrate inspect"), "corrupted marker leaves this session migration-required", 15000, blockedCursor);

  // The corruption itself is still surfaced as an actionable diagnostic, not
  // swallowed: /persona migrate status calls detectMigrationState directly
  // and reports whatever it throws.
  const statusCursor = rpc.cursor();
  send(child, { id: "status", type: "prompt", message: "/persona migrate status" });
  const statusError = await rpc.waitFor((m) => isPersonaMessage(m, "marker.json is corrupted"), "migrate status surfaces the corruption diagnostic", 15000, statusCursor);
  assert.match(statusError.message.content, /marker\.json is corrupted/);
});

test("/persona migrate inspect/preview/apply/status/rollback: full RPC lifecycle -- originals unchanged, marker invalidated on rollback, exact prior binding restored (migration-required, not none), destination pack never deleted", { timeout: 30_000 }, async (t) => {
  // This test's own workspace/store churn (multiple pack applies, migration
  // marker/receipt/backup writes) is heavier than the other RPC probes in
  // this file, so the child process must be stopped -- and stop waiting for
  // its real exit -- before its still-live PI_CODING_AGENT_DIR/workspace are
  // recursively removed out from under it: registering directory-removal
  // cleanup ahead of stop(child) (e.g. via the tempAgentDir() helper, which
  // registers its own t.after() at call time) races an in-flight write
  // against rm's directory walk (ENOTEMPTY). Same discipline as the
  // "command refresh" test above: stop(child) is registered first.
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-persona-migrate-rpc-agentdir-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "pi-persona-migrate-rpc-ws-"));
  writeLegacyProject(workspace, { leadName: "coordinator", specialistName: "writer" });
  const coordinatorPath = path.join(workspace, ".pi/agents/coordinator.md");
  const writerPath = path.join(workspace, ".pi/agents/writer.md");
  const originalCoordinator = await readFile(coordinatorPath, "utf8");
  const originalWriter = await readFile(writerPath, "utf8");

  const { child, rpc } = startPersonaPi(agentDir, ["--no-session"], { cwd: workspace });
  t.after(() => stop(child));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  // Fresh session over a recognized, unmigrated legacy project: the gate
  // blocks and this session's own binding is "migration-required" -- the
  // common real-world previousBinding /persona migrate apply captures below,
  // not an already-bound team.
  await getCommandNames(child, rpc);

  const inspectCursor = rpc.cursor();
  send(child, { id: "inspect", type: "prompt", message: "/persona migrate inspect" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Supported: yes"), "migrate inspect", 15000, inspectCursor);

  const previewCursor = rpc.cursor();
  send(child, { id: "preview", type: "prompt", message: "/persona migrate preview legacy-team --approve writer" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Destination: custom/legacy-team (new)"), "migrate preview", 15000, previewCursor);

  const applyCursor = rpc.cursor();
  send(child, { id: "apply", type: "prompt", message: "/persona migrate apply legacy-team" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Migration applied: custom/legacy-team"), "migrate apply", 15000, applyCursor);

  // Copy-only: the workspace's own files are byte-identical after preview
  // and apply.
  assert.equal(await readFile(coordinatorPath, "utf8"), originalCoordinator);
  assert.equal(await readFile(writerPath, "utf8"), originalWriter);

  const destinationDir = path.join(agentDir, "persona", "custom", "legacy-team");
  assert.ok(existsSync(destinationDir), "the destination pack was actually created in the global store");

  const statusAfterApplyCursor = rpc.cursor();
  send(child, { id: "status-after-apply", type: "prompt", message: "/persona migrate status" });
  const migratedStatus = await rpc.waitFor((m) => isPersonaMessage(m, "Migration state: migrated"), "migrate status after apply", 15000, statusAfterApplyCursor);
  assert.doesNotMatch(migratedStatus.message.content, /no longer gated/, "migration status must not claim the old project commands are enabled");
  assert.match(migratedStatus.message.content, /not selected or made default automatically/);

  // The session itself is no longer migration-required after apply: it is
  // plain "none", awaiting an explicit team choice -- nothing was bound,
  // activated, or defaulted by the apply.
  const sessionStatusCursor = rpc.cursor();
  send(child, { id: "session-status-after-apply", type: "prompt", message: "/persona status" });
  const sessionStatus = await rpc.waitFor((m) => isPersonaMessage(m, "Persona team:"), "session status after apply", 15000, sessionStatusCursor);
  assert.match(sessionStatus.message.content, /Persona team: none \(no team is selected for this session/);
  assert.doesNotMatch(sessionStatus.message.content, /predates global persona packs/);
  assert.match(sessionStatus.message.content, /Active persona: none/);
  assert.equal((await readGlobalDefaultPack(path.join(agentDir, "persona")))?.defaultPack ?? null, null, "apply never sets the new pack as the default");

  // Explicit-intent guard: rollback naming the wrong destination is refused,
  // not silently applied against whatever receipt happens to be on disk.
  const wrongNameCursor = rpc.cursor();
  send(child, { id: "rollback-wrong-name", type: "prompt", message: "/persona migrate rollback not-legacy-team" });
  await rpc.waitFor(
    (m) => isPersonaMessage(m, "this workspace's migration receipt is for 'custom/legacy-team'"),
    "rollback refuses a mismatched destination name",
    15000,
    wrongNameCursor,
  );

  // Real rollback: confirms the destination, which triggers a reload (see
  // switchPersonaTeam); the confirmation is reported by the fresh instance
  // after that reload completes, not by stale pre-reload output.
  const rollbackCursor = rpc.cursor();
  send(child, { id: "rollback", type: "prompt", message: "/persona migrate rollback legacy-team" });
  await rpc.waitFor(
    (m) => isPersonaMessage(m, "Persona team rolled back: this workspace's persona setup requires migration again"),
    "rollback restores migration-required (not none)",
    15000,
    rollbackCursor,
  );

  // Marker invalidated: status must report migration-required again, not
  // still "migrated" -- rollback's real contract, not merely a session-local
  // label change.
  const statusAfterRollbackCursor = rpc.cursor();
  send(child, { id: "status-after-rollback", type: "prompt", message: "/persona migrate status" });
  const rolledBackStatus = await rpc.waitFor((m) => isPersonaMessage(m, "Migration state: migration-required"), "migrate status after rollback", 15000, statusAfterRollbackCursor);
  assert.match(rolledBackStatus.message.content, /was rolled back at your request/);
  assert.doesNotMatch(rolledBackStatus.message.content, /repair|failed to write/, "a deliberate rollback is never presented as a failed marker to repair");
  const rolledBackReceipt = JSON.parse(await readFile(path.join(workspace, ".pi/persona-migration/receipt.json"), "utf8"));
  assert.equal(rolledBackReceipt.status, "rolled-back");
  assert.equal(typeof rolledBackReceipt.completedAt, "string", "the completed attempt's audit trail is kept");
  assert.ok(existsSync(path.join(workspace, ".pi/persona-migration/backup")), "the private backup is kept");

  // Direct activation is blocked again post-rollback -- proves the reload
  // actually landed the new "migration-required" binding for this session,
  // not just a status-report label.
  const blockedAgainCursor = rpc.cursor();
  send(child, { id: "blocked-again", type: "prompt", message: "/coordinator" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Run /persona migrate inspect"), "coordinator blocked again after rollback", 15000, blockedAgainCursor);

  // Rollback never deletes the migrated pack or touches the workspace's
  // original files.
  assert.ok(existsSync(destinationDir), "rollback does not delete the destination pack from the global store");
  assert.equal(await readFile(coordinatorPath, "utf8"), originalCoordinator);
  assert.equal(await readFile(writerPath, "utf8"), originalWriter);

  // Rolling back again (receipt now describes an already-rolled-back
  // "completed" attempt -- rollback does not mutate the receipt, only the
  // marker) is idempotent, not an error: it restores the same
  // migration-required binding again.
  const secondRollbackCursor = rpc.cursor();
  send(child, { id: "rollback-again", type: "prompt", message: "/persona migrate rollback legacy-team" });
  await rpc.waitFor(
    (m) => isPersonaMessage(m, "Persona team rolled back: this workspace's persona setup requires migration again"),
    "rollback is safe to repeat",
    15000,
    secondRollbackCursor,
  );
});

test("/persona pack lifecycle over RPC: install, fork, preview/apply a draft, and remove, with scripted confirm dialogs and no paid model calls", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-pack-rpc-lifecycle-");
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session"]);
  t.after(() => stop(child));

  // install: immediate, no confirmation.
  const installCursor = rpc.cursor();
  send(child, { id: "install", type: "prompt", message: "/persona pack install philosopher-7" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Installed persona pack 'official/philosopher-7'"), "install notice", 15000, installCursor);

  // fork: immediate, no confirmation -- nothing it touches is active/shared
  // content yet.
  const forkCursor = rpc.cursor();
  send(child, { id: "fork", type: "prompt", message: "/persona pack fork philosopher-7 my-fork" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Forked 'official/philosopher-7' into 'custom/my-fork'"), "fork notice", 15000, forkCursor);

  // edit + preview: stage and inspect a draft, still immediate.
  const editCursor = rpc.cursor();
  send(child, { id: "edit", type: "prompt", message: "/persona pack edit my-fork" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Started editing draft for 'my-fork'"), "edit draft notice", 15000, editCursor);

  const previewCursor = rpc.cursor();
  send(child, { id: "preview", type: "prompt", message: "/persona pack preview my-fork" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Draft for 'my-fork'"), "preview notice", 15000, previewCursor);

  // apply: real consequence -- the command handler fetches its own plan,
  // shows a ctx.ui.confirm dialog, and only applies once this test answers
  // it (scripted "yes", not a live terminal or any model call).
  const applyCursor = rpc.cursor();
  send(child, { id: "apply", type: "prompt", message: "/persona pack apply my-fork" });
  await answerConfirm(child, rpc, true, applyCursor);
  await rpc.waitFor((m) => isPersonaMessage(m, "Applied the draft for 'custom/my-fork'"), "apply notice", 15000, applyCursor);

  // remove (delete, since my-fork is custom): another real-consequence
  // action gated the same way.
  const deleteCursor = rpc.cursor();
  send(child, { id: "delete", type: "prompt", message: "/persona pack delete my-fork" });
  await answerConfirm(child, rpc, true, deleteCursor);
  await rpc.waitFor((m) => isPersonaMessage(m, "Deleted persona pack 'custom/my-fork'"), "delete notice", 15000, deleteCursor);

  const storeRoot = path.join(agentDir, "persona");
  assert.ok(!existsSync(path.join(storeRoot, "custom", "my-fork")), "delete actually removed the pack from the store, not just reported success");
  assert.ok(existsSync(path.join(storeRoot, "official", "philosopher-7")), "the original official install is untouched by forking/deleting its fork");
});

test("/persona pack apply: declining the confirm dialog leaves the draft pending and the store unmutated", { timeout: 30_000 }, async (t) => {
  const agentDir = await tempAgentDir(t, "pi-persona-pack-rpc-decline-");
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session"]);
  t.after(() => stop(child));

  const createCursor = rpc.cursor();
  send(child, { id: "create", type: "prompt", message: "/persona pack create council" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Started a new draft for 'council'"), "create draft notice", 15000, createCursor);

  const applyCursor = rpc.cursor();
  send(child, { id: "apply", type: "prompt", message: "/persona pack apply council" });
  await answerConfirm(child, rpc, false, applyCursor);
  await rpc.waitFor((m) => isPersonaMessage(m, "Cancelled."), "cancelled notice", 15000, applyCursor);

  const storeRoot = path.join(agentDir, "persona");
  assert.ok(!existsSync(path.join(storeRoot, "custom", "council")), "declining the confirm dialog must not create the custom pack");
  assert.ok(existsSync(path.join(storeRoot, "drafts", "council")), "the draft itself survives a decline, ready to be applied later");
});

test("a workspace already migrated to a global custom pack, with no default configured, starts a fresh session with no team bound instead of silently reviving the superseded ctx.cwd roster", { timeout: 45_000 }, async (t) => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-persona-migrated-no-default-agentdir-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "pi-persona-migrated-no-default-ws-"));
  writeLegacyProject(workspace, { leadName: "coordinator", specialistName: "writer" });

  // Phase 1: migrate the legacy project into the global store. No default is
  // ever configured -- this store never has one.
  {
    const { child, rpc } = startPersonaPi(agentDir, ["--no-session"], { cwd: workspace });
    try {
      await getCommandNames(child, rpc);
      const previewCursor = rpc.cursor();
      send(child, { id: "preview", type: "prompt", message: "/persona migrate preview legacy-team --approve writer" });
      await rpc.waitFor((m) => isPersonaMessage(m, "Destination: custom/legacy-team (new)"), "migrate preview", 15000, previewCursor);
      const applyCursor = rpc.cursor();
      send(child, { id: "apply", type: "prompt", message: "/persona migrate apply legacy-team" });
      await rpc.waitFor((m) => isPersonaMessage(m, "Migration applied: custom/legacy-team"), "migrate apply", 15000, applyCursor);
    } finally {
      await stop(child);
    }
  }
  assert.ok(existsSync(path.join(agentDir, "persona", "custom", "legacy-team")), "the destination pack was actually created");

  // Phase 2: a genuinely fresh session over the same now-migrated workspace,
  // still no default configured. detectMigrationState reports "migrated"
  // here, not "not-legacy" (the workspace's own original files are still on
  // disk, untouched by migration) and not "migration-required" (the marker
  // is valid and unchanged) -- so this must land on "none", never the old
  // "legacy" ctx.cwd fallback that would silently keep serving the
  // now-superseded coordinator/writer roster.
  const { child, rpc } = startPersonaPi(agentDir, ["--no-session"], { cwd: workspace });
  // Registered before the agentDir/workspace cleanup below: node:test runs
  // t.after hooks in registration order, so the child is always killed
  // before its still-live PI_CODING_AGENT_DIR/cwd are recursively removed
  // out from under it (same discipline as the "command refresh" and "full
  // RPC lifecycle" tests above -- registering directory removal first races
  // an in-flight write against rm's directory walk (ENOTEMPTY), and if that
  // throws, the later-registered stop(child) hook never runs, leaking the
  // child process and hanging the whole run).
  t.after(() => stop(child));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const names = await getCommandNames(child, rpc);
  assert.ok(names.includes("coordinator"), "the workspace's own legacy command is still visible (registerProjectCommands is unconditional while unbound)");
  assert.ok(names.includes("persona") && names.includes("persona-list"), "management commands remain available");

  const blockedCursor = rpc.cursor();
  send(child, { id: "coordinator-blocked", type: "prompt", message: "/coordinator" });
  await rpc.waitFor(
    (m) => isPersonaMessage(m, "No persona team is bound. Run /persona team to choose one."),
    "migrated-with-no-default must gate direct activation like 'none', not silently run the superseded legacy roster",
    15000,
    blockedCursor,
  );

  // Explicit user action still works: the user can bind the migrated pack
  // themselves even though it never became the default. (Not exercising
  // direct activation post-switch here -- that would risk sending a real
  // launch user-message/model turn; other tests already cover a completed
  // switch end-to-end.)
  const switchCursor = rpc.cursor();
  send(child, { id: "explicit-switch", type: "prompt", message: "/persona team custom/legacy-team" });
  await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/legacy-team'"), "explicit switch notice", 15000, switchCursor);
});
