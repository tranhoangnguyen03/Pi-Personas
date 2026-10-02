// Minimal RPC harness for scripts/task8-packed-acceptance/run-acceptance.mjs.
// Adapted from test/.fixtures/persona-team-rpc/rpc-harness.mjs, parameterized
// by an explicit `piBin` so it can drive an *installed* `pi` binary (from a
// disposable project's own node_modules) instead of this checkout's.
//
// Isolation: every startPi() call gets its own throwaway PI_CODING_AGENT_DIR
// (mkdtempSync, removed on child exit) plus --no-skills --no-prompt-templates
// --no-themes --no-context-files, so nothing resolves against this machine's
// real ~/.pi/agent. Pass agentDir explicitly to share one store across calls
// (e.g. two "sessions" against the same global pack store).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function startPi(piBin, args, envExtra = {}, { seedAgentDir, cwd, agentDir: sharedAgentDir } = {}) {
  const ownAgentDir = sharedAgentDir ? undefined : mkdtempSync(path.join(tmpdir(), "pi-persona-acceptance-agentdir-"));
  const agentDir = sharedAgentDir ?? ownAgentDir;
  const ownedCwd = cwd ? undefined : mkdtempSync(path.join(tmpdir(), "pi-persona-acceptance-cwd-"));
  seedAgentDir?.(agentDir);
  const isolationFlags = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
  const child = spawn(piBin, [...isolationFlags, ...args], {
    cwd: cwd ?? ownedCwd,
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, ...envExtra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = collectJsonLines(child);
  child.once("exit", () => {
    if (ownAgentDir) {
      try {
        rmSync(ownAgentDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
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
