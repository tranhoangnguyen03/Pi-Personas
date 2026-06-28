import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatDoctorReport, runDoctor } from "../src/persona/index.js";

export default function registerPiPersona(pi: ExtensionAPI): void {
  pi.registerCommand("agent", {
    description: "Pi Persona commands. Phase 1 supports: /agent doctor",
    handler: async (args, ctx) => {
      const [subcommand = ""] = args.trim().split(/\s+/, 1);
      if (subcommand !== "doctor") {
        ctx.ui.notify("Usage: /agent doctor", "info");
        return;
      }

      const result = await runDoctor(ctx.cwd);
      const report = formatDoctorReport(result);
      const level = result.status === "error" ? "error" : result.status === "warning" ? "warning" : "info";
      ctx.ui.notify(report, level);
    },
  });
}
