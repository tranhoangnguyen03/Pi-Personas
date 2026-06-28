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
  return new Promise((resolve, reject) => {
    let done = false;
    let started = false;

    const unsubscribeStarted = pi.events.on(SUBAGENT_SLASH_EVENTS.started, (data) => {
      if (done || !matchesRequest(data, requestId)) return;
      started = true;
    });
    const unsubscribeResponse = pi.events.on(SUBAGENT_SLASH_EVENTS.response, (data) => {
      if (done || !matchesRequest(data, requestId)) return;
      finish(() => resolve(data));
    });

    const finish = (next) => {
      if (done) return;
      done = true;
      unsubscribeStarted?.();
      unsubscribeResponse?.();
      next();
    };

    pi.events.emit(SUBAGENT_SLASH_EVENTS.request, { requestId, params, ctx });

    if (!started && !done) {
      finish(() => reject(new Error(
        "pi-subagents slash bridge did not respond. Ensure pi-subagents is installed and loaded in this Pi session.",
      )));
    }
  });
}

function matchesRequest(data, requestId) {
  return Boolean(data && typeof data === "object" && data.requestId === requestId);
}
