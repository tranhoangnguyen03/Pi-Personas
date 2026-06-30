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
  applyModelOverride(params, scope);
  return params;
}

export function buildScopedSubagentStep(scope, task) {
  const step = {
    agent: scope.agent.name,
    task,
  };

  applyReadOverride(step, scope);
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

export function formatDocReadPreamble(scope) {
  const reads = getRuntimeReads(scope);
  if (reads.length === 0) return "";

  const lines = [`[Read from: ${reads.join(", ")}]`];
  const manifestLines = formatDocManifest(scope);
  if (manifestLines.length > 0) {
    lines.push("", "Resolved doc files:", ...manifestLines);
  }
  const skillManifestLines = formatSkillManifest(scope);
  if (skillManifestLines.length > 0) {
    lines.push("", "Resolved skill files:", ...skillManifestLines);
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

function formatSkillManifest(scope) {
  const manifest = scope.derived?.skillManifest ?? [];
  return manifest
    .filter((entry) => entry.files?.length > 0)
    .map((entry) => `- ${entry.declared}: ${entry.files.join(", ")}`);
}
