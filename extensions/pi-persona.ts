import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  createAgentScaffold,
  discoverPersonaProject,
  formatDoctorReport,
  formatPersonaList,
  resolveAgentLaunchRequest,
  runDoctor,
  runSubagentBridgeRequest,
} from "../src/persona/index.js";

const REGISTERED_PERSONA_COMMANDS = new Set<string>();
const RESERVED_COMMANDS = new Set([
  "agent",
  "chain",
  "compact",
  "fork",
  "parallel",
  "persona",
  "persona-list",
  "resume",
  "run",
  "run-chain",
  "subagents-doctor",
  "subagents-models",
  "tree",
]);

export default function registerPiPersona(pi: ExtensionAPI): void {
  const registerPersonaCommand = (agentName: string) => {
    if (!isSafeCommandName(agentName)) return;
    if (RESERVED_COMMANDS.has(agentName)) return;
    if (REGISTERED_PERSONA_COMMANDS.has(agentName)) return;

    pi.registerCommand(agentName, {
      description: `Start Pi Persona agent: ${agentName}`,
      handler: async (args, ctx) => {
        try {
          const launch = await resolveAgentLaunchRequest(ctx.cwd, agentName, { task: args });
          const response = await runSubagentBridgeRequest(pi, ctx, launch.subagentParams);
          const text = bridgeResponseText(response);
          if (typeof pi.sendMessage === "function") {
            pi.sendMessage({
              content: `## ${agentName}\n\n${text}`,
              display: true,
            });
          } else {
            ctx.ui.notify(text, response.isError ? "error" : "info");
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
    REGISTERED_PERSONA_COMMANDS.add(agentName);
  };

  const registerProjectCommands = async (cwd: string) => {
    const project = await discoverPersonaProject(cwd);
    for (const agent of project.agents) {
      registerPersonaCommand(agent.name);
    }
    return project;
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      await registerProjectCommands(ctx.cwd);
    } catch (error) {
      console.error("Failed to register Pi Persona commands:", error);
    }
  });

  pi.registerCommand("persona", {
    description: "Pi Persona commands. Supports: /persona doctor, /persona new <name>",
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
          ctx.ui.notify("Usage: /persona new <name>", "error");
          return;
        }
        try {
          const result = await createAgentScaffold(ctx.cwd, rawName);
          registerPersonaCommand(result.agentName);
          ctx.ui.notify(`Created ${result.relativePath}`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      ctx.ui.notify("Usage: /persona doctor or /persona new <name>", "info");
    },
  });

  pi.registerCommand("persona-list", {
    description: "List available Pi Persona agents",
    handler: async (_args, ctx) => {
      try {
        const project = await registerProjectCommands(ctx.cwd);
        ctx.ui.notify(formatPersonaList(project), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

function isSafeCommandName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

function bridgeResponseText(response: any): string {
  if (response?.errorText) return response.errorText;
  const content = response?.result?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .join("\n")
      .trim() || "(no output)";
  }
  return "(no output)";
}
