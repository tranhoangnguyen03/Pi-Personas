#!/usr/bin/env node
// Task 8 packed acceptance: exercises the actual `npm pack` tarball, installed
// into a disposable project outside this checkout (its own node_modules, no
// checkout-relative import), against a real `pi` binary over RPC. No paid
// model calls; the one native-child scenario that needs a model uses a local
// HTTP mock (same pattern as test/persona-pack-session.test.js), never a real
// provider. Not run by `npm test` (node:test does not discover this path);
// run it explicitly with `node scripts/task8-packed-acceptance/run-acceptance.mjs`.
//
// What this proves that the existing `test/*.test.js` suite (which drives
// extensions/pi-persona.ts and src/persona/*.js from this checkout) does not:
// that the *published package layout* (files: [...] in package.json, the
// tarball's actual contents) round-trips through `npm pack` -> `npm install`
// -> a real `pi` process, including child-entry.js's dynamic import of the
// host Pi SDK resolving from the installed @earendil-works/pi-coding-agent,
// not any relative path back into this repo.
//
// Command-sequence scenarios below intentionally mirror already-proven
// sequences in test/persona-team-rpc.test.js (exact message strings, same
// confirm-dialog choreography) -- this script does not re-derive new
// behavior contracts, it re-runs the proven ones against the packed artifact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { startPi, send, stop, answerConfirm } from "./rpc-harness.mjs";
import { startMockModel, retryFromToolResult } from "../../test/.fixtures/persona-team-rpc/mock-model.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "..", "..");

const results = [];
const notChecked = [
  "Interactive TUI rendering (this harness drives RPC mode only; no terminal/rendering was exercised).",
  "Provider-backed model quality/output judgement (only a local zero-cost HTTP mock model was used; no paid provider).",
  "Downgrade-version execution against an older published pi-personas or pi-coding-agent release (no network registry access was used; only locally available package versions were exercised).",
  "The extension's persona_consult-to-runPersonaChild wiring: the host-SDK scenario calls runPersonaChild() directly (same pattern as test/persona-pack-session.test.js), not through a real top-level model deciding to call the persona_consult tool over RPC. Direct child-runner invocation is tested; extension wiring from a live consult tool call through to runPersonaChild is not.",
];

