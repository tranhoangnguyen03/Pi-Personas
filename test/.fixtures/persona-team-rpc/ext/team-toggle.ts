// Test extension: simulates a persona-pack "active team" whose commands
// are rebuilt from scratch on ctx.reload(), driven by an external state file
// (stands in for the future global selection.json).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const STATE_FILE = process.env.PERSONA_PROBE_STATE!;

function readTeam(): string {
  if (!existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, JSON.stringify({ team: "alpha" }));
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8")).team;
}

export default function (pi: ExtensionAPI) {
  const team = readTeam(); // captured once per factory run (startup or reload)

  pi.registerCommand(`team-${team}`, {
    description: `Command only present while team=${team}`,
    handler: async (_args, ctx) => {
      ctx.ui.notify(`active team command: team-${team}`, "info");
    },
  });

  pi.registerCommand("persona-current", {
    description: "Report the team this extension instance was loaded with",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`persona-current team: ${team}`, "info");
    },
  });

  // Registered by both team-toggle.ts and unrelated.ts with the SAME name,
  // to probe cross-extension command name collision handling.
  pi.registerCommand("shared-name", {
    description: "team-toggle's copy of a colliding command name",
    handler: async (_args, ctx) => {
      ctx.ui.notify("shared-name owner: team-toggle", "info");
    },
  });

  pi.registerCommand("toggle-and-reload", {
    description: "Flip the probe team and reload the extension runtime",
    handler: async (_args, ctx) => {
      const next = team === "alpha" ? "beta" : "alpha";
      writeFileSync(STATE_FILE, JSON.stringify({ team: next }));
      ctx.ui.notify(`toggled team ${team} -> ${next}, reloading`, "info");
      await ctx.reload();
      return;
    },
  });
}
