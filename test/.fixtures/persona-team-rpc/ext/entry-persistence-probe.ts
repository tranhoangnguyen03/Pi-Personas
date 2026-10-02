// Test extension: exercises the pi.appendEntry() / ctx.sessionManager.getBranch()
// pattern already used by extensions/pi-persona.ts (ACTIVE_PERSONA_STATE_TYPE),
// across reload / resume / fork transitions, with no LLM calls involved.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TEAM_PENDING_ENTRY_TYPE } from "../../../../src/persona/pack-session.js";

const CUSTOM_TYPE = "probe-entry";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("remember", {
    description: "Append a custom session entry (no LLM call)",
    handler: async (args, ctx) => {
      pi.appendEntry(CUSTOM_TYPE, { value: args || "default" });
      ctx.ui.notify(`remembered:${args || "default"}`, "info");
    },
  });

  pi.registerCommand("recall", {
    description: "Read back the latest custom session entry via getBranch()",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const found = [...entries].reverse().find(
        (e: any) => e.type === "custom" && e.customType === CUSTOM_TYPE,
      );
      ctx.ui.notify(`recall:${found ? JSON.stringify((found as any).data) : "none"}`, "info");
    },
  });

  pi.registerCommand("seed", {
    description: "Inject a synthetic user message directly into the session (bypasses the agent loop, no LLM call)",
    handler: async (_args, ctx) => {
      const id = ctx.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed-message" }],
        timestamp: Date.now(),
      });
      ctx.ui.notify(`seeded:${id}`, "info");
    },
  });

  // Pi's SessionManager only flushes entries to disk once the session contains
  // at least one assistant message (see session-manager.js _persist(): entries
  // accumulate in memory only, unflushed, until `hasAssistant` is true). This
  // command appends a synthetic assistant message directly (bypassing the real
  // agent loop / model call) purely to flip that flush gate for this test.
  pi.registerCommand("seed-assistant", {
    description: "Inject a synthetic assistant message to trigger Pi's disk-flush gate (no LLM call)",
    handler: async (_args, ctx) => {
      const id = ctx.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "seed-assistant-message" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "probe-fake-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      ctx.ui.notify(`seeded-assistant:${id}`, "info");
    },
  });

  pi.registerCommand("probe-reload", {
    description: "Reload the extension runtime (documented ctx.reload() pattern)",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  // Appends a raw pi-persona-team-pending entry directly, bypassing the real
  // extension's own switchPersonaTeam validation entirely. This forces a
  // deterministic pending-switch failure on the next reload/session_start
  // (the target never has to have been valid at any point), without needing
  // to race real file corruption against ctx.reload()'s timing.
  pi.registerCommand("inject-team-pending", {
    description: "Append a raw team-pending entry for a target that was never validated (forces completePendingSwitch's failure path deterministically)",
    handler: async (args, ctx) => {
      const target = args.trim();
      pi.appendEntry(TEAM_PENDING_ENTRY_TYPE, { target: target === "none" ? null : target });
      ctx.ui.notify(`injected-pending:${target}`, "info");
    },
  });
}