async function scenario(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - startedAt });
    console.log(`PASS  ${name} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - startedAt, error: err.stack ?? String(err) });
    console.log(`FAIL  ${name} (${Date.now() - startedAt}ms)`);
    console.log(err.stack ?? err);
  }
}

function isPersonaMessage(m, substring) {
  return m.type === "message_end" && m.message?.customType === "pi-persona" && String(m.message.content).includes(substring);
}

async function tempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

// ---------------------------------------------------------------------------
// Setup: build the real tarball (unless PI_PERSONA_TGZ is already provided),
// install it plus its host peers into a disposable project outside this repo.
// ---------------------------------------------------------------------------

async function buildTarball() {
  if (process.env.PI_PERSONA_TGZ) return process.env.PI_PERSONA_TGZ;
  const destDir = await tempDir("pi-persona-acceptance-tgz-");
  execFileSync("npm", ["pack", "--pack-destination", destDir], { cwd: REPO_ROOT, stdio: "inherit" });
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  return path.join(destDir, `${pkg.name}-${pkg.version}.tgz`);
}

async function sha256(filePath) {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

// Packs each host peer dependency into a real tarball first (rather than
// pointing `npm install` at its node_modules directory) because npm installs
// a bare local-directory path as a symlink back to that directory -- which
// would silently defeat this scenario's whole point (proving the installed
// artifact resolves the host SDK from its own node_modules, not a
// checkout-relative path). A packed tarball installs as an ordinary,
// non-symlinked copy, matching what a real npm-registry install would do.
async function packPeerDependency(pkgDir, destDir) {
  execFileSync("npm", ["pack", "--pack-destination", destDir], { cwd: pkgDir, stdio: "inherit" });
  const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const scopelessName = pkg.name.replace(/^@/, "").replace("/", "-");
  return path.join(destDir, `${scopelessName}-${pkg.version}.tgz`);
}

async function setupDisposableProject(tgzPath) {
  const projectDir = process.env.PI_PERSONA_DISPOSABLE_PROJECT ?? (await tempDir("pi-persona-acceptance-project-"));
  if (!process.env.PI_PERSONA_DISPOSABLE_PROJECT) {
    await writeText(path.join(projectDir, "package.json"), JSON.stringify({ name: "pi-persona-acceptance-project", private: true, version: "0.0.0" }, null, 2));
    const peerTgzDir = await tempDir("pi-persona-acceptance-peer-tgz-");
    // pi-personas itself declares a real (non-peer) `dependencies` entry on
    // `yaml`; pack it from this checkout's own node_modules too, exactly
    // like the host peers below, so --offline below has every dependency
    // available as an explicit local tarball instead of silently depending
    // on whatever happens to already be in npm's shared cache.
    const [piCodingAgentTgz, piTuiTgz, typeboxTgz, yamlTgz] = await Promise.all([
      packPeerDependency(path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"), peerTgzDir),
      packPeerDependency(path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-tui"), peerTgzDir),
      packPeerDependency(path.join(REPO_ROOT, "node_modules", "typebox"), peerTgzDir),
      packPeerDependency(path.join(REPO_ROOT, "node_modules", "yaml"), peerTgzDir),
    ]);
    // --offline enforces (not just happens to achieve) the "no network
    // registry access" claim recorded in the evidence doc: with every
    // dependency -- host peers, pi-personas' own `yaml` dependency, and the
    // tarball under test -- supplied as an explicit local tarball, npm has
    // nothing left to resolve from the network and --offline would make the
    // install fail loudly instead of silently reaching out if it did.
    // --ignore-scripts is safe here: none of pi-personas, its `yaml`
    // dependency, or the packed host peers declare a preinstall/install/
    // postinstall/prepare lifecycle script (verified against each package's
    // own package.json), so there is nothing legitimate being skipped.
    execFileSync(
      "npm",
      ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", piCodingAgentTgz, piTuiTgz, typeboxTgz, yamlTgz, tgzPath],
      { cwd: projectDir, stdio: "inherit" },
    );
    await rm(peerTgzDir, { recursive: true, force: true });
  }
  return projectDir;
}

// ---------------------------------------------------------------------------
// Scenario 1: extension loads from the installed package at all.
// ---------------------------------------------------------------------------

function makeContext(projectDir) {
  const piBin = path.join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const extension = path.join(projectDir, "node_modules", "pi-personas", "extensions", "pi-persona.ts");
  assert.ok(existsSync(piBin), `installed pi binary missing at ${piBin}`);
  assert.ok(existsSync(extension), `installed pi-persona extension missing at ${extension}`);
  function startPersonaPi(agentDir, extraArgs = [], opts = {}) {
    return startPi(piBin, ["--mode", "rpc", "--offline", "--extension", extension, "--approve", ...extraArgs], {}, { agentDir, ...opts });
  }
  return { piBin, extension, startPersonaPi };
}

async function getCommandNames(child, rpc) {
  const cursor = rpc.cursor();
  const id = `cmds-${Date.now()}-${Math.random()}`;
  send(child, { id, type: "get_commands" });
  const response = await rpc.waitFor((m) => m.type === "response" && m.command === "get_commands" && m.id === id, "get_commands", 15000, cursor);
  return response.data.commands.map((c) => c.name);
}

async function pollUntilCommand(child, rpc, predicate, label, deadlineMs = 10000) {
  const deadline = Date.now() + deadlineMs;
  let last;
  while (Date.now() < deadline) {
    last = await getCommandNames(child, rpc);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`pollUntilCommand timed out after ${deadlineMs}ms waiting for ${label}; last seen: ${JSON.stringify(last)}`);
}

async function scenarioExtensionLoadsFromInstalledPackage(ctx) {
  const { child, rpc, agentDir } = ctx.startPersonaPi(undefined, ["--no-session"]);
  try {
    const names = await getCommandNames(child, rpc);
    assert.ok(names.includes("persona"), "installed extension registers /persona");
    assert.ok(names.includes("persona-list"), "installed extension registers /persona-list");

    const cursor = rpc.cursor();
    send(child, { id: "list", type: "prompt", message: "/persona-list" });
    const output = await rpc.waitFor((m) => isPersonaMessage(m, "# Pi Personas"), "persona-list output", 15000, cursor);
    assert.match(output.message.content, /# Pi Personas/);
  } finally {
    await stop(child);
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: install -> fork -> edit -> preview -> apply(confirm) -> delete(confirm).
// Mirrors test/persona-team-rpc.test.js's proven "/persona pack lifecycle over
// RPC" sequence, message-for-message.
// ---------------------------------------------------------------------------

async function scenarioInstallForkEditPreviewApplyDelete(ctx) {
  const agentDir = await tempDir("pi-persona-acceptance-lifecycle-");
  const { child, rpc } = ctx.startPersonaPi(agentDir, ["--no-session"]);
  try {
    const installCursor = rpc.cursor();
    send(child, { id: "install", type: "prompt", message: "/persona pack install philosopher-7" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Installed persona pack 'official/philosopher-7'"), "install notice", 15000, installCursor);

    const forkCursor = rpc.cursor();
    send(child, { id: "fork", type: "prompt", message: "/persona pack fork philosopher-7 my-fork" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Forked 'official/philosopher-7' into 'custom/my-fork'"), "fork notice", 15000, forkCursor);

    const editCursor = rpc.cursor();
    send(child, { id: "edit", type: "prompt", message: "/persona pack edit my-fork" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Started editing draft for 'my-fork'"), "edit draft notice", 15000, editCursor);

    const previewCursor = rpc.cursor();
    send(child, { id: "preview", type: "prompt", message: "/persona pack preview my-fork" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Draft for 'my-fork'"), "preview notice", 15000, previewCursor);

    const applyCursor = rpc.cursor();
    send(child, { id: "apply", type: "prompt", message: "/persona pack apply my-fork" });
    await answerConfirm(child, rpc, true, applyCursor);
    await rpc.waitFor((m) => isPersonaMessage(m, "Applied the draft for 'custom/my-fork'"), "apply notice", 15000, applyCursor);

    const deleteCursor = rpc.cursor();
    send(child, { id: "delete", type: "prompt", message: "/persona pack delete my-fork" });
    await answerConfirm(child, rpc, true, deleteCursor);
    await rpc.waitFor((m) => isPersonaMessage(m, "Deleted persona pack 'custom/my-fork'"), "delete notice", 15000, deleteCursor);

    const storeRoot = path.join(agentDir, "persona");
    assert.ok(!existsSync(path.join(storeRoot, "custom", "my-fork")), "delete actually removed the pack from the store");
    assert.ok(existsSync(path.join(storeRoot, "official", "philosopher-7")), "the original official install is untouched by forking/deleting its fork");
  } finally {
    await stop(child);
    rmSync(agentDir, { recursive: true, force: true });
  }
}

async function scenarioDeclinedConfirmLeavesDraftPending(ctx) {
  const agentDir = await tempDir("pi-persona-acceptance-decline-");
  const { child, rpc } = ctx.startPersonaPi(agentDir, ["--no-session"]);
  try {
    const createCursor = rpc.cursor();
    send(child, { id: "create", type: "prompt", message: "/persona pack create council" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Started a new draft for 'council'"), "create draft notice", 15000, createCursor);

    const applyCursor = rpc.cursor();
    send(child, { id: "apply", type: "prompt", message: "/persona pack apply council" });
    await answerConfirm(child, rpc, false, applyCursor);
    await rpc.waitFor((m) => isPersonaMessage(m, "Cancelled."), "cancelled notice", 15000, applyCursor);

    const storeRoot = path.join(agentDir, "persona");
    assert.ok(!existsSync(path.join(storeRoot, "custom", "council")), "declining must not create the custom pack");
    assert.ok(existsSync(path.join(storeRoot, "drafts", "council")), "the draft survives a decline, ready to apply later");
  } finally {
    await stop(child);
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: default + explicit session switch, both directions, plus none.
// Seeds two real installed packs and a global default using the INSTALLED
// package's own global-pack-store.js/pack-session.js (not this checkout's).
// ---------------------------------------------------------------------------

async function installRealTeamPack(pkgRoot, storeRoot, { name, leadName, specialistName }) {
  const { readPortablePersonaPack } = await import(pathToFileURL(path.join(pkgRoot, "src/persona/pack-source.js")).href);
  const { stageCustomPersonaPackDraft, applyCustomPersonaPackDraft } = await import(pathToFileURL(path.join(pkgRoot, "src/persona/global-pack-store.js")).href);
  const sourceDir = await tempDir(`pi-persona-acceptance-pack-src-${name}-`);
  try {
    await writeText(path.join(sourceDir, "pack.yaml"), ["schema: 2", `name: ${name}`, "version: 1.0.0", `description: ${name} test pack.`].join("\n") + "\n");
    await writeText(path.join(sourceDir, "agents", `${leadName}.md`), `---\nname: ${leadName}\nrole: generalist\ndescription: ${leadName} generalist.\n---\n${leadName} prompt body.\n`);
    await writeText(path.join(sourceDir, "agents", `${specialistName}.md`), `---\nname: ${specialistName}\nrole: specialist\ndescription: ${specialistName} specialist.\n---\n${specialistName} prompt body.\n`);
    await writeText(path.join(sourceDir, "references", "_index.md"), `# ${name}\n`);
    const source = await readPortablePersonaPack(sourceDir, { type: "path", ref: sourceDir });
    await stageCustomPersonaPackDraft(storeRoot, name, source);
    await applyCustomPersonaPackDraft(storeRoot, name);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

async function scenarioDefaultAndSessionSwitchBothDirections(ctx, pkgRoot) {
  const { writeGlobalDefaultPack } = await import(pathToFileURL(path.join(pkgRoot, "src/persona/pack-session.js")).href);
  const agentDir = await tempDir("pi-persona-acceptance-switch-");
  const storeRoot = path.join(agentDir, "persona");
  await installRealTeamPack(pkgRoot, storeRoot, { name: "marketing", leadName: "market-lead", specialistName: "market-analyst" });
  await installRealTeamPack(pkgRoot, storeRoot, { name: "philosophy", leadName: "philo-lead", specialistName: "philo-scout" });
  await writeGlobalDefaultPack(storeRoot, "custom/marketing");

  const session1 = ctx.startPersonaPi(agentDir, ["--no-session"]);
  const session2 = ctx.startPersonaPi(agentDir, ["--no-session"]);
  try {
    const names1 = await getCommandNames(session1.child, session1.rpc);
    assert.ok(names1.includes("market-lead"), "fresh session 1 gets the configured default");
    const names2 = await getCommandNames(session2.child, session2.rpc);
    assert.ok(names2.includes("market-lead"), "fresh session 2 also gets the configured default");

    const switchCursor = session1.rpc.cursor();
    send(session1.child, { id: "switch-1", type: "prompt", message: "/persona team custom/philosophy" });
    await session1.rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/philosophy'"), "switch to philosophy", 15000, switchCursor);
    const afterSwitch1 = await pollUntilCommand(session1.child, session1.rpc, (n) => n.includes("philo-lead"), "philo-lead after switch");
    assert.ok(afterSwitch1.includes("philo-lead") && !afterSwitch1.includes("market-lead"));

    const names2Unaffected = await getCommandNames(session2.child, session2.rpc);
    assert.ok(names2Unaffected.includes("market-lead") && !names2Unaffected.includes("philo-lead"), "session 2 is unaffected by session 1's switch");

    const switchBackCursor = session1.rpc.cursor();
    send(session1.child, { id: "switch-2", type: "prompt", message: "/persona team custom/marketing" });
    await session1.rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/marketing'"), "switch back to marketing", 15000, switchBackCursor);
    const afterSwitchBack = await pollUntilCommand(session1.child, session1.rpc, (n) => n.includes("market-lead"), "market-lead after switch back");
    assert.ok(afterSwitchBack.includes("market-lead") && !afterSwitchBack.includes("philo-lead"), "both directions of the switch work");

    const noneCursor = session1.rpc.cursor();
    send(session1.child, { id: "switch-3", type: "prompt", message: "/persona team none" });
    await session1.rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to none"), "switch to none", 15000, noneCursor);
    const afterNone = await pollUntilCommand(session1.child, session1.rpc, (n) => !n.includes("market-lead"), "market-lead gone after none");
    assert.ok(!afterNone.includes("market-lead") && !afterNone.includes("philo-lead") && afterNone.includes("persona"));
  } finally {
    await stop(session1.child);
    await stop(session2.child);
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 3b: chat-first switch from the installed artifact. A local
// zero-cost mock model issues the real persona_pack tool calls: a plan that
// changes nothing, then -- only after the user's "yes" -- the exact retry,
// which hands the switch to /persona and reloads. Success is the host's own
// reloaded command registry, not the tool's or model's claim.
// ---------------------------------------------------------------------------

async function scenarioChatApprovedTeamSwitch(ctx, pkgRoot) {
  const { writeGlobalDefaultPack } = await import(pathToFileURL(path.join(pkgRoot, "src/persona/pack-session.js")).href);
  const agentDir = await tempDir("pi-persona-acceptance-chat-");
  const storeRoot = path.join(agentDir, "persona");
  await installRealTeamPack(pkgRoot, storeRoot, { name: "marketing", leadName: "market-lead", specialistName: "market-analyst" });
  await installRealTeamPack(pkgRoot, storeRoot, { name: "philosophy", leadName: "philo-lead", specialistName: "philo-scout" });
  await writeGlobalDefaultPack(storeRoot, "custom/marketing");
  let offered;
  const model = await startMockModel((turn) => {
    if (turn.toolResults.length > 0) {
      offered = retryFromToolResult(turn.toolResults.at(-1)) ?? offered;
      return { text: turn.toolResults.at(-1).split("\n")[0] };
    }
    if (/^yes/i.test(turn.lastUserText)) return { toolCalls: [{ name: "persona_pack", arguments: offered }] };
    return { toolCalls: [{ name: "persona_pack", arguments: { action: "team", target: "philosophy" } }] };
  });
  model.writeModelsJson(agentDir);
  const session = ctx.startPersonaPi(agentDir, [...model.cliArgs]);
  const chat = async (message) => {
    const cursor = session.rpc.cursor();
    send(session.child, { id: `chat-${Math.random()}`, type: "prompt", message });
    await session.rpc.waitFor((m) => m.type === "agent_settled", `agent_settled after ${message}`, 20000, cursor);
    return cursor;
  };
  try {
    assert.ok((await getCommandNames(session.child, session.rpc)).includes("market-lead"));
    await chat("switch this session to philosophy");
    const planned = await getCommandNames(session.child, session.rpc);
    assert.ok(planned.includes("market-lead") && !planned.includes("philo-lead"), "a plan alone switches nothing");
    assert.ok(offered?.planId, "the plan offered an exact retry");
    const cursor = await chat("yes");
    await session.rpc.waitFor((m) => isPersonaMessage(m, "Persona team switched to 'custom/philosophy'"), "chat-approved switch confirmed by the fresh instance", 20000, cursor);
    const after = await getCommandNames(session.child, session.rpc);
    assert.ok(after.includes("philo-lead") && !after.includes("market-lead"), `commands swapped after reload: ${after}`);
  } finally {
    await stop(session.child);
    await model.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: missing/invalid recovery -- an unknown team target is refused
// with no state change, and uninstalling the pack set as the global default
// clears the default rather than silently reassigning it.
// ---------------------------------------------------------------------------

async function scenarioMissingInvalidRecovery(ctx) {
  const agentDir = await tempDir("pi-persona-acceptance-invalid-");
  const { child, rpc } = ctx.startPersonaPi(agentDir, ["--no-session"]);
  try {
    const installCursor = rpc.cursor();
    send(child, { id: "install", type: "prompt", message: "/persona pack install philosopher-7" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Installed persona pack 'official/philosopher-7'"), "install notice", 15000, installCursor);

    const badSwitchCursor = rpc.cursor();
    send(child, { id: "bad-switch", type: "prompt", message: "/persona team custom/does-not-exist" });
    const err = await rpc.waitFor((m) => isPersonaMessage(m, "is not installed"), "not-installed error", 15000, badSwitchCursor);
    assert.match(err.message.content, /custom\/does-not-exist/);

    const defaultCursor = rpc.cursor();
    send(child, { id: "default", type: "prompt", message: "/persona team default philosopher-7" });
    await rpc.waitFor((m) => isPersonaMessage(m, "philosopher-7"), "set default notice", 15000, defaultCursor);

    const uninstallCursor = rpc.cursor();
    send(child, { id: "uninstall", type: "prompt", message: "/persona pack uninstall philosopher-7" });
    await answerConfirm(child, rpc, true, uninstallCursor);
    await rpc.waitFor((m) => isPersonaMessage(m, "Uninstalled persona pack 'official/philosopher-7'"), "uninstall notice", 15000, uninstallCursor);

    const statusCursor = rpc.cursor();
    send(child, { id: "status", type: "prompt", message: "/persona pack status" });
    const status = await rpc.waitFor((m) => isPersonaMessage(m, ""), "status report", 15000, statusCursor);
    assert.doesNotMatch(status.message.content, /Default: .*philosopher-7/, "uninstalling the default pack must clear the default, not leave a dangling reference");
  } finally {
    await stop(child);
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 5: a session bound to a custom pack keeps its retained snapshot
// after a *different* session edits/applies changes to that same pack.
// ---------------------------------------------------------------------------

async function scenarioEditActiveSnapshotRetained(ctx) {
  const agentDir = await tempDir("pi-persona-acceptance-retained-");
  const storeRoot = path.join(agentDir, "persona");
  const boundSession = ctx.startPersonaPi(agentDir, ["--no-session"]);
  try {
    const installCursor = boundSession.rpc.cursor();
    send(boundSession.child, { id: "install", type: "prompt", message: "/persona pack install philosopher-7" });
    await boundSession.rpc.waitFor((m) => isPersonaMessage(m, "Installed persona pack 'official/philosopher-7'"), "install notice", 15000, installCursor);

    const forkCursor = boundSession.rpc.cursor();
    send(boundSession.child, { id: "fork", type: "prompt", message: "/persona pack fork philosopher-7 my-fork" });
    await boundSession.rpc.waitFor((m) => isPersonaMessage(m, "Forked 'official/philosopher-7' into 'custom/my-fork'"), "fork notice", 15000, forkCursor);

    const bindCursor = boundSession.rpc.cursor();
    send(boundSession.child, { id: "bind", type: "prompt", message: "/persona team custom/my-fork" });
    await boundSession.rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/my-fork'"), "bind notice", 15000, bindCursor);
    const boundNames = await pollUntilCommand(boundSession.child, boundSession.rpc, (n) => n.includes("symposium"), "symposium present after bind");
    assert.ok(!boundNames.includes("new-specialist"), "sanity: new-specialist does not exist yet");

    // A second, independent session against the same store starts an edit
    // draft, writes a real new agent file directly into it (this is the
    // actual, documented /persona pack edit workflow -- there is no CLI flag
    // for adding an agent inline), then applies with the real command and
    // confirm dialog. Every step below must succeed; nothing is swallowed.
    const editorSession = ctx.startPersonaPi(agentDir, ["--no-session"]);
    try {
      const editCursor = editorSession.rpc.cursor();
      send(editorSession.child, { id: "edit", type: "prompt", message: "/persona pack edit my-fork" });
      await editorSession.rpc.waitFor((m) => isPersonaMessage(m, "Started editing draft for 'my-fork'"), "edit draft notice", 15000, editCursor);

      const draftAgentPath = path.join(storeRoot, "drafts", "my-fork", "agents", "new-specialist.md");
      assert.ok(existsSync(draftAgentPath) === false, "sanity: the draft does not already have new-specialist.md");
      await writeText(
        draftAgentPath,
        "---\nname: new-specialist\nrole: specialist\ndescription: New specialist added mid-flight to verify retained snapshots.\n---\nYou are the new specialist added to verify retained-snapshot behavior.\n",
      );

      const applyCursor = editorSession.rpc.cursor();
      send(editorSession.child, { id: "apply", type: "prompt", message: "/persona pack apply my-fork" });
      await answerConfirm(editorSession.child, editorSession.rpc, true, applyCursor);
      await editorSession.rpc.waitFor((m) => isPersonaMessage(m, "Applied the draft for 'custom/my-fork'"), "apply notice", 15000, applyCursor);
    } finally {
      await stop(editorSession.child);
    }

    assert.ok(
      existsSync(path.join(storeRoot, "custom", "my-fork", "agents", "new-specialist.md")),
      "the applied draft actually mutated the installed store with the new agent file",
    );

    // The already-bound session must keep serving its retained snapshot: a
    // read-only listing must not error and must not silently reflect a
    // mutation that happened after this session's own bind/reload.
    const listCursor = boundSession.rpc.cursor();
    send(boundSession.child, { id: "list-after-mutation", type: "prompt", message: "/persona-list" });
    const listing = await boundSession.rpc.waitFor((m) => isPersonaMessage(m, "# Pi Personas"), "persona-list after external mutation", 15000, listCursor);
    assert.match(listing.message.content, /symposium/, "the bound session's retained snapshot still resolves normally after an external mutation to the same pack");
    assert.doesNotMatch(
      listing.message.content,
      /new-specialist/,
      "the already-bound session must NOT see the new agent added by the other session's mutation -- it must keep serving its retained snapshot from bind time",
    );

    // A fresh session that binds *after* the mutation must see the new
    // content, proving the previous assertion is a real retained-snapshot
    // effect and not e.g. a broken /persona-list that never reflects reality.
    const freshSession = ctx.startPersonaPi(agentDir, ["--no-session"]);
    try {
      const freshBindCursor = freshSession.rpc.cursor();
      send(freshSession.child, { id: "fresh-bind", type: "prompt", message: "/persona team custom/my-fork" });
      await freshSession.rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/my-fork'"), "fresh bind notice", 15000, freshBindCursor);
      const freshNames = await pollUntilCommand(freshSession.child, freshSession.rpc, (n) => n.includes("new-specialist"), "new-specialist present in a fresh post-mutation session");
      assert.ok(freshNames.includes("new-specialist"), "a fresh session binding after the mutation sees the new agent");
    } finally {
      await stop(freshSession.child);
    }
  } finally {
    await stop(boundSession.child);
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 6: migration inspect/preview/apply/rollback -- originals
// byte-for-byte unchanged, rollback restores only session binding + marker.
// ---------------------------------------------------------------------------

function writeLegacyProject(workspace, { leadName = "coordinator", specialistName = "writer" } = {}) {
  return Promise.all([
    writeText(path.join(workspace, ".pi/agents", `${leadName}.md`), `---\nname: ${leadName}\nrole: generalist\ndescription: Legacy project coordinator.\n---\nLegacy coordinator prompt.\n`),
    writeText(path.join(workspace, ".pi/agents", `${specialistName}.md`), `---\nname: ${specialistName}\nrole: specialist\ndescription: Legacy project specialist.\n---\nLegacy specialist prompt.\n`),
  ]);
}

async function scenarioMigrationOriginalPreservationAndRollback(ctx) {
  const agentDir = await tempDir("pi-persona-acceptance-migrate-");
  const workspace = await tempDir("pi-persona-acceptance-migrate-ws-");
  await writeLegacyProject(workspace, { leadName: "coordinator", specialistName: "writer" });
  const coordinatorPath = path.join(workspace, ".pi/agents/coordinator.md");
  const writerPath = path.join(workspace, ".pi/agents/writer.md");
  const originalCoordinator = await readFile(coordinatorPath, "utf8");
  const originalWriter = await readFile(writerPath, "utf8");

  const { child, rpc } = ctx.startPersonaPi(agentDir, ["--no-session"], { cwd: workspace });
  try {
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

    assert.equal(await readFile(coordinatorPath, "utf8"), originalCoordinator, "original coordinator.md is byte-for-byte unchanged after apply");
    assert.equal(await readFile(writerPath, "utf8"), originalWriter, "original writer.md is byte-for-byte unchanged after apply");
    assert.ok(existsSync(path.join(agentDir, "persona", "custom", "legacy-team")), "destination pack created in the global store");

    const rollbackCursor = rpc.cursor();
    send(child, { id: "rollback", type: "prompt", message: "/persona migrate rollback legacy-team" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Persona team rolled back: this workspace's persona setup requires migration again"), "rollback notice", 15000, rollbackCursor);

    const statusCursor = rpc.cursor();
    send(child, { id: "status-after-rollback", type: "prompt", message: "/persona migrate status" });
    await rpc.waitFor((m) => isPersonaMessage(m, "Migration state: migration-required"), "status after rollback", 15000, statusCursor);

    assert.ok(existsSync(path.join(agentDir, "persona", "custom", "legacy-team")), "rollback never deletes the migrated destination pack");
    assert.equal(await readFile(coordinatorPath, "utf8"), originalCoordinator, "original files remain unchanged after rollback too");
    assert.equal(await readFile(writerPath, "utf8"), originalWriter, "original files remain unchanged after rollback too");
  } finally {
    await stop(child);
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario 7: host Pi SDK import from the installed artifact, no reliance on
// checkout-relative paths -- a real native child, driven through Pi's actual
// SDK tool loop, against a local zero-cost mock model (no paid provider).
// Adapted from test/persona-pack-session.test.js's proven pattern, but every
// import below resolves from the disposable project's own node_modules.
//
// This calls src/persona/child-runner.js's runPersonaChild() directly, the
// same way test/persona-pack-session.test.js's unit test does -- it does NOT
// go through the installed extension's RPC command/tool dispatch (there is
// no real top-level model driving a `/persona use` + `persona_consult` tool
// call here). It proves the installed artifact's native child correctly
// resolves and runs the host Pi SDK from its own node_modules; it does NOT
// prove the extension's persona_consult-to-runPersonaChild wiring, which is
// untested by both this script and the existing unit suite.
// ---------------------------------------------------------------------------

async function scenarioHostSdkImportFromInstalledArtifact(pkgRoot, projectDir) {
  const { getPackageDir } = await import(pathToFileURL(path.join(projectDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
  const { runPersonaChild } = await import(pathToFileURL(path.join(pkgRoot, "src/persona/child-runner.js")).href);

  const { realpathSync } = await import("node:fs");
  const hostPackageDir = getPackageDir();
  const expectedPrefix = realpathSync(path.join(projectDir, "node_modules"));
  assert.ok(
    realpathSync(hostPackageDir).startsWith(expectedPrefix),
    `expected the host SDK package dir to resolve inside the disposable project's node_modules (${expectedPrefix}), got ${realpathSync(hostPackageDir)}`,
  );

  const workspaceRoot = await tempDir("pi-persona-acceptance-sdk-ws-");
  await writeText(path.join(workspaceRoot, "note.md"), "Installed-artifact workspace note.\n");

  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      received.push(parsed);
      const toolMessages = (parsed.messages ?? []).filter((m) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const id = "chatcmpl-mock-acceptance";
      const created = Math.floor(Date.now() / 1000);
      const sendFrame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const frame = (delta, finish_reason = null) =>
        sendFrame({ id, object: "chat.completion.chunk", created, model: "mock-model", choices: [{ index: 0, delta, finish_reason }] });
      if (toolMessages.length === 0) {
        frame({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: "" } }] });
        frame({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "note.md" }) } }] });
        frame({}, "tool_calls");
      } else {
        const toolText = (message) => (Array.isArray(message.content) ? message.content.map((p) => p.text ?? "").join("") : String(message.content ?? ""));
        frame({ role: "assistant", content: JSON.stringify({ note: toolText(toolMessages[0]) }) });
        frame({}, "stop");
      }
      sendFrame({ id, object: "chat.completion.chunk", created, model: "mock-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const agentDir = await tempDir("pi-persona-acceptance-sdk-agentdir-");
  await writeText(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "mock-provider": {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "mock-key",
          models: [
            { id: "mock-model", name: "Mock Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
          ],
        },
      },
    }),
  );

  try {
    const result = await runPersonaChild(
      {
        cwd: workspaceRoot,
        agentDir,
        sdkEntry: pathToFileURL(path.join(hostPackageDir, "dist/index.js")).href,
        authStorageEntry: pathToFileURL(path.join(hostPackageDir, "dist/core/auth-storage.js")).href,
        projectTrusted: true,
        personaName: "acceptance-check",
        systemPrompt: "You are a leaf task. Read note.md and report its contents verbatim as JSON {\"note\": ...}.",
        task: "Read note.md and report its contents.",
        model: { provider: "mock-provider", id: "mock-model" },
        thinkingLevel: "off",
        auth: { apiKey: "mock-key", baseUrl: `http://127.0.0.1:${port}/v1`, headers: {} },
        skillNames: [],
        skillPaths: [],
        tools: ["read"],
        context: "fresh",
        branch: [],
      },
      { idleTimeoutMs: 15000, startTimeoutMs: 15000 },
    );
    assert.equal(result.status, "completed", JSON.stringify(result));
    const answer = JSON.parse(result.text);
    assert.equal(answer.note, "Installed-artifact workspace note.\n");
    assert.equal(received.length, 2, "expected 2 model turns: tool call + final answer");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Task 8 packed acceptance ===");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
  console.log(`Repo commit: ${commit}`);
  console.log(`Node: ${process.version}`);

  const tgzPath = await buildTarball();
  const digest = await sha256(tgzPath);
  console.log(`Tarball: ${tgzPath}`);
  console.log(`SHA-256: ${digest}`);

  const projectDir = await setupDisposableProject(tgzPath);
  console.log(`Disposable project: ${projectDir}`);
  const pkgRoot = path.join(projectDir, "node_modules", "pi-personas");
  const ctx = makeContext(projectDir);

  await scenario("extension loads from installed package; /persona-list works", () => scenarioExtensionLoadsFromInstalledPackage(ctx));
  await scenario("pack lifecycle: install -> fork -> edit -> preview -> apply(confirm) -> delete(confirm)", () => scenarioInstallForkEditPreviewApplyDelete(ctx));
  await scenario("declining the apply confirm leaves the draft pending, store unmutated", () => scenarioDeclinedConfirmLeavesDraftPending(ctx));
  await scenario("default + explicit session switch, both directions, then none", () => scenarioDefaultAndSessionSwitchBothDirections(ctx, pkgRoot));
  await scenario("chat-first: model-issued persona_pack team plan, explicit approval, reload swaps commands", () => scenarioChatApprovedTeamSwitch(ctx, pkgRoot));
  await scenario("missing/invalid team target refused; uninstalling the default pack clears the default", () => scenarioMissingInvalidRecovery(ctx));
  await scenario("a bound session keeps its retained snapshot after another session edits the same pack", () => scenarioEditActiveSnapshotRetained(ctx));
  await scenario("migration: inspect/preview/apply/rollback, originals byte-for-byte unchanged throughout", () => scenarioMigrationOriginalPreservationAndRollback(ctx));
  await scenario("host Pi SDK import from the installed artifact via a DIRECT runPersonaChild() call + local mock model (extension persona_consult wiring NOT exercised)", () => scenarioHostSdkImportFromInstalledArtifact(pkgRoot, projectDir));

  console.log("\n=== Summary ===");
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} scenarios passed.`);
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);

  console.log("\n=== Explicitly NOT checked by this script ===");
  for (const item of notChecked) console.log(`  - ${item}`);

  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
