import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createAgentScaffold,
  discoverPersonaProject,
  formatAgentScaffoldCreatedMessage,
  formatConsultSubagentInstructions,
  formatDoctorReport,
  formatPersonaList,
  formatRoundtableRosterPreview,
  parsePersonaNewArgs,
  resolveAgentLaunchRequest,
  resolveConsultLaunchRequest,
  resolveRoundtableLaunchRequest,
  runDoctor,
  sendPersonaOutput,
  runSubagentBridgeRequest,
} from "../src/persona/index.js";

const REGISTERED_PERSONA_COMMANDS = new Set<string>();
const ROUNDTABLE_PROGRESS_FRAMES = ["-", "\\", "|", "/"];
const ROUNDTABLE_VISIBLE_PROGRESS_MS = 8_000;
const RESERVED_COMMANDS = new Set([
  "agent",
  "chain",
  "compact",
  "fork",
  "parallel",
  "persona",
  "persona-list",
  "persona-roundtable",
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
    description: "Prepare and validate an allowed Pi Persona peer consult request. Execute the returned request with the child-safe pi-subagents subagent tool.",
    promptSnippet: "Use persona_consult only when you need Pi Persona to validate and prepare a consult envelope. Then call the subagent tool with the returned request.",
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
        const text = formatConsultSubagentInstructions(consult);
        return {
          content: [{ type: "text", text }],
          isError: false,
          details: {
            requester: consult.requester.name,
            consultant: consult.consultant.name,
            context: consult.context,
            subagentParams: consult.subagentParams,
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
          ctx.ui.notify(personaUsage(), "error");
          return;
        }
        try {
          const parsed = parsePersonaNewArgs(rawName);
          const result = await createAgentScaffold(ctx.cwd, parsed.rawName, parsed.options);
          registerPersonaCommand(result.agentName);
          sendPersonaOutput(pi, ctx, formatAgentScaffoldCreatedMessage(result), "info");
        } catch (error) {
          sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      sendPersonaOutput(pi, ctx, personaUsage(), "info");
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

  pi.registerCommand("persona-roundtable", {
    description: "Run a Pi Persona round-table over selected specialists",
    handler: async (args, ctx) => {
      const query = normalizeCommandText(args);
      if (!query) {
        ctx.ui.notify('Usage: /persona-roundtable "query"', "error");
        return;
      }
      try {
        await registerProjectCommands(ctx.cwd);
        const roundtable = await resolveRoundtableLaunchRequest(ctx.cwd, { query });
        const preview = formatRoundtableRosterPreview(roundtable);
        const progress = createRoundtableProgress(pi, ctx);
        sendPersonaOutput(
          pi,
          ctx,
          `${preview}\n\nRound-table in progress. Watch the Pi status line for live progress; compact updates will appear until the result returns.`,
          "info",
        );
        try {
          const response = await runSubagentBridgeRequest(pi, ctx, roundtable.subagentParams, {
            onUpdate(update: unknown) {
              progress.update(update);
            },
          });
          const text = bridgeResponseText(response);
          sendPersonaOutput(pi, ctx, `${preview}\n\n## Result\n\n${text}`, response.isError ? "error" : "info");
        } finally {
          progress.stop();
        }
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

function normalizeCommandText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function personaUsage(): string {
  return [
    "Usage: /persona doctor",
    "Usage: /persona new <name> [--role generalist|specialist] [--description \"...\"] [--docs path[,path]] [--tools tool[,tool]] [--consults peer[,peer]] [--tags tag[,tag]]",
  ].join("\n");
}

function createRoundtableProgress(pi: ExtensionAPI, ctx: any) {
  let stopped = false;
  let frameIndex = 0;
  let lastVisibleAt = Date.now();
  let latestDetail = "starting";

  const render = (detail = latestDetail, visible = false) => {
    if (stopped) return;
    latestDetail = detail || latestDetail;
    const frame = ROUNDTABLE_PROGRESS_FRAMES[frameIndex % ROUNDTABLE_PROGRESS_FRAMES.length];
    frameIndex += 1;
    ctx.ui?.setStatus?.("pi-persona-roundtable", `round-table ${frame} ${latestDetail}`);

    const now = Date.now();
    if (visible && now - lastVisibleAt >= ROUNDTABLE_VISIBLE_PROGRESS_MS) {
      lastVisibleAt = now;
      sendPersonaOutput(pi, ctx, `Round-table progress ${frame}: ${latestDetail}`, "info");
    }
  };

  const timer = setInterval(() => render("running", true), 750);
  (timer as any).unref?.();
  render("starting");

  return {
    update(update: unknown) {
      render(formatRoundtableProgress(update), true);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      ctx.ui?.setStatus?.("pi-persona-roundtable", undefined);
    },
  };
}

function formatRoundtableProgress(update: any): string {
  const progress = Array.isArray(update?.progress) ? update.progress : [];
  const total = progress.length;
  const completed = progress.filter((entry: any) => entry?.status === "completed").length;
  const running = progress
    .filter((entry: any) => entry?.status === "running")
    .map((entry: any) => {
      const agent = typeof entry?.agent === "string" && entry.agent ? entry.agent : "agent";
      const tool = entry?.currentTool ? `:${entry.currentTool}` : "";
      return `${agent}${tool}`;
    })
    .slice(0, 3);

  if (running.length > 0) {
    return `${running.join(", ")} running${total ? ` (${completed}/${total} done)` : ""}`;
  }
  if (total > 0) {
    return `${completed}/${total} done`;
  }
  if (typeof update?.toolCount === "number") {
    const tool = update.currentTool ? `, ${update.currentTool}` : "";
    return `${update.toolCount} tools${tool}`;
  }
  return "running";
}
