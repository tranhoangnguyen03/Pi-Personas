// Shared RPC harness for test/persona-team-rpc.test.js.
// Adapted from test/pi-rpc-smoke.test.js collectJsonLines() and the
// feasibility-pass probe harness (docs/plans/persona-pack-probes/rpc-harness.mjs,
// gitignored/not committed). Same JSONL framing and isolation rules.
//
// Isolation: every startPi() call gets its own throwaway PI_CODING_AGENT_DIR
// (mkdtempSync, removed on child exit) plus explicit --no-skills
// --no-prompt-templates --no-themes --no-context-files flags, so nothing
// resolves against this machine's real ~/.pi/agent (trust.json, settings.json,
// models.json, extensions/, skills/, prompts/, themes/, sessions/). Without
// this, a spawned `pi` process leaks this machine's real prompt-template
// commands into get_commands output (see test/persona-team-rpc.test.js).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");

// seedAgentDir(agentDir), if given, runs after the throwaway agent dir is
// created but before the child spawns, so a test can plant known files (e.g.
// a prompt-template canary) that a broken isolation flag would leak.
//
// cwd, if given, is the spawned process's actual working directory --
// there is no `pi --cwd` flag; ctx.cwd is simply the process's cwd. Defaults
// to a fresh throwaway temp directory, not REPO_ROOT: discoverPersonaProject
// reads ctx.cwd's own `.pi/agents`, and legacy-project detection reads
// ctx.cwd for a pre-pack-redesign generalist, so a test that forgets to pass
// an explicit cwd must never silently run against this actual repository
// checkout (whose contents are this developer's working state, not a fixed
// test fixture) -- that would be exactly the "old-tool interference" this
// isolation exists to prevent. Removed on child exit, like agentDir.
export function startPi(args, envExtra = {}, { seedAgentDir, cwd } = {}) {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-persona-rpc-test-agentdir-"));
  const ownedCwd = cwd ? undefined : mkdtempSync(path.join(tmpdir(), "pi-persona-rpc-test-cwd-"));
  seedAgentDir?.(agentDir);
  const isolationFlags = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
  const child = spawn(PI_BIN, [...isolationFlags, ...args], {
    cwd: cwd ?? ownedCwd,
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, ...envExtra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = collectJsonLines(child);
  child.once("exit", () => {
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
    if (!ownedCwd) return;
    try {
      rmSync(ownedCwd, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  });
  return { child, rpc, agentDir };
}

export function send(child, obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}

// Answers the next pending extension_ui_request confirm dialog (rpc-mode.js's
// createExtensionUIContext().confirm -- ctx.ui.confirm from inside an
// extension) with a scripted yes/no, so a test can drive a real
// confirm-required command flow (e.g. /persona pack apply/uninstall/delete)
// without a live terminal. Matches on `sinceIndex` like rpc.waitFor, so a
// caller that already knows roughly when its own confirm request was emitted
// can avoid picking up a stale one from earlier in the same run.
export async function answerConfirm(child, rpc, confirmed, sinceIndex = 0) {
  const request = await rpc.waitFor(
    (m) => m.type === "extension_ui_request" && m.method === "confirm",
    "confirm dialog request",
    15000,
    sinceIndex,
  );
  send(child, { type: "extension_ui_response", id: request.id, confirmed });
  return request;
}

// Deterministic stop: no-ops on an already-exited child, otherwise sends
// SIGTERM and awaits the real 'exit' event (never an arbitrary fire-and-forget
// sleep); a child that ignores SIGTERM for 2s is escalated to SIGKILL and
// awaited again. A spawn/kill-level 'error' rejects the wait instead of being
// silently swallowed by a timer race.
export async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const TIMEOUT = Symbol("timeout");
  child.kill("SIGTERM");
  const outcome = await Promise.race([exited.then(() => "exited"), new Promise((r) => setTimeout(() => r(TIMEOUT), 2000))]);
  if (outcome === TIMEOUT) {
    child.kill("SIGKILL");
    await exited;
  }
}

function collectJsonLines(child) {
  const messages = [];
  const waiters = [];
  let stdout = "";
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const newline = stdout.indexOf("\n");
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiter.resolve(message);
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  });

  return {
    getStderr: () => stderr,
    getMessages: () => messages,
    cursor: () => messages.length,
    // Only matches messages appended from `sinceIndex` onward (default: all
    // history), so a predicate like "notify starting with X" can't re-match a
    // stale, already-consumed message from earlier in the same run.
    waitFor(predicate, label, timeoutMs = 15000, sinceIndex = 0) {
      const existing = messages.slice(sinceIndex).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${label}.${stderr ? ` stderr: ${stderr}` : ""}`));
        }, timeoutMs);
        timer.unref?.();
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
  };
}
