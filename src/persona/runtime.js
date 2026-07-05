export function buildScopedSubagentParams(scope, task, options = {}) {
  const context = options.context === "fork" ? "fork" : "fresh";
  const params = {
    agent: scope.agent.name,
    task,
    clarify: false,
    agentScope: "both",
    context,
  };

  applyReadOverride(params, scope);
  applySkillOverride(params, scope);
  applyModelOverride(params, scope);
  return params;
}

export function buildScopedSubagentStep(scope, task) {
  const step = {
    agent: scope.agent.name,
    task,
  };

  applyReadOverride(step, scope);
  applySkillOverride(step, scope);
  applyModelOverride(step, scope);
  return step;
}

function applyReadOverride(target, scope) {
  const reads = getRuntimeReads(scope);
  if (reads.length === 0) return;
  target.reads = reads;
}

function applyModelOverride(target, scope) {
  if (!scope.agent.model) return;
  target.model = scope.agent.model;
}

function applySkillOverride(target, scope) {
  const skills = scope.skills ?? [];
  if (skills.length === 0) return;
  target.skill = skills;
}

export function formatDocReadPreamble(scope) {
  const reads = getRuntimeReads(scope);
  const manifestLines = formatDocManifest(scope);
  const progressiveLines = formatProgressiveDiscoveryManifest(scope);
  if (
    reads.length === 0
    && manifestLines.length === 0
    && progressiveLines.length === 0
  ) {
    return "";
  }

  const lines = reads.length > 0
    ? [`[Read from: ${reads.join(", ")}]`]
    : ["[Read from: none]"];
  if (manifestLines.length > 0) {
    lines.push("", "Resolved doc files:", ...manifestLines);
  }
  if (progressiveLines.length > 0) {
    lines.push("", "Progressive doc discovery:", ...progressiveLines);
  }

  return lines.join("\n");
}

function getRuntimeReads(scope) {
  return [...(scope.derived?.defaultReads ?? scope.docs ?? [])];
}

function formatDocManifest(scope) {
  const manifest = scope.derived?.docManifest ?? [];
  if (!manifest.some((entry) => entry.files?.length > 0 && (entry.files.length !== 1 || entry.files[0] !== entry.declared))) {
    return [];
  }

  return manifest
    .filter((entry) => entry.files?.length > 0)
    .map((entry) => `- ${entry.declared}: ${entry.files.join(", ")}`);
}

function formatProgressiveDiscoveryManifest(scope) {
  const manifest = scope.derived?.docManifest ?? [];
  return manifest
    .filter((entry) => entry.deferred?.length > 0)
    .map((entry) => {
      const noun = entry.deferred.length === 1 ? "nested file" : "nested files";
      const indexInstruction = entry.indexFile
        ? `read ${entry.indexFile} before opening deeper docs`
        : "no _index file was found; inspect deeper docs deliberately only if needed";
      return `- ${entry.declared}: ${entry.deferred.length} ${noun} not included in reads; ${indexInstruction}`;
    });
}
