// Guards on the chat-approved handoff (persona_pack team -> /persona
// chat-handoff) that a real RPC host cannot easily provoke on demand: a
// branch/session change before the handoff runs, Pi turning busy right
// before commit, a declined reload, and forged or reused approvals. The host
// is a minimal fake of the ExtensionAPI surface the extension uses; the real
// host path is covered by test/persona-chat-first-rpc.test.js.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readPortablePersonaPack } from "../src/persona/pack-source.js";
import { applyCustomPersonaPackDraft, stageCustomPersonaPackDraft } from "../src/persona/global-pack-store.js";
import { TEAM_BINDING_ENTRY_TYPE, TEAM_PENDING_ENTRY_TYPE, inspectTeamEntries, readGlobalDefaultPack, writeGlobalDefaultPack } from "../src/persona/pack-session.js";
import { listGlobalPersonaPacks } from "../src/persona/global-pack-store.js";
import { readMigrationRecord } from "../src/persona/pack-migration.js";
import { readFile } from "node:fs/promises";

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

async function installPack(storeRoot, name, lead, specialist) {
  const dir = await mkdtemp(path.join(tmpdir(), `pi-persona-handoff-src-${name}-`));
  try {
    await writeText(path.join(dir, "pack.yaml"), `schema: 2\nname: ${name}\nversion: 1.0.0\ndescription: ${name}.\n`);
    for (const [agent, role] of [[lead, "generalist"], [specialist, "specialist"]]) {
      await writeText(path.join(dir, "agents", `${agent}.md`), `---\nname: ${agent}\nrole: ${role}\ndescription: ${agent}.\n---\n${agent} body.\n`);
    }
    await writeText(path.join(dir, "references", "_index.md"), `# ${name}\n`);
    await stageCustomPersonaPackDraft(storeRoot, name, await readPortablePersonaPack(dir, { type: "path", ref: dir }));
    await applyCustomPersonaPackDraft(storeRoot, name);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let entryCounter = 0;
function userMessage(text) {
  entryCounter += 1;
  return { type: "message", id: `u${entryCounter}`, message: { role: "user", content: [{ type: "text", text }] } };
}

// Registers the extension against a fake host. `state.idle` (a boolean, or
// a function called on every ctx.isIdle()) and `state.reloadHappens` script
// the host; entries are the session branch. `seedCwd` runs before
// session_start, e.g. to plant a legacy workspace.
async function createHost(t, { seedCwd } = {}) {
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-handoff-agentdir-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-persona-handoff-cwd-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  const storeRoot = path.join(agentDir, "persona");
  await installPack(storeRoot, "marketing", "market-lead", "market-analyst");
  await installPack(storeRoot, "philosophy", "philo-lead", "philo-scout");
  await writeGlobalDefaultPack(storeRoot, "custom/marketing");
  await seedCwd?.(cwd);

  const { default: registerPiPersona } = await import(`../extensions/pi-persona.ts?host=${Math.random()}`);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const messages = [];
  const dispatched = [];
  const state = { idle: true, reloadHappens: true, reloads: 0, sessionId: "session-1" };
  const pi = {
    registerTool: (spec) => tools.set(spec.name, spec),
    registerCommand: (name, spec) => commands.set(name, spec),
    on: (event, handler) => handlers.set(event, handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", id: `c${entries.length}`, customType, data }),
    sendMessage: (message) => messages.push(String(message.content)),
    sendUserMessage: (message, options) => dispatched.push({ message, options }),
  };
  const ctx = {
    cwd,
    ui: { notify() {}, setStatus() {} },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => state.sessionId,
    },
    isIdle: () => (typeof state.idle === "function" ? state.idle() : state.idle),
    async waitForIdle() {},
    async reload() {
      state.reloads += 1;
      if (state.reloadHappens) await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
    },
  };
  registerPiPersona(pi);
  await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
  const tool = tools.get("persona_pack");
  const run = (params) => tool.execute("call", params, undefined, undefined, ctx);
  const handoff = async () => {
    const last = dispatched.at(-1);
    assert.ok(last, "an approved change must dispatch a handoff");
    assert.equal(last.options?.expandPromptTemplates, true, "the handoff must reach the command registry, not the model");
    await commands.get("persona").handler(last.message.replace(/^\/persona /, ""), ctx);
  };
  // Plan in one user turn, approve in the next.
  const planAndApprove = async (params) => {
    entries.push(userMessage("please"));
    const plan = await run(params);
    assert.equal(plan.details.mode, "confirm-required", JSON.stringify(plan));
    entries.push(userMessage("yes"));
    return run({ ...params, confirmed: true, planId: plan.details.planId });
  };
  const command = (args) => commands.get("persona").handler(args, ctx);
  return { cwd, storeRoot, entries, messages, dispatched, state, run, handoff, planAndApprove, command, tool };
}

const pendingEntries = (entries) => entries.filter((entry) => entry.customType === TEAM_PENDING_ENTRY_TYPE);

test("an approved team switch commits a pending entry and reloads exactly once", async (t) => {
  const host = await createHost(t);
  const approved = await host.planAndApprove({ action: "team", target: "philosophy" });
  assert.equal(approved.details.mode, "scheduled");
  assert.equal(approved.terminate, true);
  assert.equal(pendingEntries(host.entries).length, 0, "nothing is written until the handoff runs");
  await host.handoff();
  assert.equal(host.state.reloads, 1);
  assert.deepEqual(pendingEntries(host.entries).map((entry) => entry.data.target), ["custom/philosophy"]);
});

test("a fabricated or already-used planId never schedules anything", async (t) => {
  const host = await createHost(t);
  host.entries.push(userMessage("switch"), userMessage("yes"));
  const forged = await host.run({ action: "team", target: "philosophy", confirmed: true, planId: "0".repeat(64) });
  assert.equal(forged.isError, true);
  assert.match(forged.content[0].text, /not shown in this session/);

  host.entries.push(userMessage("switch"));
  const plan = await host.run({ action: "team", target: "none" });
  host.entries.push(userMessage("yes"));
  const params = { action: "team", target: "none", confirmed: true, planId: plan.details.planId };
  assert.equal((await host.run(params)).details.mode, "scheduled");
  await host.handoff();
  host.entries.push(userMessage("again"));
  const reused = await host.run(params);
  assert.equal(reused.isError, true);
  assert.match(reused.content[0].text, /not shown in this session/, "a used planId is gone, not merely blocked");
  assert.equal(host.dispatched.length, 1);
});

test("a plan from another session id is refused", async (t) => {
  const host = await createHost(t);
  host.entries.push(userMessage("switch"));
  const plan = await host.run({ action: "team", target: "philosophy" });
  host.state.sessionId = "session-2";
  host.entries.push(userMessage("yes"));
  const approved = await host.run({ action: "team", target: "philosophy", confirmed: true, planId: plan.details.planId });
  assert.equal(approved.isError, true);
  assert.equal(host.dispatched.length, 0);
});

test("the handoff does nothing if the conversation moved to another branch before it ran", async (t) => {
  const host = await createHost(t);
  await host.planAndApprove({ action: "team", target: "philosophy" });
  // /tree navigation replaces the branch: the approval's anchor is gone.
  host.entries.splice(0, host.entries.length, userMessage("elsewhere"));
  await host.handoff();
  assert.equal(host.state.reloads, 0);
  assert.equal(pendingEntries(host.entries).length, 0);
  assert.match(host.messages.at(-1), /different session or branch/);
});

test("the handoff does nothing if Pi is busy again right before commit", async (t) => {
  const host = await createHost(t);
  await host.planAndApprove({ action: "team", target: "philosophy" });
  host.state.idle = false;
  await host.handoff();
  assert.equal(host.state.reloads, 0);
  assert.equal(pendingEntries(host.entries).length, 0, "no pending entry is left for a later reload to replay");
  assert.match(host.messages.at(-1), /still busy/);
});

test("a declined reload settles its pending entry so no later reload replays it", async (t) => {
  const host = await createHost(t);
  await host.planAndApprove({ action: "team", target: "philosophy" });
  host.state.reloadHappens = false;
  await host.handoff();
  assert.equal(host.state.reloads, 1);
  const pendings = pendingEntries(host.entries);
  assert.equal(pendings.length, 2);
  assert.equal(pendings.at(-1).data.cancelled, true);
  assert.equal(inspectTeamEntries(host.entries).unresolvedPending, undefined);
  assert.equal(inspectTeamEntries(host.entries).binding?.qualifiedName, "custom/marketing", "the previous binding stays the truth");
  assert.match(host.messages.at(-1), /did not reload/);
});

test("a stale or unknown handoff nonce changes nothing", async (t) => {
  const host = await createHost(t);
  await host.planAndApprove({ action: "team", target: "philosophy" });
  await host.handoff();
  const reloads = host.state.reloads;
  await host.handoff(); // same nonce again: already consumed
  assert.equal(host.state.reloads, reloads);
  assert.match(host.messages.at(-1), /no longer current/);
});

test("clearing the default via chat needs approval and never touches the session binding", async (t) => {
  const host = await createHost(t);
  const bindingsBefore = host.entries.filter((entry) => entry.customType === TEAM_BINDING_ENTRY_TYPE).length;
  const applied = await host.planAndApprove({ action: "default", target: "none" });
  assert.match(applied.content[0].text, /Default team cleared/);
  assert.equal(host.entries.filter((entry) => entry.customType === TEAM_BINDING_ENTRY_TYPE).length, bindingsBefore);
  assert.equal(host.dispatched.length, 0, "a default change needs no reload");
});

test("default targets are trimmed before the none check and name resolution", async (t) => {
  const host = await createHost(t);
  const set = await host.planAndApprove({ action: "default", target: "  philosophy " });
  assert.match(set.content[0].text, /Default team set to 'custom\/philosophy'/);
  const cleared = await host.planAndApprove({ action: "default", target: " none " });
  assert.match(cleared.content[0].text, /Default team cleared/);
  assert.equal((await readGlobalDefaultPack(host.storeRoot))?.defaultPack ?? null, null);
  const shown = await host.run({ action: "default", target: "   " });
  assert.equal(shown.details.mode, "status", "a blank target only reports");
});

test("migrate without an operation diagnoses the operation, not the target", async (t) => {
  const host = await createHost(t);
  const result = await host.run({ action: "migrate" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /needs operation: inspect, status, preview, cancel, apply, or rollback/);
  assert.doesNotMatch(result.content[0].text, /target/);
});

const LEGACY_WRITER = "---\nname: writer\nrole: specialist\ndescription: Legacy specialist.\n---\nLegacy specialist prompt.\n";
async function seedLegacy(cwd) {
  await writeText(path.join(cwd, ".pi/agents/coordinator.md"), "---\nname: coordinator\nrole: generalist\ndescription: Legacy coordinator.\n---\nLegacy coordinator prompt.\n");
  await writeText(path.join(cwd, ".pi/agents/writer.md"), LEGACY_WRITER);
}

const hasPack = async (host, name) => (await listGlobalPersonaPacks(host.storeRoot)).custom.some((pack) => pack.name === name);

test("slash migrate apply refuses a draft edited after its preview", async (t) => {
  const host = await createHost(t, { seedCwd: seedLegacy });
  await host.command("migrate preview legacy-team --approve writer");
  const draftWriter = path.join(host.storeRoot, "drafts", "legacy-team", "agents", "writer.md");
  await writeFile(draftWriter, (await readFile(draftWriter, "utf8")).replace("Legacy specialist prompt.", "Tampered prompt."));
  await host.command("migrate apply legacy-team");
  assert.match(host.messages.at(-1), /migration draft for 'custom\/legacy-team' changed since it was last previewed/);
  assert.equal(await hasPack(host, "legacy-team"), false);
  assert.equal((await readMigrationRecord(host.cwd))?.receipt?.status, "failed", "the refused attempt is recorded truthfully");
});

// Migrates through the chat path, then approves a rollback; returns the host
// with the rollback handoff dispatched but not yet run.
async function migratedHostWithApprovedRollback(t) {
  const host = await createHost(t, { seedCwd: seedLegacy });
  await host.run({ action: "migrate", operation: "preview", target: "legacy-team", approvedPersonas: ["writer"] });
  const applied = await host.planAndApprove({ action: "migrate", operation: "apply", target: "legacy-team" });
  assert.match(applied.content[0].text, /Migration applied: custom\/legacy-team/);
  const rollback = await host.planAndApprove({ action: "migrate", operation: "rollback", target: "legacy-team" });
  assert.equal(rollback.details.mode, "scheduled");
  return host;
}

async function assertMigrationKept(host) {
  assert.equal(await hasPack(host, "legacy-team"), true, "the migrated pack is kept");
  assert.equal(await readFile(path.join(host.cwd, ".pi/agents/writer.md"), "utf8"), LEGACY_WRITER, "originals untouched");
}

test("a rollback handoff that finds Pi busy changes nothing on disk or in the session", async (t) => {
  const host = await migratedHostWithApprovedRollback(t);
  host.state.idle = false;
  await host.handoff();
  assert.match(host.messages.at(-1), /migration was not rolled back and nothing changed/);
  const record = await readMigrationRecord(host.cwd);
  assert.equal(record.receipt.status, "completed");
  assert.ok(record.marker, "marker intact");
  assert.equal(pendingEntries(host.entries).length, 0);
  assert.equal(host.state.reloads, 0);
  await assertMigrationKept(host);
});

test("a rollback handoff that turns busy after the disk step reports the partial rollback and recovers by repeating it", async (t) => {
  const host = await migratedHostWithApprovedRollback(t);
  let calls = 0;
  host.state.idle = () => (calls += 1) === 1; // idle for the disk step, busy at the session switch
  await host.handoff();
  const report = host.messages.at(-1);
  assert.match(report, /was rolled back on disk/);
  assert.match(report, /session's persona team was not restored, because Pi was busy/);
  assert.match(report, /Run \/persona migrate rollback legacy-team again/);
  assert.doesNotMatch(report, /nothing changed/);
  const record = await readMigrationRecord(host.cwd);
  assert.equal(record.receipt.status, "rolled-back");
  assert.equal(record.marker, null);
  assert.equal(pendingEntries(host.entries).length, 0, "no half-written switch");
  assert.equal(host.state.reloads, 0);
  await assertMigrationKept(host);

  // Recovery: the advertised retry restores the session's pre-migration state.
  host.state.idle = true;
  await host.command("migrate rollback legacy-team");
  assert.equal(host.state.reloads, 1);
  const restored = pendingEntries(host.entries).at(-1).data;
  assert.equal(restored.target, null);
  assert.equal(restored.bindingStatus, "migration-required", "restores the exact pre-migration state, not plain none");
  await assertMigrationKept(host);
});

test("a rollback whose reload is declined reports the partial rollback, not nothing changed", async (t) => {
  const host = await migratedHostWithApprovedRollback(t);
  host.state.reloadHappens = false;
  await host.handoff();
  const report = host.messages.at(-1);
  assert.match(report, /was rolled back on disk/);
  assert.match(report, /because Pi did not reload/);
  assert.equal(inspectTeamEntries(host.entries).unresolvedPending, undefined);
  await assertMigrationKept(host);
});

// Findings from the real-model TUI acceptance pass (chat-first progress doc).
const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const panelText = (host, result) => host.tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, {}).text;
const AGENT_ONLY = /planId|"confirmed"|do not tell the user|persona_pack|\/persona |--approve|--lead|--baseline/;

test("a target-less status lists packs and drafts instead of throwing", async (t) => {
  const host = await createHost(t);
  const result = await host.run({ action: "status" });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, /custom\/marketing/);
  assert.match(result.content[0].text, /Pending drafts/);
});

test("draft actions accept a custom/ qualified name and refuse an official one", async (t) => {
  const host = await createHost(t);
  const edit = await host.run({ action: "edit", target: "custom/marketing" });
  assert.notEqual(edit.isError, true, edit.content[0].text);
  assert.equal(edit.details.mode, "draft");
  assert.equal(edit.details.name, "marketing");
  const preview = await host.run({ action: "preview", target: "custom/marketing" });
  assert.equal(preview.details.mode, "preview");
  const cancel = await host.run({ action: "cancel", target: "custom/marketing" });
  assert.notEqual(cancel.isError, true, cancel.content[0].text);
  const fork = await host.run({ action: "fork", source: "custom/marketing", target: "custom/my-marketing" });
  assert.equal(fork.details.qualifiedName, "custom/my-marketing");
  const official = await host.run({ action: "edit", target: "official/marketing" });
  assert.equal(official.isError, true);
  assert.match(official.content[0].text, /fork it into a custom pack first/);
});

test("the tool panel shows people a plan, never the agent's retry parameters or notes", async (t) => {
  const host = await createHost(t);
  host.entries.push(userMessage("switch to philosophy"));
  const plan = await host.run({ action: "team", target: "philosophy" });
  assert.match(plan.content[0].text, new RegExp(plan.details.planId), "the model still gets the exact retry");
  const shown = panelText(host, plan);
  assert.match(shown, /Switch this session's persona team/);
  assert.match(shown, /Nothing has changed yet/);
  assert.doesNotMatch(shown, AGENT_ONLY);

  host.entries.push(userMessage("yes"));
  const scheduled = await host.run({ action: "team", target: "philosophy", confirmed: true, planId: plan.details.planId });
  assert.match(scheduled.content[0].text, /do not tell the user it is done/);
  assert.doesNotMatch(panelText(host, scheduled), AGENT_ONLY);

  const edit = await host.run({ action: "edit", target: "philosophy" });
  assert.match(edit.content[0].text, /call persona_pack preview/, "the model is told how to continue");
  assert.doesNotMatch(edit.content[0].text, /\/persona pack/, "chat results do not prescribe slash commands");
  assert.doesNotMatch(panelText(host, edit), AGENT_ONLY);
  host.entries.push(userMessage("apply it"));
  const applyPlan = await host.run({ action: "apply", target: "philosophy" });
  assert.match(applyPlan.content[0].text, /"confirmed":true/);
  assert.doesNotMatch(panelText(host, applyPlan), AGENT_ONLY);
});

test("chat migration reports explain without slash syntax; the command keeps its hints", async (t) => {
  const host = await createHost(t, { seedCwd: seedLegacy });
  const inspect = await host.run({ action: "migrate", operation: "inspect" });
  assert.match(inspect.content[0].text, /What migration would do/);
  assert.doesNotMatch(inspect.content[0].text, /\/persona |--approve|--lead/);
  const preview = await host.run({ action: "migrate", operation: "preview", target: "legacy-team", approvedPersonas: ["writer"] });
  assert.match(preview.content[0].text, /"operation":"apply"/, "the model still learns how to request the apply plan");
  assert.doesNotMatch(panelText(host, preview), AGENT_ONLY);
  const status = await host.run({ action: "migrate", operation: "status" });
  assert.doesNotMatch(status.content[0].text, /\/persona /);
  const team = await host.run({ action: "team" });
  assert.doesNotMatch(team.content[0].text, /\/persona /);

  await host.command("migrate inspect");
  assert.match(host.messages.at(-1), /Next: \/persona migrate preview <name> --approve/);
});

test("after applying a pack edit the agent is told to offer session and default as separate choices", async (t) => {
  const host = await createHost(t);
  await host.run({ action: "edit", target: "philosophy" });
  await writeText(path.join(host.storeRoot, "drafts", "philosophy", "agents", "philo-critic.md"), "---\nname: philo-critic\nrole: specialist\ndescription: Critic.\n---\nCritic body.\n");
  const applied = await host.planAndApprove({ action: "apply", target: "philosophy" });
  assert.equal(applied.details.mode, "apply", applied.content[0].text);
  assert.match(applied.content[0].text, /Offer to use 'custom\/philosophy' in this session \(persona_pack action team\) or to make it the default/);
  assert.doesNotMatch(panelText(host, applied), AGENT_ONLY);
});
