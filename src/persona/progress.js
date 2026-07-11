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
      return formatRoundtableActivity(entries, latest);
    },
  });
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
  let lastUpdateAt = startedAt;
  let latest = {};

  return {
    update(update, now = Date.now()) {
      latest = update ?? {};
      lastUpdateAt = now;
      for (const entry of progressEntries(latest)) {
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
      const entries = progressEntries(latest);
      const running = entries.find((entry) => entry?.status === "running") ?? entries[0] ?? {};
      const elapsedMs = Math.max(0, now - startedAt);
      const idleMs = Math.max(0, now - lastUpdateAt);
      const toolCount = entries.length > 0
        ? entries.reduce((sum, entry) => sum + finiteNumber(entry.toolCount), 0)
        : finiteNumber(latest.toolCount);
      const tokens = entries.reduce((sum, entry) => sum + finiteNumber(entry.tokens), 0);
      const turns = entries.reduce((sum, entry) => sum + finiteNumber(entry.turnCount), 0);
      const facts = [
        `${formatDuration(elapsedMs)} elapsed`,
        idleMs < 1_000 ? "active now" : `active ${formatDuration(idleMs)} ago`,
        `${toolCount} tools`,
      ];
      if (seenSources.size > 0) facts.push(`${seenSources.size} sources`);
      if (seenFailures.size > 0) facts.push(`${seenFailures.size} recoverable errors`);
      if (turns > 0) facts.push(`${turns} turns`);
      if (tokens > 0) facts.push(`${formatCount(tokens)} tokens`);

      const lines = [
        title,
        "",
        ...(options.describe?.(entries) ?? []),
        facts.join(" · "),
      ];
      const current = options.current?.(entries, latest);
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

      if (idleTimeoutMs !== undefined && idleMs >= Math.max(0, idleTimeoutMs - 60_000)) {
        const remainingMs = Math.max(0, idleTimeoutMs - idleMs);
        lines.push(`No activity for ${formatDuration(idleMs)} · cancelling in ${formatDuration(remainingMs)} unless activity resumes`);
      }
      return lines.join("\n");
    },
  };
}

function formatRoundtablePhase(entries, rosterSize) {
  if (rosterSize < 1 || entries.length === 0) return ["Phase: starting"];
  const running = entries.find((entry) => entry?.status === "running");
  const pending = entries.find((entry) => entry?.status === "pending");
  const index = finiteNumber((running ?? pending)?.index);
  if (index < rosterSize) {
    return [`Phase: Round 1 · ${completedInRange(entries, 0, rosterSize)}/${rosterSize} specialists complete`];
  }
  if (index < rosterSize * 2) {
    return [`Phase: Round 2 · ${completedInRange(entries, rosterSize, rosterSize * 2)}/${rosterSize} specialists complete`];
  }
  return ["Phase: moderator synthesis"];
}

function formatRoundtableActivity(entries, latest) {
  const running = entries.filter((entry) => entry?.status === "running").slice(0, 3);
  if (running.length === 0) return undefined;
  const labels = running.map((entry) => `${entry.agent}${entry.currentTool ? `:${entry.currentTool}` : ""}`);
  const args = running.find((entry) => entry.currentToolArgs)?.currentToolArgs;
  return `Now: ${labels.join(", ")}${args ? ` · ${truncate(args, 100)}` : latest.currentTool ? ` · ${latest.currentTool}` : ""}`;
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
