const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

export function createConsultProgressTracker(agent, options = {}) {
  return createObservableProgressTracker(`[pi-persona] Consulting ${agent}`, options);
}

export function createRoundtableProgressTracker(roster, options = {}) {
  const agents = Array.isArray(roster) ? roster : [];
  return createObservableProgressTracker("[pi-persona] Round-table", {
    ...options,
    describe(entries) {
      return formatRoundtablePhase(entries, agents.length);
    },
    current(entries, latest) {
      return formatRoundtableActivity(entries, latest, agents, options.moderator ?? "moderator");
    },
  });
}

export function createRoundtableProcessDetails(roundtable, response, summary) {
  const results = Array.isArray(response?.result?.details?.results) ? response.result.details.results : [];
  return {
    specialists: roundtable.roster.length,
    rounds: 2,
    expectedSteps: roundtable.roster.length * 2 + 1,
    completedSteps: results.filter((entry) => entry?.exitCode === 0 || entry?.status === "completed").length,
    failedSteps: results.filter((entry) => entry?.exitCode > 0 || entry?.status === "failed").length,
    ...summary,
  };
}

export function formatRoundtableProcessLine(process) {
  if (!process) return "";
  const parts = [
    `${process.specialists} specialists`,
    `${process.rounds} rounds`,
    `${process.completedSteps}/${process.expectedSteps} steps complete`,
    `${formatProcessDuration(process.elapsedMs)} elapsed`,
  ];
  if (process.toolCount > 0) parts.push(`${process.toolCount} tools`);
  if (process.turns > 0) parts.push(`${process.turns} turns`);
  if (process.categories?.files > 0) parts.push(`${process.categories.files} files`);
  if (process.sources > 0) parts.push(`${process.sources} external sources`);
  if (process.recoverableErrors > 0) parts.push(`${process.recoverableErrors} recoverable errors`);
  if (process.failedSteps > 0) parts.push(`${process.failedSteps} failed steps`);
  return parts.join(" · ");
}

