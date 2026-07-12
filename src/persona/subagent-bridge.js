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
  const idleTimeoutMs = options.idleTimeoutMs === false
    ? undefined
    : Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : 180_000;
  const maxRuntimeMs = Number.isFinite(options.maxRuntimeMs) ? options.maxRuntimeMs : undefined;
  return new Promise((resolve, reject) => {
    let done = false;
    let idleTimeout;

    const fail = (message, cancel = false) => {
      finish(() => reject(new Error(message)), { cancel, reason: message });
    };

    const startTimeout = setTimeout(() => {
      fail("pi-subagents slash bridge did not respond. Ensure pi-subagents is installed and loaded in this Pi session.");
    }, startTimeoutMs);

    const maxRuntimeTimeout = maxRuntimeMs === undefined ? undefined : setTimeout(() => {
      fail("pi-subagents slash bridge exceeded max runtime.", true);
    }, maxRuntimeMs);

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeout);
      if (idleTimeoutMs === undefined) return;
      idleTimeout = setTimeout(() => {
        fail("pi-subagents slash bridge timed out waiting for response.", true);
      }, idleTimeoutMs);
    };

    const abortRequest = () => {
      fail("pi-subagents slash bridge request was cancelled.", true);
    };

    const unsubscribeStarted = pi.events.on(SUBAGENT_SLASH_EVENTS.started, (data) => {
      if (done || !matchesRequest(data, requestId)) return;
      clearTimeout(startTimeout);
      resetIdleTimeout();
    });
    const unsubscribeResponse = pi.events.on(SUBAGENT_SLASH_EVENTS.response, (data) => {
      if (done || !matchesRequest(data, requestId)) return;
      finish(() => resolve(data));
    });
    const unsubscribeUpdate = pi.events.on(SUBAGENT_SLASH_EVENTS.update, (data) => {
      if (done || !matchesRequest(data, requestId)) return;
      resetIdleTimeout();
      options.onUpdate?.(data);
    });

    const finish = (next, finishOptions = {}) => {
      if (done) return;
      done = true;
      clearTimeout(startTimeout);
      clearTimeout(idleTimeout);
      clearTimeout(maxRuntimeTimeout);
      options.signal?.removeEventListener?.("abort", abortRequest);
      unsubscribeStarted?.();
      unsubscribeResponse?.();
      unsubscribeUpdate?.();
      if (finishOptions.cancel) {
        pi.events.emit(SUBAGENT_SLASH_EVENTS.cancel, {
          requestId,
          reason: finishOptions.reason,
        });
      }
      next();
    };

    options.signal?.addEventListener?.("abort", abortRequest, { once: true });
    if (options.signal?.aborted) {
      abortRequest();
      return;
    }

    pi.events.emit(SUBAGENT_SLASH_EVENTS.request, { requestId, params, ctx });
  });
}

function matchesRequest(data, requestId) {
  return Boolean(data && typeof data === "object" && data.requestId === requestId);
}
