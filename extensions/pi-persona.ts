import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createAgentScaffold, formatDoctorReport, runDoctor } from "../src/persona/index.js";

export default function registerPiPersona(pi: ExtensionAPI): void {
  pi.registerCommand("agent", {
    description: "Pi Persona commands. Supports: /agent doctor, /agent new <name>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = ""] = trimmed.split(/\s+/, 1);

      if (subcommand === "doctor") {
        const result = await runDoctor(ctx.cwd);
        const report = formatDoctorReport(result);
        const level = result.status === "error" ? "error" : result.status === "warning" ? "warning" : "info";
        ctx.ui.notify(report, level);
        return;
      }

      if (subcommand === "new") {
        const rawName = trimmed.slice("new".length).trim();
        if (!rawName) {
          ctx.ui.notify("Usage: /agent new <name>", "error");
          return;
        }
        try {
          const result = await createAgentScaffold(ctx.cwd, rawName);
          ctx.ui.notify(`Created ${result.relativePath}`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      ctx.ui.notify("Usage: /agent doctor or /agent new <name>", "info");
    },
  });
}
