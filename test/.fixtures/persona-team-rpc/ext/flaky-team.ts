// Test extension: simulates a persona-pack "active team" whose NEW content
// (post-reload) is broken -- e.g. a corrupted pack.yaml or a bad reference
// path discovered only when the extension factory re-runs after ctx.reload().
// Driven by an external state file (stands in for a future global
// selection.json pointing at an invalid/incompatible pack).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const STATE_FILE = process.env.PERSONA_PROBE_STATE!;

function readState(): { broken: boolean } {
  if (!existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, JSON.stringify({ broken: false }));
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

export default function (pi: ExtensionAPI) {
  const state = readState(); // captured once per factory run (startup or reload)

  if (state.broken) {
    // Simulates a broken pack discovered only during the post-reload factory
    // re-run (e.g. an invalid manifest). Per docs/extensions.md "Error
    // Handling": "Extension errors are logged, agent continues" -- this
    // extension instance registers NOTHING, so none of its commands exist
    // after this throw. We deliberately do not swallow this error: the whole
    // point of this test is to observe how Pi's host behaves when an
    // extension factory throws during reload, not to hide it.
    throw new Error("simulated broken pack: flaky-team factory failed on reload");
  }

  pi.registerCommand("flaky-current", {
    description: "Report that this extension instance loaded successfully",
    handler: async (_args, ctx) => {
      ctx.ui.notify("flaky-current: ok", "info");
    },
  });

  pi.registerCommand("mark-broken-and-reload", {
    description: "Flip the probe state to broken and reload the extension runtime",
    handler: async (_args, ctx) => {
      writeFileSync(STATE_FILE, JSON.stringify({ broken: true }));
      // Deliberately NOT a claim of success -- only that a reload was
      // requested. Design draft §3: "do not conflate persisted intent with
      // successful activation." If activation later fails, nothing here
      // should read as a false success signal.
      ctx.ui.notify("reload requested (outcome not yet known)", "info");
      await ctx.reload();
      return;
    },
  });
}
