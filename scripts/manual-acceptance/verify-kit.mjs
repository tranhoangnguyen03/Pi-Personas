#!/usr/bin/env node
// Smoke-verifies a kit built by build-kit.mjs, over the real RPC mode of the
// same installed pi + extension the interactive launcher uses (bin/launch.sh
// uses TUI mode; this script proves command wiring only -- see
// docs/manual-acceptance-kit.md for what still needs an actual PTY/human
// pass). Reuses the proven rpc-harness.mjs from
// scripts/task8-packed-acceptance (same isolation flags, same helper shape).
//
// Usage: node scripts/manual-acceptance/verify-kit.mjs [kitDir]
import assert from "node:assert/strict";
import path from "node:path";

import { startPi, send, stop } from "../task8-packed-acceptance/rpc-harness.mjs";

const KIT_ROOT = path.resolve(process.argv[2] ?? "/tmp/pi-persona-manual-acceptance-kit");
const piBin = path.join(KIT_ROOT, "project/node_modules/.bin/pi");
const extension = path.join(KIT_ROOT, "project/node_modules/pi-personas/extensions/pi-persona.ts");
const agentDir = path.join(KIT_ROOT, "agent-dir");
const workspace = path.join(KIT_ROOT, "workspace");

function isPersonaMessage(m, substring) {
  return m.type === "message_end" && m.message?.customType === "pi-persona" && String(m.message.content).includes(substring);
}

async function getCommandNames(child, rpc) {
  const cursor = rpc.cursor();
  const id = `cmds-${Date.now()}-${Math.random()}`;
  send(child, { id, type: "get_commands" });
  const response = await rpc.waitFor((m) => m.type === "response" && m.command === "get_commands" && m.id === id, "get_commands", 15000, cursor);
  return response.data.commands.map((c) => c.name);
}

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.stack ?? String(err) });
    console.log(`FAIL  ${name}`);
    console.log(err.stack ?? err);
  }
}

function startKitPi(extraArgs = []) {
  // Same isolation flags the kit's own bin/launch.sh uses, plus --mode rpc
  // (launch.sh runs the real interactive TUI instead) and --offline (this
  // verification must not touch the network; the interactive launcher does
  // not force --offline so a later authorized model pass can work).
  return startPi(piBin, ["--mode", "rpc", "--offline", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "--no-session", ...extraArgs], {}, { agentDir, cwd: workspace });
}

async function main() {
  console.log(`Kit: ${KIT_ROOT}`);

  await scenario("fresh session: default is none, both fixture teams + philosopher-7 catalog visible", async () => {
    const { child, rpc } = startKitPi();
    try {
      const names = await getCommandNames(child, rpc);
      assert.ok(names.includes("persona"), "/persona present");
      assert.ok(!names.includes("market-lead"), "no default bound: market-lead not present at fresh launch");
      assert.ok(!names.includes("philo-lead"), "no default bound: philo-lead not present at fresh launch");

      const cursor = rpc.cursor();
      send(child, { id: "list", type: "prompt", message: "/persona pack list" });
      const listing = await rpc.waitFor((m) => isPersonaMessage(m, "marketing") && isPersonaMessage(m, "marketing"), "pack list", 15000, cursor);
      assert.match(listing.message.content, /marketing/);
      assert.match(listing.message.content, /philosophy/);
      assert.match(listing.message.content, /philosopher-7/);
    } finally {
      await stop(child);
    }
  });

  await scenario("deliberate /persona team switch to custom/marketing exposes market-lead only", async () => {
    const { child, rpc } = startKitPi();
    try {
      await getCommandNames(child, rpc);
      const cursor = rpc.cursor();
      send(child, { id: "switch", type: "prompt", message: "/persona team custom/marketing" });
      await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/marketing'"), "switch notice", 15000, cursor);
      const deadline = Date.now() + 10000;
      let names = [];
      while (Date.now() < deadline) {
        names = await getCommandNames(child, rpc);
        if (names.includes("market-lead")) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.ok(names.includes("market-lead"), "market-lead present after switch");
      assert.ok(names.includes("market-analyst"), "market-analyst present after switch");
      assert.ok(!names.includes("philo-lead"), "philosophy team not exposed");
    } finally {
      await stop(child);
    }
  });

  await scenario("deliberate /persona team switch to custom/philosophy exposes philo-lead only", async () => {
    const { child, rpc } = startKitPi();
    try {
      await getCommandNames(child, rpc);
      const cursor = rpc.cursor();
      send(child, { id: "switch", type: "prompt", message: "/persona team custom/philosophy" });
      await rpc.waitFor((m) => isPersonaMessage(m, "Switching persona team to 'custom/philosophy'"), "switch notice", 15000, cursor);
      const deadline = Date.now() + 10000;
      let names = [];
      while (Date.now() < deadline) {
        names = await getCommandNames(child, rpc);
        if (names.includes("philo-lead")) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.ok(names.includes("philo-lead"), "philo-lead present after switch");
      assert.ok(!names.includes("market-lead"), "marketing team not exposed");
    } finally {
      await stop(child);
    }
  });

  // Deliberately NOT run against the kit's own shared agent-dir: installing
  // philosopher-7 here would pre-install it for the user, defeating the
  // point of leaving it "available but not installed" for their own
  // deliberate-selection walkthrough. Uses a throwaway agent dir instead,
  // auto-cleaned by rpc-harness on exit.
  await scenario("official catalog: /persona pack install philosopher-7 works from the installed package's bundled catalog", async () => {
    const { child, rpc } = startPi(piBin, ["--mode", "rpc", "--offline", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "--no-session"]);
    try {
      const cursor = rpc.cursor();
      send(child, { id: "install", type: "prompt", message: "/persona pack install philosopher-7" });
      await rpc.waitFor((m) => isPersonaMessage(m, "Installed persona pack 'official/philosopher-7'"), "install notice", 15000, cursor);
    } finally {
      await stop(child);
    }
  });

  await scenario("legacy workspace: /persona migrate inspect recognizes the synthetic legacy project", async () => {
    const { child, rpc } = startPi(piBin, ["--mode", "rpc", "--offline", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "--no-session"], {}, { agentDir, cwd: path.join(KIT_ROOT, "legacy-workspace") });
    try {
      const cursor = rpc.cursor();
      send(child, { id: "inspect", type: "prompt", message: "/persona migrate inspect" });
      await rpc.waitFor((m) => isPersonaMessage(m, "Supported: yes"), "migrate inspect", 15000, cursor);
    } finally {
      await stop(child);
    }
  });

  console.log("\n=== Summary ===");
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} scenarios passed.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
