import {
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  assertPersonaRuntimeReady,
  createConsultProgressTracker,
  createRoundtableProgressTracker,
  createAgentScaffold,
  createDocsIndex,
  createPersonaInitDraft,
  createPersonaProjectScaffold,
  applyPersonaInitFromManifest,
  discoverPersonaProject,
  extractConsultAnswer,
  extractRoundtableAnswer,
  formatAgentScaffoldCreatedMessage,
  formatConsultBridgeResult,
  formatDocsIndexReport,
  formatDoctorReport,
  formatPersonaInitDraftAuthoringPrompt,
  formatPersonaInitManifestReport,
  formatPersonaProjectScaffoldCreatedMessage,
  formatPersonaList,
  formatRoundtableBridgeFailure,
  formatRoundtableBridgeResult,
  isDirectPersonaCommandName,
  parsePersonaIndexArgs,
  parsePersonaInitArgs,
  parsePersonaNewArgs,
  PI_SUBAGENTS_MANAGED_DELIVERY_VERSION,
  planPersonaInitFromManifest,
  resolveAgentLaunchRequest,
  resolveConsultLaunchRequest,
  resolveRoundtableLaunchRequest,
  resolveRoundtableSelectionRequest,
  runDoctor,
  sendPersonaOutput,
  runSubagentBridgeRequest,
  statusPersonaInitFromManifest,
} from "../src/persona/index.js";

const ACTIVE_PERSONA_STATE_TYPE = "pi-persona-active";
const CONSULT_IDLE_TIMEOUT_MS = 180_000;
const CONSULT_HEARTBEAT_MS = 10_000;
const IS_PI_SUBAGENT_CHILD = process.env.PI_SUBAGENT_CHILD === "1";

