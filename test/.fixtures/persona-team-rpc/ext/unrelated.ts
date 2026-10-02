// Test extension: stands in for an unrelated, unaffected extension whose
// commands must survive a Pi Persona-triggered ctx.reload().
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("unrelated-cmd", {
    description: "Fixed command from an unrelated extension",
    handler: async (_args, ctx) => {
      ctx.ui.notify("unrelated-cmd ok", "info");
    },
  });

  // Same name as team-toggle.ts's colliding command, different extension.
  pi.registerCommand("shared-name", {
    description: "unrelated's copy of a colliding command name",
    handler: async (_args, ctx) => {
      ctx.ui.notify("shared-name owner: unrelated", "info");
    },
  });
}
