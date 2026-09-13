import { fork } from "node:child_process";

const START_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 2_000;
const MAX_STDERR = 64 * 1024;
const activeStops = new Set();

export function cancelPersonaChildren(reason = "Pi Persona session shut down.") {
  for (const stop of [...activeStops]) stop(reason);
}

export function runPersonaChild(request, options = {}) {
  if (options.signal?.aborted) {
    return Promise.reject(new Error("Native Pi Persona child was cancelled."));
  }
  const child = fork(new URL("./child-entry.js", import.meta.url), [], {
    cwd: request.cwd,
    env: process.env,
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    let stderr = "";
    let idleTimer;
    let termTimer;
    let killTimer;
    let pendingResult;

    const clearTimers = () => {
      clearTimeout(startTimer);
      clearTimeout(idleTimer);
      clearTimeout(termTimer);
      clearTimeout(killTimer);
    };
    const finish = (next) => {
      if (settled) return;
      settled = true;
      activeStops.delete(stop);
      clearTimers();
      options.signal?.removeEventListener("abort", cancel);
      next();
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      if (options.idleTimeoutMs === false) return;
      idleTimer = setTimeout(() => stop("Native Pi Persona child timed out waiting for activity."), options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };
    const stop = (reason) => {
      if (settled) return;
      settled = true;
      activeStops.delete(stop);
      clearTimeout(startTimer);
      clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", cancel);
      if (child.connected) child.send({ type: "cancel", reason });
      termTimer = setTimeout(() => child.kill("SIGTERM"), KILL_GRACE_MS);
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS * 2);
      reject(new Error(reason));
    };
    const cancel = () => stop("Native Pi Persona child was cancelled.");
    const startTimer = setTimeout(() => stop("Native Pi Persona child did not start."), options.startTimeoutMs ?? START_TIMEOUT_MS);
    startTimer.unref?.();

    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR);
    });
    activeStops.add(stop);
    child.on("error", (error) => stop(`Native Pi Persona child failed: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (settled) {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        return;
      }
      if (pendingResult) {
        finish(() => {
          if (pendingResult.status === "completed") resolve(pendingResult);
          else reject(new Error(pendingResult.error || `Native Pi Persona child ${pendingResult.status ?? "failed"}.`));
        });
        return;
      }
      const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
      finish(() => reject(new Error(`Native Pi Persona child exited before returning a result (${signal ?? code ?? "unknown"}).${detail}`)));
    });
    child.on("message", (message) => {
      if (settled || pendingResult || !message || typeof message !== "object") return;
      if (message.type === "started") {
        started = true;
        clearTimeout(startTimer);
        resetIdle();
        options.onUpdate?.({
          progress: [{ index: options.index, agent: request.personaName, status: "running" }],
        });
      } else if (message.type === "progress") {
        if (started) resetIdle();
        options.onUpdate?.({
          progress: [{ index: options.index, agent: request.personaName, status: "running", ...message.progress }],
        });
      } else if (message.type === "result") {
        pendingResult = message.result ?? { status: "failed", error: "Native Pi Persona child returned an invalid result." };
        clearTimeout(startTimer);
        clearTimeout(idleTimer);
        options.signal?.removeEventListener("abort", cancel);
        termTimer = setTimeout(() => child.kill("SIGTERM"), KILL_GRACE_MS);
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS * 2);
      }
    });

    options.signal?.addEventListener("abort", cancel, { once: true });
    child.send({ type: "run", request }, (error) => {
      if (error) stop(`Native Pi Persona child failed to start: ${error.message}`);
    });
  });
}
