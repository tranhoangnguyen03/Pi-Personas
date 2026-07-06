import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createAgentScaffold,
  createDocsIndex,
  createPersonaInitDraft,
  createPersonaProjectScaffold,
  applyPersonaInitFromManifest,
  discoverPersonaProject,
  extractConsultAnswer,
  formatAgentScaffoldCreatedMessage,
  formatConsultBridgeResult,
  formatDocsIndexReport,
  formatDoctorReport,
  formatPersonaInitManifestReport,
  formatPersonaProjectScaffoldCreatedMessage,
  formatPersonaList,
  formatRoundtableRosterPreview,
  parsePersonaIndexArgs,
  parsePersonaInitArgs,
  parsePersonaNewArgs,
  planPersonaInitFromManifest,
  resolveAgentLaunchRequest,
  resolveConsultLaunchRequest,
  resolveRoundtableLaunchRequest,
  runDoctor,
  sendPersonaOutput,
  runSubagentBridgeRequest,
  statusPersonaInitFromManifest,
} from "../src/persona/index.js";

const ACTIVE_PERSONA_STATE_TYPE = "pi-persona-active";
const REGISTERED_PERSONA_COMMANDS = new Set<string>();
const PROGRESS_FRAMES = ["-", "\\", "|", "/"];
const VISIBLE_PROGRESS_MS = 8_000;
const IS_PI_SUBAGENT_CHILD = process.env.PI_SUBAGENT_CHILD === "1";
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
  if (IS_PI_SUBAGENT_CHILD) return;

  let activePersonaName: string | undefined;

  const updateActivePersonaStatus = (ctx: any) => {
    ctx.ui?.setStatus?.(
      "pi-persona-active",
      activePersonaName ? `persona /${activePersonaName}` : undefined,
    );
  };

  const restoreActivePersona = (ctx: any, options: { resetIfMissing?: boolean } = {}) => {
    const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== ACTIVE_PERSONA_STATE_TYPE) continue;
      const agentName = entry.data?.agentName;
      activePersonaName = typeof agentName === "string" && agentName ? agentName : undefined;
      return;
    }
    if (options.resetIfMissing) activePersonaName = undefined;
  };

  const setActivePersona = (ctx: any, agentName: string | undefined) => {
    activePersonaName = agentName;
    pi.appendEntry(ACTIVE_PERSONA_STATE_TYPE, { agentName: agentName ?? null });
    updateActivePersonaStatus(ctx);
  };

  pi.registerTool({
    name: "persona_consult",
    label: "Persona Consult",
    description: "Ask a known Pi Persona peer for a focused consult. The tool runs the child-safe pi-subagents request internally and returns the result.",
    promptSnippet: "Use persona_consult only when the active Pi Persona needs another known persona's expertise. Provide a narrow requester-written summary and synthesize the returned consultant answer.",
    parameters: Type.Object({
      requester: Type.String({ description: "Active Pi Persona requester agent name" }),
      consultant: Type.String({ description: "Known Pi Persona consultant agent name" }),
      question: Type.String({ description: "Specific question for the consultant" }),
      summary: Type.String({ description: "Requester-authored concise context summary" }),
      constraints: Type.Optional(Type.String({ description: "Constraints the consultant must follow" })),
      expectedOutput: Type.Optional(Type.String({ description: "Requested answer shape" })),
      context: Type.Optional(Type.String({
        enum: ["fresh", "fork"],
        description: "fresh by default; fork only when full conversation context is deliberately required",
      })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      try {
        const consult = await resolveConsultLaunchRequest(ctx.cwd, params);
        const response = await runSubagentBridgeRequest(pi, ctx, consult.subagentParams, {
          onUpdate(update: unknown) {
            onUpdate?.({
              content: [{ type: "text", text: formatSubagentProgress(update, consult.consultant.name) }],
              details: update,
            });
          },
        });
        const answer = await extractConsultAnswer(response);
        const text = formatConsultBridgeResult(consult, answer.text, response.isError === true || answer.source === "missing");
        return {
          content: [{ type: "text", text }],
          isError: response.isError === true || answer.source === "missing",
          details: {
            requester: consult.requester.name,
            consultant: consult.consultant.name,
            context: consult.context,
            subagentParams: consult.subagentParams,
            answer,
            result: response.result,
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
      description: `Activate Pi Persona agent: ${agentName}`,
      handler: async (args, ctx) => {
        try {
          const launch = await resolveAgentLaunchRequest(ctx.cwd, agentName, {
            task: normalizeCommandText(args),
          });
          setActivePersona(ctx, launch.agentName);
          if (!launch.userMessage) {
            ctx.ui.notify(`Active persona: /${launch.agentName}`, "info");
            return;
          }
          pi.sendUserMessage(
            launch.userMessage,
            ctx.isIdle() ? undefined : { deliverAs: "followUp" },
          );
        } catch (error) {
          sendPersonaOutput(pi, ctx, formatPersonaCommandError(agentName, error), "error");
        }
      },
    });
    REGISTERED_PERSONA_COMMANDS.add(agentName);
  };

  registerPersonaCommand("generalist");

  const registerProjectCommands = async (cwd: string) => {
    const project = await discoverPersonaProject(cwd);
    for (const agent of project.agents) {
      registerPersonaCommand(agent.name);
    }
    return project;
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      restoreActivePersona(ctx, { resetIfMissing: true });
      updateActivePersonaStatus(ctx);
      await registerProjectCommands(ctx.cwd);
    } catch (error) {
      console.error("Failed to register Pi Persona commands:", error);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    restoreActivePersona(ctx);
    if (!activePersonaName) {
      updateActivePersonaStatus(ctx);
      return undefined;
    }
    updateActivePersonaStatus(ctx);
    try {
      const launch = await resolveAgentLaunchRequest(ctx.cwd, activePersonaName);
      return {
        systemPrompt: `${event.systemPrompt}\n\n${launch.systemPrompt}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Pi Persona\n\nActive persona /${activePersonaName} could not be resolved: ${message}. Answer normally and tell the user to run /persona status or /persona clear.`,
      };
    }
  });

  pi.registerCommand("persona", {
    description: "Pi Persona commands. Supports: /persona init, /persona doctor, /persona new <name>, /persona index [docs-dir], /persona status, /persona clear",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = ""] = trimmed.split(/\s+/, 1);

      if (subcommand === "status") {
        restoreActivePersona(ctx);
        sendPersonaOutput(
          pi,
          ctx,
          activePersonaName ? `Active persona: /${activePersonaName}` : "Active persona: none",
          "info",
        );
        updateActivePersonaStatus(ctx);
        return;
      }

      if (subcommand === "clear") {
        setActivePersona(ctx, undefined);
        sendPersonaOutput(pi, ctx, "Active persona: none", "info");
        return;
      }

      if (subcommand === "doctor") {
        const result = await runDoctor(ctx.cwd);
        const report = formatDoctorReport(result);
        const level = result.status === "error" ? "error" : result.status === "warning" ? "warning" : "info";
        sendPersonaOutput(pi, ctx, report, level);
        return;
      }

      if (subcommand === "init") {
        const rawArgs = trimmed.slice("init".length).trim();
        try {
          const parsed = parsePersonaInitArgs(rawArgs);
          if (parsed.mode === "basic") {
            const result = await createPersonaProjectScaffold(ctx.cwd);
            registerPersonaCommand(result.primaryGeneralist);
            sendPersonaOutput(pi, ctx, formatPersonaProjectScaffoldCreatedMessage(result), "info");
            return;
          }
          if (parsed.mode === "draft") {
            const result = await createPersonaInitDraft(ctx.cwd, parsed.out);
            sendPersonaOutput(pi, ctx, formatPersonaInitManifestReport(result), "info");
            return;
          }
          if (parsed.mode === "plan") {
            const result = await planPersonaInitFromManifest(ctx.cwd, parsed.from);
            sendPersonaOutput(pi, ctx, formatPersonaInitManifestReport(result), "info");
            return;
          }
          if (parsed.mode === "status") {
            const result = await statusPersonaInitFromManifest(ctx.cwd, parsed.from);
            sendPersonaOutput(pi, ctx, formatPersonaInitManifestReport(result), "info");
            return;
          }
          const result = await applyPersonaInitFromManifest(ctx.cwd, parsed.from);
          await registerProjectCommands(ctx.cwd);
          sendPersonaOutput(pi, ctx, formatPersonaInitManifestReport(result), "info");
        } catch (error) {
          sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
        }
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

      if (subcommand === "index") {
        const rawArgs = trimmed.slice("index".length).trim();
        try {
          const parsed = parsePersonaIndexArgs(rawArgs);
          const result = await createDocsIndex(ctx.cwd, parsed);
          const hasError = result.results.some((entry: any) => entry.status === "error");
          sendPersonaOutput(pi, ctx, formatDocsIndexReport(result), hasError ? "error" : "info");
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

function formatPersonaCommandError(agentName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (agentName === "generalist" && message === "Unknown agent: generalist") {
    return "No Pi Persona `/generalist` agent found. Run `/persona init` first, or use `/persona-list` if this project uses a different primary persona name.";
  }
  return message;
}

function personaUsage(): string {
  return [
    "Usage: /persona init",
    "Usage: /persona init draft --out <file>",
    "Usage: /persona init --plan --from <file>",
    "Usage: /persona init --from <file>",
    "Usage: /persona init status --from <file>",
    "Usage: /persona status",
    "Usage: /persona clear",
    "Usage: /persona doctor",
    "Usage: /persona new <name> [--role generalist|specialist] [--description \"...\"] [--docs path[,path]] [--skills native-skill[,native-skill]]",
    "Usage: /persona index [docs-dir]",
    "Usage: /persona index --all",
  ].join("\n");
}

function createRoundtableProgress(pi: ExtensionAPI, ctx: any) {
  return createProgressReporter(pi, ctx, {
    statusKey: "pi-persona-roundtable",
    statusLabel: "round-table",
    visibleLabel: "Round-table progress",
    format(update: unknown) {
      return formatSubagentProgress(update);
    },
  });
}

function createProgressReporter(
  pi: ExtensionAPI,
  ctx: any,
  options: {
    statusKey: string;
    statusLabel: string;
    visibleLabel: string;
    format(update: unknown): string;
  },
) {
  let stopped = false;
  let frameIndex = 0;
  let lastVisibleAt = Date.now();
  let latestDetail = "starting";

  const render = (detail = latestDetail, visible = false) => {
    if (stopped) return;
    latestDetail = detail || latestDetail;
    const frame = PROGRESS_FRAMES[frameIndex % PROGRESS_FRAMES.length];
    frameIndex += 1;
    ctx.ui?.setStatus?.(options.statusKey, `${options.statusLabel} ${frame} ${latestDetail}`);

    const now = Date.now();
    if (visible && now - lastVisibleAt >= VISIBLE_PROGRESS_MS) {
      lastVisibleAt = now;
      sendPersonaOutput(pi, ctx, `${options.visibleLabel} ${frame}: ${latestDetail}`, "info");
    }
  };

  const timer = setInterval(() => render("running", true), 750);
  (timer as any).unref?.();
  render("starting");

  return {
    update(update: unknown) {
      render(options.format(update), true);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      ctx.ui?.setStatus?.(options.statusKey, undefined);
    },
  };
}

function formatSubagentProgress(update: any, fallbackAgent = "agent"): string {
  const progress = Array.isArray(update?.progress) ? update.progress : [];
  const total = progress.length;
  const completed = progress.filter((entry: any) => entry?.status === "completed").length;
  const running = progress
    .filter((entry: any) => entry?.status === "running")
    .map((entry: any) => {
      const agent = typeof entry?.agent === "string" && entry.agent ? entry.agent : fallbackAgent;
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
