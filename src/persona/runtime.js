export function buildScopedSubagentParams(scope, task, options = {}) {
  const context = options.context === "fork" ? "fork" : "fresh";
  const params = {
    agent: scope.agent.name,
    task,
    clarify: false,
    agentScope: "both",
    context,
  };

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
  if (scope.docs.length === 0) return;
  target.reads = [...scope.docs];
}

function applyModelOverride(target, scope) {
  if (!scope.agent.model) return;
  target.model = scope.agent.model;
}