function formatProcessDuration(value) {
  const seconds = Math.max(0, Math.floor((Number(value) || 0) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

function createObservableProgressTracker(title, options = {}) {
  const startedAt = options.startedAt ?? Date.now();
  const idleTimeoutMs = options.idleTimeoutMs === false
    ? undefined
    : options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const seenTools = new Set();
  const seenSources = new Set();
  const seenFailures = new Set();
  const toolCounts = new Map();
  const entryStates = new Map();
  let lastUpdateAt = startedAt;
  let latest = {};

  const entries = () => [...entryStates.values()].sort((left, right) => finiteNumber(left.index) - finiteNumber(right.index));
  const snapshot = (now = Date.now()) => {
    const currentEntries = entries();
    return {
      elapsedMs: Math.max(0, now - startedAt),
      idleMs: Math.max(0, now - lastUpdateAt),
      toolCount: currentEntries.length > 0
        ? currentEntries.reduce((sum, entry) => sum + finiteNumber(entry.toolCount), 0)
        : finiteNumber(latest.toolCount),
      sources: seenSources.size,
      recoverableErrors: seenFailures.size,
      turns: currentEntries.reduce((sum, entry) => sum + finiteNumber(entry.turnCount), 0),
      tokens: currentEntries.reduce((sum, entry) => sum + finiteNumber(entry.tokens), 0),
      categories: Object.fromEntries(toolCounts),
    };
  };

  return {
    update(update, now = Date.now()) {
      latest = update ?? {};
      lastUpdateAt = now;
      for (const entry of progressEntries(latest)) {
        const key = Number.isFinite(entry.index) ? entry.index : entry.agent;
        if (key !== undefined) {
          const merged = { ...(entryStates.get(key) ?? {}), ...entry };
          if (!Object.hasOwn(entry, "currentTool")) delete merged.currentTool;
          if (!Object.hasOwn(entry, "currentToolArgs")) delete merged.currentToolArgs;
          entryStates.set(key, merged);
        }
        for (const tool of entry.recentTools ?? []) {
          const key = `${tool.endMs ?? ""}\0${tool.tool ?? ""}\0${tool.args ?? ""}`;
          if (seenTools.has(key)) continue;
          seenTools.add(key);
          const category = toolCategory(tool.tool);
          toolCounts.set(category, (toolCounts.get(category) ?? 0) + 1);
          if (category === "webpages" || category === "repository") {
            seenSources.add(`${tool.tool}\0${tool.args}`);
          }
        }
        if (entry.failedTool) {
          seenFailures.add(`${entry.failedTool}\0${entry.toolCount ?? ""}\0${entry.lastActivityAt ?? ""}`);
        }
      }
    },

    format(now = Date.now()) {
      const currentEntries = entries();
      const running = currentEntries.find((entry) => entry?.status === "running") ?? currentEntries[0] ?? {};
      const summary = snapshot(now);
      const facts = [
        `${formatDuration(summary.elapsedMs)} elapsed`,
        summary.idleMs < 1_000 ? "active now" : `active ${formatDuration(summary.idleMs)} ago`,
        `${summary.toolCount} tools`,
      ];
      if (summary.sources > 0) facts.push(`${summary.sources} sources`);
      if (summary.recoverableErrors > 0) facts.push(`${summary.recoverableErrors} recoverable errors`);
      if (summary.turns > 0) facts.push(`${summary.turns} turns`);
      if (summary.tokens > 0) facts.push(`${formatCount(summary.tokens)} tokens`);

      const lines = [
        title,
        "",
        ...(options.describe?.(currentEntries) ?? []),
        facts.join(" · "),
      ];
      const current = options.current?.(currentEntries, latest);
      if (current) {
        lines.push(current);
      } else {
        const currentTool = running.currentTool ?? latest.currentTool;
        const currentArgs = running.currentToolArgs;
        lines.push(currentTool
          ? `Now: ${currentTool}${currentArgs ? ` · ${truncate(currentArgs, 100)}` : ""}`
          : "Now: no tool activity reported");
      }

      const breakdown = [...toolCounts.entries()]
        .filter(([, count]) => count > 0)
        .map(([category, count]) => `${count} ${category}`);
      if (breakdown.length > 0) lines.push(breakdown.join(" · "));

      if (idleTimeoutMs !== undefined && summary.idleMs >= Math.max(0, idleTimeoutMs - 60_000)) {
        const remainingMs = Math.max(0, idleTimeoutMs - summary.idleMs);
        lines.push(`No activity for ${formatDuration(summary.idleMs)} · cancelling in ${formatDuration(remainingMs)} unless activity resumes`);
      }
      return lines.join("\n");
    },

    snapshot,
  };
}

function formatRoundtablePhase(entries, rosterSize) {
  const phase = resolveRoundtablePhase(entries, rosterSize);
  if (phase.id === "starting") return ["Phase: starting", "Preparing the selected specialist panel."];
  if (phase.id === "round-1") {
    return [
      `Phase: Round 1 — independent positions · ${completedInRange(entries, 0, rosterSize)}/${rosterSize} complete`,
      "Specialists work separately before seeing peer answers.",
    ];
  }
  if (phase.id === "round-2") {
    return [
      `Phase: Round 2 — reveal and revise · ${completedInRange(entries, rosterSize, rosterSize * 2)}/${rosterSize} complete`,
      "Specialists challenge, reinforce, or revise after peer reveal.",
    ];
  }
  return ["Phase: moderator synthesis", "The primary generalist is resolving convergence, tension, and failures."];
}

function formatRoundtableActivity(entries, _latest, agents, moderator) {
  if (agents.length === 0) return undefined;
  const phase = resolveRoundtablePhase(entries, agents.length);
  const lines = ["Panel:"];
  for (let index = 0; index < agents.length; index += 1) {
    const roundOne = entries.find((entry) => entry.index === index);
    const roundTwo = entries.find((entry) => entry.index === index + agents.length);
    if (phase.id === "round-1" || phase.id === "starting") {
      lines.push(`- ${agents[index]} · ${formatSeatStatus(roundOne, "drafting independent position")}`);
    } else if (phase.id === "round-2") {
      lines.push(`- ${agents[index]} · ${roundOne?.status === "completed" ? "✓ independent" : formatSeatStatus(roundOne, "finishing independent position")} · ${formatSeatStatus(roundTwo, "revising after peer reveal")}`);
    } else {
      lines.push(`- ${agents[index]} · ${roundTwo?.status === "completed" ? "✓ two rounds complete" : formatSeatStatus(roundTwo, "finishing peer review")}`);
    }
  }
  if (phase.id === "synthesis") {
    lines.push(`- ${moderator} · ${formatSeatStatus(entries.find((entry) => entry.index >= agents.length * 2), "synthesizing verdict")}`);
  }
  lines.push(`Next: ${phase.next}`);
  return lines.join("\n");
}

function resolveRoundtablePhase(entries, rosterSize) {
  if (rosterSize < 1 || entries.length === 0) {
    return { id: "starting", next: "specialists form independent positions" };
  }
  const running = entries.find((entry) => entry?.status === "running");
  if (running?.index >= rosterSize * 2 || completedInRange(entries, rosterSize, rosterSize * 2) >= rosterSize) {
    return { id: "synthesis", next: "one managed moderator verdict" };
  }
  if (running?.index >= rosterSize || completedInRange(entries, 0, rosterSize) >= rosterSize) {
    return { id: "round-2", next: "the primary generalist synthesizes the revised positions" };
  }
  return { id: "round-1", next: "specialists see peer positions and revise" };
}

function formatSeatStatus(entry, activeLabel) {
  if (!entry || entry.status === "pending") return "○ waiting";
  if (entry.status === "failed" || entry.exitCode > 0) return "✗ failed";
  if (entry.status === "completed") return "✓ complete";
  const activity = humanActivity(entry, activeLabel);
  const facts = [
    finiteNumber(entry.toolCount) > 0 ? `${entry.toolCount} tools` : undefined,
    finiteNumber(entry.turnCount) > 0 ? `${entry.turnCount} turns` : undefined,
  ].filter(Boolean);
  return `… ${activity}${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}`;
}

function humanActivity(entry, fallback) {
  const tool = String(entry.currentTool ?? "").toLowerCase();
  if (!tool) return fallback;
  if (tool.includes("search") || tool.includes("web") || tool.includes("url")) return "searching evidence";
  if (tool === "read" || tool.includes("file") || tool.includes("pdf")) return "reading declared evidence";
  if (tool.includes("github") || tool.includes("repo") || tool === "grep" || tool === "find" || tool === "ls") return "inspecting repository evidence";
  if (tool === "bash") return "checking evidence";
  if (tool === "edit" || tool === "write") return "unexpected write activity";
  return `using ${truncate(entry.currentTool, 36)}`;
}

function completedInRange(entries, start, end) {
  return entries.filter((entry) => entry.index >= start && entry.index < end && entry.status === "completed").length;
}

function progressEntries(update) {
  return Array.isArray(update?.progress) ? update.progress.filter(Boolean) : [];
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function toolCategory(tool) {
  const name = typeof tool === "string" ? tool.toLowerCase() : "";
  if (name.includes("search")) return "searches";
  if (name.includes("github") || name.includes("repo")) return "repository";
  if (name.includes("web") || name.includes("pdf") || name.includes("url")) return "webpages";
  if (name === "read" || name.includes("file")) return "files";
  return "other";
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${seconds}s`;
}

function formatCount(value) {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function truncate(value, maxLength) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