export default function registerPiPersona(pi: ExtensionAPI): void {
  if (IS_PI_SUBAGENT_CHILD) return;

  let activePersonaName: string | undefined;
  let pendingRoundtable: { cwd: string; query: string; moderator: string } | undefined;
  const registeredPersonaCommands = new Set<string>();

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
    label: "pi-persona",
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
        description: "fresh by default; fork inherits the current conversation branch",
      })),
    }),
    renderCall(args, theme, context) {
      const consultant = args.consultant || "consultant";
      const question = args.question || "(query pending)";
      const contextLine = formatConsultContextLine(args.context);
      let text = theme.fg("toolTitle", theme.bold(`Consulting ${consultant}`));
      text += `\n${theme.fg("muted", `Query: ${context.expanded ? question : truncatePanelText(question, 100)}`)}`;
      text += `\n${theme.fg("dim", contextLine)}`;

      if (context.expanded) {
        text += `\n\n${theme.fg("muted", `Requester: ${args.requester || "(unknown)"}`)}`;
        if (args.summary) text += `\n\n${theme.fg("muted", "Summary:")}\n${theme.fg("dim", args.summary)}`;
        if (args.constraints) text += `\n\n${theme.fg("muted", "Constraints:")}\n${theme.fg("dim", args.constraints)}`;
        if (args.expectedOutput) text += `\n\n${theme.fg("muted", "Expected output:")}\n${theme.fg("dim", args.expectedOutput)}`;
      } else {
        text += `\n${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const output = firstToolResultText(result);
      if (isPartial) {
        return new Text(theme.fg("toolOutput", stripConsultProgressHeading(output)), 0, 0);
      }

      const failed = result.isError === true;
      const status = failed
        ? theme.fg("error", "✗ Consultation failed")
        : theme.fg("success", "✓ Consultation complete");
      if (!expanded) {
        return new Text(status, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(status, 0, 0));
      if (output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
      }
      return container;
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let progress: ReturnType<typeof createConsultProgressReporter> | undefined;
      try {
        restoreActivePersona(ctx);
        if (!activePersonaName) {
          throw new Error("persona_consult requires an active persona; run /persona use <name> first");
        }
        if (params.requester !== activePersonaName) {
          throw new Error(`persona_consult requester must match active persona '${activePersonaName}'`);
        }
        const consult = await resolveConsultLaunchRequest(ctx.cwd, params);
        await assertPersonaRuntimeReady(ctx.cwd);
        progress = createConsultProgressReporter(onUpdate, consult.consultant.name);
        const response = await runSubagentBridgeRequest(pi, ctx, consult.subagentParams, {
          signal,
          onUpdate(update: unknown) {
            progress?.update(update);
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
      } finally {
        progress?.stop();
      }
    },
  });

  pi.registerTool({
    name: "persona_roundtable",
    label: "pi-persona",
    description: "Run one blueprint round-table over specialists selected by the active primary generalist.",
    promptSnippet: "Use persona_roundtable exactly once after /persona-roundtable asks the primary generalist to select a roster. Preserve the user's query, give one concrete reason per specialist, and present the returned moderator synthesis once.",
    parameters: Type.Object({
      query: Type.String({ description: "The user's round-table query, unchanged" }),
      selections: Type.Array(Type.Object({
        name: Type.String({ description: "Selected specialist persona name" }),
        reason: Type.String({ description: "Concrete reason this specialist is useful" }),
      }, { additionalProperties: false }), {
        minItems: 1,
        maxItems: 5,
        description: "One to five specialists selected from the project roster",
      }),
      context: Type.Optional(Type.String({
        enum: ["fresh", "fork"],
        description: "fresh by default; fork only when full conversation context is deliberately required",
      })),
    }),
    renderCall(args, theme, context) {
      const selections = Array.isArray(args.selections) ? args.selections : [];
      let text = theme.fg("toolTitle", theme.bold(`Round-table · ${selections.length || "…"} specialists`));
      text += `\n${theme.fg("muted", `Query: ${context.expanded ? args.query || "(query pending)" : truncatePanelText(args.query || "(query pending)", 100)}`)}`;
      text += `\n${theme.fg("dim", formatRoundtableContextLine(args.context))}`;
      if (context.expanded) {
        text += `\n${theme.fg("muted", "Moderator: active primary generalist")}`;
        text += `\n\n${theme.fg("muted", "Selected panel:")}`;
        for (const selection of selections) {
          text += `\n${theme.fg("toolTitle", selection.name || "(unknown)")} ${theme.fg("dim", `— ${selection.reason || "reason pending"}`)}`;
        }
        text += `\n\n${theme.fg("muted", "Process:")}`;
        text += `\n${theme.fg("dim", "1. Independent positions")}`;
        text += `\n${theme.fg("dim", "2. Peer reveal and revision")}`;
        text += `\n${theme.fg("dim", "3. Primary-generalist synthesis")}`;
      } else {
        const names = selections.map((selection: any) => selection.name).filter(Boolean).join(", ");
        if (names) text += `\n${theme.fg("dim", `Panel: ${names}`)}`;
        text += `\n${theme.fg("dim", keyHint("app.tools.expand", "to inspect selection"))}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const output = firstToolResultText(result);
      if (isPartial) {
        return new Text(theme.fg("toolOutput", stripRoundtableProgressHeading(output)), 0, 0);
      }

      const failed = result.isError === true;
      const status = failed
        ? theme.fg("error", "✗ Round-table failed")
        : theme.fg("success", "✓ Round-table complete");
      const process = formatRoundtableProcessLine(result.details?.process);
      if (!expanded) {
        return new Text(`${status}${process ? `\n${theme.fg("dim", process)}` : ""}`, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(`${status}${process ? `\n${theme.fg("dim", process)}` : ""}`, 0, 0));
      if (output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
      }
      return container;
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let progress: ReturnType<typeof createRoundtableProgressReporter> | undefined;
      try {
        restoreActivePersona(ctx);
        if (!pendingRoundtable || pendingRoundtable.cwd !== ctx.cwd) {
          throw new Error("persona_roundtable requires a pending /persona-roundtable request");
        }
        if (params.query.trim() !== pendingRoundtable.query) {
          throw new Error("persona_roundtable query must match the pending /persona-roundtable request unchanged");
        }
        const roundtable = await resolveRoundtableLaunchRequest(ctx.cwd, params);
        if (activePersonaName !== roundtable.generalist.name || pendingRoundtable.moderator !== roundtable.generalist.name) {
          throw new Error(`persona_roundtable requires active primary generalist '${roundtable.generalist.name}'`);
        }
        await assertPersonaRuntimeReady(ctx.cwd, {
          minimumPiSubagentsVersion: PI_SUBAGENTS_MANAGED_DELIVERY_VERSION,
        });
        pendingRoundtable = undefined;
        progress = createRoundtableProgressReporter(onUpdate, roundtable);
        const response = await runSubagentBridgeRequest(pi, ctx, roundtable.subagentParams, {
          signal,
          idleTimeoutMs: false,
          onUpdate(update: unknown) {
            progress?.update(update);
          },
        });
        const process = createRoundtableProcessDetails(roundtable, response, progress.summary());
        if (response.isError === true) {
          return {
            content: [{ type: "text", text: formatRoundtableBridgeFailure(roundtable, response) }],
            isError: true,
            details: {
              moderator: roundtable.generalist.name,
              roster: roundtable.roster.map((agent: any) => agent.name),
              context: roundtable.context,
              process,
              result: response.result,
            },
          };
        }
        const answer = await extractRoundtableAnswer(response, roundtable.generalist.name);
        const isError = answer.source === "missing";
        return {
          content: [{
            type: "text",
            text: isError
              ? formatRoundtableBridgeFailure(roundtable, response)
              : formatRoundtableBridgeResult(roundtable, answer.text),
          }],
          isError: isError || undefined,
          details: {
            moderator: roundtable.generalist.name,
            roster: roundtable.roster.map((agent: any) => agent.name),
            context: roundtable.context,
            process,
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
      } finally {
        progress?.stop();
      }
    },
  });

  const activatePersona = async (agentName: string, args: string, ctx: any) => {
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
  };

  const registerPersonaCommand = (agentName: string) => {
    if (!isDirectPersonaCommandName(agentName)) return;
    if (registeredPersonaCommands.has(agentName)) return;

    pi.registerCommand(agentName, {
      description: `Activate Pi Persona agent: ${agentName}`,
      handler: async (args, ctx) => {
        await activatePersona(agentName, args, ctx);
      },
    });
    registeredPersonaCommands.add(agentName);
  };

  registerPersonaCommand("generalist");

  const registerProjectCommands = async (cwd: string) => {
    const project = await discoverPersonaProject(cwd);
    for (const agent of project.agents) {
      registerPersonaCommand(agent.name);
    }
    return project;
  };

  pi.registerTool({
    name: "persona_init",
    label: "Persona Init",
    description: "Plan, apply, or inspect a Pi Persona setup manifest during assisted authoring.",
    promptSnippet: "Use persona_init with action plan before apply. Ask for explicit user approval, then call action apply with confirmed: true. Apply includes persona doctor verification; use status afterward.",
    parameters: Type.Object({
      action: Type.String({
        enum: ["plan", "apply", "status"],
        description: "Manifest action to perform",
      }),
      source: Type.String({ description: "Workspace-relative manifest YAML path" }),
      confirmed: Type.Optional(Type.Boolean({
        description: "Required for apply; set true only after explicit user approval",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        let result;
        let doctor;
        if (params.action === "plan") {
          result = await planPersonaInitFromManifest(ctx.cwd, params.source);
        } else if (params.action === "status") {
          result = await statusPersonaInitFromManifest(ctx.cwd, params.source);
        } else {
          if (params.confirmed !== true) {
            throw new Error("persona_init apply requires confirmed: true after explicit user approval");
          }
          result = await applyPersonaInitFromManifest(ctx.cwd, params.source);
          await registerProjectCommands(ctx.cwd);
          doctor = await runDoctor(ctx.cwd);
        }
        return {
          content: [{
            type: "text",
            text: [
              formatPersonaInitManifestReport(result, { doctorIncluded: Boolean(doctor) }),
              doctor ? formatDoctorReport(doctor) : "",
            ].filter(Boolean).join("\n\n"),
          }],
          isError: doctor?.status === "error" || undefined,
          details: doctor ? { ...result, doctor } : result,
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
      const failedPersonaName = activePersonaName;
      const message = error instanceof Error ? error.message : String(error);
      setActivePersona(ctx, undefined);
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Pi Persona\n\nPreviously active persona /${failedPersonaName} is not available in this workspace: ${message}. Answer normally and tell the user to run /persona-list or choose another persona.`,
      };
    }
  });

  pi.registerCommand("persona", {
    description: "Pi Persona commands. Supports: /persona init, /persona doctor, /persona new <name>, /persona index [docs-dir], /persona status, /persona clear",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = ""] = trimmed.split(/\s+/, 1);

      if (subcommand === "use") {
        const parsed = parsePersonaUseArgs(trimmed.slice("use".length));
        if (!parsed) {
          sendPersonaOutput(pi, ctx, "Usage: /persona use <name> [query]", "error");
          return;
        }
        await activatePersona(parsed.agentName, parsed.task, ctx);
        return;
      }

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
            pi.sendUserMessage(
              formatPersonaInitDraftAuthoringPrompt(result),
              ctx.isIdle() ? undefined : { deliverAs: "followUp" },
            );
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
        const selectionRequest = await resolveRoundtableSelectionRequest(ctx.cwd, { query });
        await assertPersonaRuntimeReady(ctx.cwd, {
          minimumPiSubagentsVersion: PI_SUBAGENTS_MANAGED_DELIVERY_VERSION,
        });
        pendingRoundtable = {
          cwd: ctx.cwd,
          query: selectionRequest.query,
          moderator: selectionRequest.generalist.name,
        };
        await activatePersona(selectionRequest.generalist.name, selectionRequest.userMessage, ctx);
      } catch (error) {
        sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
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
  if (message === `Unknown agent: ${agentName}`) {
    return `/${agentName} is not available in this workspace. Run /persona-list.`;
  }
  return message;
}

function personaUsage(): string {
  return [
    "Usage: /persona use <name> [query]",
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

function parsePersonaUseArgs(value: string): { agentName: string; task: string } | null {
  const match = value.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    agentName: match[1],
    task: match[2] ?? "",
  };
}

function formatConsultContextLine(context: unknown): string {
  return context === "fork"
    ? "Context: fork · current conversation branch inherited"
    : "Context: fresh · conversation history not included";
}

function formatRoundtableContextLine(context: unknown): string {
  return context === "fork"
    ? "Context: fork · current conversation branch inherited"
    : "Context: fresh · specialists receive only resolved persona context";
}

function truncatePanelText(value: unknown, maxLength: number): string {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstToolResultText(result: any): string {
  const part = result?.content?.find((entry: any) => entry?.type === "text");
  return typeof part?.text === "string" ? part.text.trim() : "";
}

function stripConsultProgressHeading(value: string): string {
  return value.replace(/^\[pi-persona\] Consulting [^\n]+\n+/, "").trim();
}

function stripRoundtableProgressHeading(value: string): string {
  return value.replace(/^\[pi-persona\] Round-table\n+/, "").trim();
}

function createRoundtableProcessDetails(roundtable: any, response: any, summary: any) {
  const results = Array.isArray(response?.result?.details?.results) ? response.result.details.results : [];
  return {
    specialists: roundtable.roster.length,
    rounds: 2,
    expectedSteps: roundtable.roster.length * 2 + 1,
    completedSteps: results.filter((entry: any) => entry?.exitCode === 0 || entry?.status === "completed").length,
    failedSteps: results.filter((entry: any) => entry?.exitCode > 0 || entry?.status === "failed").length,
    ...summary,
  };
}

function formatRoundtableProcessLine(process: any): string {
  if (!process) return "";
  const parts = [
    `${process.specialists} specialists`,
    `${process.rounds} rounds`,
    `${process.completedSteps}/${process.expectedSteps} steps complete`,
    `${formatPanelDuration(process.elapsedMs)} elapsed`,
  ];
  if (process.toolCount > 0) parts.push(`${process.toolCount} tools`);
  if (process.turns > 0) parts.push(`${process.turns} turns`);
  if (process.categories?.files > 0) parts.push(`${process.categories.files} files`);
  if (process.sources > 0) parts.push(`${process.sources} external sources`);
  if (process.recoverableErrors > 0) parts.push(`${process.recoverableErrors} recoverable errors`);
  if (process.failedSteps > 0) parts.push(`${process.failedSteps} failed steps`);
  return parts.join(" · ");
}

function formatPanelDuration(value: unknown): string {
  const seconds = Math.max(0, Math.floor((Number(value) || 0) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

function createConsultProgressReporter(onUpdate: any, agent: string) {
  const tracker = createConsultProgressTracker(agent, { idleTimeoutMs: CONSULT_IDLE_TIMEOUT_MS });
  let latestUpdate: unknown;
  let lastPublishedAt = 0;

  const publish = (force = false) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (!force && now - lastPublishedAt < 1_000) return;
    lastPublishedAt = now;
    onUpdate({
      content: [{ type: "text", text: tracker.format(now) }],
      details: latestUpdate,
    });
  };

  const heartbeat = setInterval(() => publish(true), CONSULT_HEARTBEAT_MS);
  (heartbeat as any).unref?.();
  publish(true);

  return {
    update(update: unknown) {
      latestUpdate = update;
      tracker.update(update);
      publish();
    },
    stop() {
      clearInterval(heartbeat);
    },
  };
}

function createRoundtableProgressReporter(onUpdate: any, roundtable: any) {
  const tracker = createRoundtableProgressTracker(roundtable.roster.map((agent: any) => agent.name), {
    idleTimeoutMs: false,
    moderator: roundtable.generalist.name,
  });
  let latestUpdate: unknown;
  let lastPublishedAt = 0;

  const publish = (force = false) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (!force && now - lastPublishedAt < 1_000) return;
    lastPublishedAt = now;
    onUpdate({
      content: [{ type: "text", text: tracker.format(now) }],
      details: latestUpdate,
    });
  };

  const heartbeat = setInterval(() => publish(true), CONSULT_HEARTBEAT_MS);
  (heartbeat as any).unref?.();
  publish(true);

  return {
    update(update: unknown) {
      const firstUpdate = latestUpdate === undefined;
      latestUpdate = update;
      tracker.update(update);
      publish(firstUpdate);
    },
    summary() {
      return tracker.snapshot();
    },
    stop() {
      clearInterval(heartbeat);
    },
  };
}
