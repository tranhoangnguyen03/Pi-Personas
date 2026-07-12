import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("real Pi RPC loads the extension and executes persona-list", { timeout: 30_000 }, async () => {
  const root = process.cwd();
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-persona-rpc-"));
  const piBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const extension = path.join(root, "extensions", "pi-persona.ts");
  const child = spawn(piBin, [
    "--mode", "rpc",
    "--offline",
    "--no-session",
    "--no-extensions",
    "--extension", extension,
    "--approve",
  ], {
    cwd: workspace,
    env: { ...process.env, PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = collectJsonLines(child);

  try {
    child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
    const commands = await rpc.waitFor(
      (message) => message.id === "commands" && message.type === "response",
      "get_commands response",
    );
    assert.equal(commands.success, true);
    assert.ok(commands.data.commands.some((command) => command.name === "persona"));
    assert.ok(commands.data.commands.some((command) => command.name === "persona-list"));

    child.stdin.write(`${JSON.stringify({ id: "init", type: "prompt", message: "/persona init" })}\n`);
    const initialized = await rpc.waitFor(
      (message) => message.type === "message_end"
        && message.message?.customType === "pi-persona"
        && /Initialized Pi Persona project/.test(message.message.content),
      "persona init output",
    );
    assert.match(initialized.message.content, /Primary generalist: \/generalist/);

    child.stdin.write(`${JSON.stringify({ id: "list", type: "prompt", message: "/persona-list" })}\n`);
    const output = await rpc.waitFor(
      (message) => message.type === "message_end"
        && message.message?.customType === "pi-persona"
        && /# Pi Personas/.test(message.message.content),
      "persona-list output",
    );
    assert.match(output.message.content, /# Pi Personas/);
    assert.match(output.message.content, /generalist - generalist \(primary\)/);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await rm(workspace, { recursive: true, force: true });
  }
});

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
      const message = JSON.parse(line);
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiter.resolve(message);
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  });

  return {
    waitFor(predicate, label) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${label}.${stderr ? ` stderr: ${stderr}` : ""}`));
        }, 15_000);
        timer.unref?.();
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
  };
}
