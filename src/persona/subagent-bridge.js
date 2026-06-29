import { randomUUID } from "node:crypto";

export const SUBAGENT_SLASH_EVENTS = {
  request: "subagent:slash:request",
  started: "subagent:slash:started",
  response: "subagent:slash:response",
  update: "subagent:slash:update",
  cancel: "subagent:slash:cancel",
};

export function runSubagentBridgeRequest(pi, ctx, params, options = {}) {
  const requestId = options.requestId ?? randomUUID();
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) ? options.startTimeoutMs : 15_000;
  return new Promise((resolve, reject) => {
    let done = false;
    const startTimeout = setTimeout(() => {
      finish(() => reject(new Error(
        "pi-subagents slash bridge did not respond. Ensure pi-subagents is installed and loaded in this Pi session.",
      )));
    }, startTimeoutMs);

    const unsubscribeStarted = pi.events.on(SUBAGENT_SLASH_EVENTS.started, (data) => {
      if (done || !matchesRequest(data, requestId)) return;
      clearTimeout(startTimeout);
    });
    const unsubscribeResponse = pi.events.on(SUBAGENT_SLASH_EVENTS.response, (data) => {
      if (done || !matchesRequest(data, requestId)) return;
      finish(() => resolve(data));
    });
    const unsubscribeUpdate = pi.events.on(SUBAGENT_SLASH_EVENTS.update, (data) => {
      if (done || !matchesRequest(data, requestId)) return;
      options.onUpdate?.(data);
    });

    const finish = (next) => {
      if (done) return;
      done = true;
      clearTimeout(startTimeout);
      unsubscribeStarted?.();
      unsubscribeResponse?.();
      unsubscribeUpdate?.();
      next();
    };

    pi.events.emit(SUBAGENT_SLASH_EVENTS.request, { requestId, params, ctx });
  });
}

function matchesRequest(data, requestId) {
  return Boolean(data && typeof data === "object" && data.requestId === requestId);
}
