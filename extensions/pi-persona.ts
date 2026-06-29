import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createAgentScaffold,
  discoverPersonaProject,
  formatConsultProvenance,
  formatDoctorReport,
  formatPersonaList,
  resolveAgentLaunchRequest,
  resolveConsultLaunchRequest,
  runDoctor,
  sendPersonaOutput,
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
  pi.registerTool({
    name: "persona_consult",
    label: "Persona Consult",
    description: "Consult an allowed Pi Persona peer. The requester must be the active persona agent, the consultant must be listed in its consults field or allowed by consults: all, and summarized fresh context is the default.",
    promptSnippet: "Use persona_consult only when your Pi Persona scope lists an allowed consult peer and the question genuinely needs that peer. Provide your own concise summary of relevant context.",
    parameters: Type.Object({
      requester: Type.String({ description: "Active Pi Persona requester agent name" }),
      consultant: Type.String({ description: "Allowed Pi Persona consultant agent name" }),
      question: Type.String({ description: "Specific question for the consultant" }),
      summary: Type.String({ description: "Requester-authored concise context summary" }),
      constraints: Type.Optional(Type.String({ description: "Constraints the consultant must follow" })),
      expectedOutput: Type.Optional(Type.String({ description: "Requested answer shape" })),
      context: Type.Optional(Type.String({
        enum: ["fresh", "fork"],
        description: "fresh by default; fork only when full conversation context is deliberately required",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const consult = await resolveConsultLaunchRequest(ctx.cwd, params);
        const response = await runSubagentBridgeRequest(pi, ctx, consult.subagentParams);
        const text = bridgeResponseText(response);
        const provenance = formatConsultProvenance([{
          consultant: consult.consultant.name,
          status: response.isError ? "failed" : "answered",
          summary: response.isError ? response.errorText || text : firstLine(text),
        }]);
        return {
          content: [{ type: "text", text: `${text}\n\n${provenance}` }],
          isError: response.isError,
          details: {
            requester: consult.requester.name,
            consultant: consult.consultant.name,
            context: consult.context,
            provenance,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
          details: { error: true },
        };
      }
    },
  });

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
          sendPersonaOutput(pi, ctx, `## ${agentName}\n\n${text}`, response.isError ? "error" : "info");
        } catch (error) {
          sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
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
        sendPersonaOutput(pi, ctx, report, level);
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
          sendPersonaOutput(pi, ctx, `Created ${result.relativePath}`, "info");
        } catch (error) {
          sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      sendPersonaOutput(pi, ctx, "Usage: /persona doctor or /persona new <name>", "info");
    },
  });

  pi.registerCommand("persona-list", {
    description: "List available Pi Persona agents",
    handler: async (_args, ctx) => {
      try {
        const project = await registerProjectCommands(ctx.cwd);
        sendPersonaOutput(pi, ctx, formatPersonaList(project), "info");
      } catch (error) {
        sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
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

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) || "(no output)";
}
