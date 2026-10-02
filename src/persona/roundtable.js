import {
  assertUniqueAgentNames,
  discoverPersonaProject,
  findPrimaryGeneralist,
  formatPersonaDisplayName,
} from "./agents.js";
import { resolveAgentScope } from "./resolver.js";
import { formatDocReadPreamble } from "./runtime.js";

const MAX_ROSTER_SIZE = 5;
const PACK_AGENT_PREFIX = ".pi/agents/packs/";

// `options.project`, when supplied by a bound pack session, replaces
// workspace discovery and `options.packName` names its single pack directly
// instead of grouping `.pi/agents/packs/<pack>/` by relative path — a
// retained snapshot holds exactly one pack, so there is nothing to select
// among. `options.packRoot` is that snapshot's own root, threaded into
// resolveAgentScope so pack-owned docs resolve while `root`'s workspace docs
// stay live.
export async function resolveRoundtableLaunchRequest(root, input = {}, options = {}) {
  const query = requireText(input.query, "roundtable query");
  const context = input.context === "fork" ? "fork" : "fresh";
  const project = options.project ?? await discoverPersonaProject(root);
  assertUniqueAgentNames(project);
  const team = options.project
    ? resolveBoundTeam(project, options.packName)
    : resolveRoundtableTeam(project, input);
  const generalist = team.moderator;
  const selections = validateSelections(project, team, input.selections);
  const roster = selections.map((selection) => selection.agent);

  const scopes = new Map();
  for (const agent of [generalist, ...roster]) {
    scopes.set(agent.name, await resolveAgentScope(root, agent.name, { project, packRoot: options.packRoot }));
  }

  return {
    query,
    context,
    pack: team.pack,
    moderator: generalist,
    generalist,
    selections,
    roster,
    scopes,
  };
}

export async function runNativeRoundtable(roundtable, runStep, options = {}) {
  const assignments = new Map(roundtable.selections.map((selection) => [selection.agent.name, selection.reason]));
  const roundOne = await runNativePhase("Round 1", roundtable.roster.map((agent, index) => ({
    scope: roundtable.scopes.get(agent.name),
    task: buildRoundOneTask(roundtable.scopes.get(agent.name), roundtable.query, roundtable.roster, assignments.get(agent.name)),
    index,
  })), runStep, options);
  const roundOneText = formatNativeOutputs(roundOne);
  const roundTwo = await runNativePhase("Round 2", roundtable.roster.map((agent, index) => ({
    scope: roundtable.scopes.get(agent.name),
    task: buildRoundTwoTask(roundtable.scopes.get(agent.name), roundtable.query, roundtable.roster, roundOneText, assignments.get(agent.name)),
    index: roundtable.roster.length + index,
  })), runStep, options);
  const synthesis = await runNativePhase("moderator synthesis", [{
    scope: roundtable.scopes.get(roundtable.generalist.name),
    task: buildSynthesisTask(
      roundtable.scopes.get(roundtable.generalist.name),
      roundtable.query,
      roundtable.roster,
      formatNativeOutputs(roundTwo),
      roundtable.selections,
    ),
    index: roundtable.roster.length * 2,
  }], runStep, options);
  return { text: synthesis[0].text, steps: [...roundOne, ...roundTwo, ...synthesis] };
}

async function runNativePhase(phase, steps, runStep, options) {
  if (options.signal?.aborted) throw new Error("Native Pi Persona round-table was cancelled.");
  const controller = new AbortController();
  let firstError;
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener?.("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const settled = await Promise.allSettled(steps.map(async (step) => {
      try {
        const result = await runStep({ ...step, signal: controller.signal, onUpdate: options.onUpdate });
        options.onUpdate?.({ progress: [{ index: step.index, agent: step.scope.agent.name, status: "completed" }] });
        return { ...result, agent: step.scope.agent.name, index: step.index };
      } catch (error) {
        firstError ??= error;
        controller.abort(error);
        options.onUpdate?.({ progress: [{ index: step.index, agent: step.scope.agent.name, status: "failed" }] });
        throw error;
      }
    }));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) throw new Error(`Round-table stopped during ${phase}: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
    return settled.map((result) => result.value);
  } finally {
    options.signal?.removeEventListener?.("abort", abort);
  }
}

export async function resolveRoundtableSelectionRequest(root, input = {}, options = {}) {
  const query = requireText(input.query, "roundtable query");
  const context = input.context === "fork" ? "fork" : "fresh";
  const project = options.project ?? await discoverPersonaProject(root);
  assertUniqueAgentNames(project);
  const team = options.project
    ? resolveBoundTeam(project, options.packName)
    : resolveRoundtableTeam(project, input);
  const generalist = team.moderator;
  const specialists = team.candidates;
  if (specialists.length === 0) {
    throw new Error(team.pack
      ? `roundtable pack '${team.pack}' requires at least one specialist agent`
      : "roundtable requires at least one specialist agent");
  }

  return {
    query,
    context,
    pack: team.pack,
    moderator: generalist,
    generalist,
    candidates: specialists,
    userMessage: buildSelectionTask(query, team.pack, generalist, specialists, context),
  };
}

export function formatRoundtableBridgeResult(roundtable, answerText) {
  return [
    formatRoundtableRosterPreview(roundtable),
    "",
    "## Result",
    "",
    normalizeAnswerText(answerText),
  ].join("\n");
}

export function formatRoundtableRosterPreview(roundtable) {
  const lines = [
    "# Pi Persona Round-table",
    "",
    `Query: ${roundtable.query}`,
    `Moderator: ${formatPersonaDisplayName(roundtable.generalist)}`,
    `Context: ${roundtable.context}`,
    "",
    "## Roster",
  ];

  for (const agent of roundtable.roster) {
    lines.push(`- ${agent.name} - ${agent.description}`);
    const selection = roundtable.selections?.find((entry) => entry.agent.name === agent.name);
    if (selection?.reason) lines.push(`  selected because: ${selection.reason}`);
  }

  return lines.join("\n");
}

function buildSelectionTask(query, pack, generalist, specialists, context) {
  return [
    "## Host this Pi Persona round-table",
    "",
    ...(pack ? [`Pack: ${pack}`] : []),
    `Moderator: ${formatPersonaDisplayName(generalist)}`,
    `Context mode: ${context}`,
    "",
    "Question:",
    query,
    "",
    "Available perspectives:",
    ...specialists.map((agent) => `- ${agent.name} — ${agent.description}`),
    "",
    `Choose the smallest useful panel, up to ${MAX_ROSTER_SIZE} specialists, using only the perspectives above.`,
    "Because the user explicitly requested a round-table, normally use two to four complementary specialists when multiple perspectives can materially improve the answer. Use one only when exactly one perspective is useful or the user explicitly asks for a single lens.",
    "Give every selected specialist a distinct assigned contribution, then run one round-table for the question as written.",
    "After it finishes, present the final moderator synthesis faithfully and in full. Do not summarize, shorten, paraphrase, or replace it with a second verdict.",
  ].join("\n");
}

function buildRoundOneTask(scope, query, roster, assignment) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Round 1 - Independent Position",
    "",
    `Specialist: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    ...(assignment === undefined ? [] : [`Assigned contribution: ${assignment}`]),
    `Query: ${query}`,
    "",
    "Give an independent, self-contained specialist position. Do not reference peer answers; you have not seen them yet.",
    "Use these labeled parts:",
    "- Claim: your strongest answer to the question from this assigned perspective.",
    "- Reasoning: the reasoning that supports the claim.",
    "- Test: the assumption, evidence, counterexample, constraint, or tension you examined.",
    "- Conditions: when the claim should carry more or less weight.",
    "- Implication: what this changes in the user's decision or understanding.",
    "This round-table step is a leaf task.",
    "Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`.",
    "If blocked, report the blocker in your returned answer.",
  ].join("\n"));
}

function buildRoundTwoTask(scope, query, roster, previous = "{previous}", assignment) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Round 2 - Reveal And Revise",
    "",
    `Specialist: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    ...(assignment === undefined ? [] : [`Assigned contribution: ${assignment}`]),
    `Query: ${query}`,
    "",
    "Round-1 positions, including your own:",
    previous,
    "",
    "Return a self-contained final position after reading the other positions. Restate every claim and reason needed for synthesis instead of referring back to Round 1.",
    "Use these labeled parts:",
    "- Final claim and reasoning: your complete revised position.",
    "- Strongest peer insight: what another perspective adds.",
    "- Remaining tension: the most important unresolved disagreement.",
    "- Revision: what changed, or why your position did not change.",
    "- Conditions and implication: when this position should govern and what follows for the user.",
    "This round-table step is a leaf task.",
    "Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`.",
    "If blocked, report the blocker in your returned answer.",
  ].join("\n"));
}

function buildSynthesisTask(scope, query, roster, previous = "{previous}", selections) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Moderator Synthesis",
    "",
    `Moderator: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    `Query: ${query}`,
    "",
    ...(Array.isArray(selections) ? [
      "Assigned contributions:",
      ...selections.map((selection) => `- ${selection.agent.name}: ${selection.reason}`),
      "",
    ] : []),
    "Self-contained final specialist positions:",
    previous,
    "",
    "Produce an argued synthesis, not a compressed recap or roll call. Use exactly these visible headings, in this order:",
    "## Answer",
    "Give the integrated judgment directly.",
    "## Perspective contributions",
    "Give every selected specialist a substantive paragraph containing its strongest claim, reasoning, and contribution to the answer. Do not omit a perspective or reduce it to a slogan.",
    "## Real disagreements",
    "Explain the assumptions, evidence standards, definitions, or values producing genuine tensions. Do not manufacture consensus.",
    "## Conditions and tradeoffs",
    "State when each concern should carry more weight and what it protects, risks, or requires.",
    "## Recommended decision",
    "Translate the synthesis into a concrete decision, rule, or next action rather than merely splitting the difference.",
    "## What could change the answer",
    "Name material uncertainty and the next evidence, clarification, or experiment most likely to change the judgment. Note any specialist failure and its impact.",
  ].join("\n"));
}

function formatNativeOutputs(results) {
  return results.map((result) => `### ${result.agent}\n\n${result.text}`).join("\n\n");
}

function withDocs(scope, task) {
  return withResolvedScope(scope, task);
}

function withResolvedScope(scope, task) {
  const sections = [];
  const docPreamble = formatDocReadPreamble(scope);
  if (docPreamble) sections.push(docPreamble);
  const baseline = scope.promptSections?.find((section) => section.label === "Baseline")?.body;
  if (baseline) sections.push(["## Baseline Context", "", baseline].join("\n"));
  sections.push(task);
  return sections.join("\n\n");
}

function resolveRoundtableTeam(project, input) {
  const packs = discoverPackTeams(project);
  if (packs.length === 0) {
    if (project.agents.length === 0) {
      throw new Error(project.baseline
        ? "round-tables need a persona team; ask in chat to install or choose one (or run /persona pack list and /persona team)"
        : "Pi Persona onboarding is required before round-tables; run /persona onboard");
    }
    return {
      pack: undefined,
      moderator: findPrimaryGeneralist(project, "roundtable moderation"),
      candidates: project.agents.filter((agent) => agent.role === "specialist"),
    };
  }

  const activeAgent = resolveActiveAgent(project, input.activePersona);
  const activePack = activeAgent ? packNameFromAgent(activeAgent) : undefined;
  const explicitPack = optionalText(input.pack, "roundtable pack");
  if (activePack && explicitPack && activePack !== explicitPack) {
    throw new Error(`active persona '${activeAgent.name}' belongs to pack '${activePack}', not '${explicitPack}'`);
  }

  const selectedPack = explicitPack ?? activePack;
  if (selectedPack) {
    const team = packs.find((candidate) => candidate.pack === selectedPack);
    if (!team) {
      throw new Error(`unknown roundtable pack '${selectedPack}'; available packs: ${packs.map((candidate) => candidate.pack).join(", ")}`);
    }
    return validatePackTeam(team);
  }

  if (packs.length === 1) return validatePackTeam(packs[0]);

  const error = new Error(`roundtable team selection required; choose one installed pack: ${packs.map(formatPackChoice).join(", ")}`);
  error.code = "ROUNDTABLE_PACK_REQUIRED";
  error.packs = packs.map((team) => {
    const moderators = team.agents.filter((agent) => agent.role === "generalist");
    return {
      name: team.pack,
      moderator: moderators.length === 1 ? moderators[0].name : undefined,
    };
  });
  throw error;
}

function discoverPackTeams(project) {
  const byPack = new Map();
  for (const agent of project.agents) {
    const pack = packNameFromAgent(agent);
    if (!pack) continue;
    const agents = byPack.get(pack) ?? [];
    agents.push(agent);
    byPack.set(pack, agents);
  }
  return [...byPack.entries()]
    .map(([pack, agents]) => ({ pack, agents }))
    .sort((left, right) => left.pack.localeCompare(right.pack));
}

// A bound pack session's project holds exactly one pack's agents, already
// scoped by pack-session.js; there is no `.pi/agents/packs/<pack>/` prefix to
// group by and no ambiguity to resolve, so this reuses the same
// exactly-one-generalist validation as a workspace multi-pack team instead of
// a parallel check.
function resolveBoundTeam(project, packName) {
  return validatePackTeam({ pack: packName, agents: project.agents });
}

function validatePackTeam(team) {
  const moderators = team.agents.filter((agent) => agent.role === "generalist");
  if (moderators.length !== 1) {
    throw new Error(`roundtable pack '${team.pack}' requires exactly one moderator with role generalist; found ${moderators.length}`);
  }
  return {
    ...team,
    moderator: moderators[0],
    candidates: team.agents.filter((agent) => agent.role === "specialist"),
  };
}

function resolveActiveAgent(project, value) {
  if (value === undefined || value === null) return undefined;
  const activePersona = requireText(value, "active persona");
  const relativePath = activePersona.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const matches = project.agents.filter((agent) => (
    agent.name === activePersona || agent.relativePath === relativePath
  ));
  if (matches.length === 0) throw new Error(`unknown active persona: ${activePersona}`);
  if (matches.length > 1) throw new Error(`ambiguous active persona: ${activePersona}`);
  return matches[0];
}

function packNameFromAgent(agent) {
  if (!agent.relativePath.startsWith(PACK_AGENT_PREFIX)) return undefined;
  const relativePath = agent.relativePath.slice(PACK_AGENT_PREFIX.length);
  const separator = relativePath.indexOf("/");
  return separator > 0 ? relativePath.slice(0, separator) : undefined;
}

function formatPackChoice(team) {
  const moderators = team.agents.filter((agent) => agent.role === "generalist");
  return moderators.length === 1
    ? `${team.pack} ([G] ${moderators[0].name})`
    : team.pack;
}

function validateSelections(project, team, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROSTER_SIZE) {
    throw new Error(`roundtable selection must contain between 1 and ${MAX_ROSTER_SIZE} specialists`);
  }
  const specialists = new Map(
    team.candidates.map((agent) => [agent.name, agent]),
  );
  const seen = new Set();
  return value.map((selection, index) => {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw new Error(`roundtable selection[${index}] must be an object`);
    }
    const name = requireText(selection.name, `roundtable selection[${index}].name`);
    const reason = requireText(selection.reason, `roundtable selection[${index}].reason`);
    const agent = specialists.get(name);
    if (!agent) {
      const elsewhere = project.agents.some((candidate) => candidate.role === "specialist" && candidate.name === name);
      if (team.pack && elsewhere) {
        throw new Error(`roundtable selected specialist outside trusted pack '${team.pack}': ${name}`);
      }
      throw new Error(`roundtable selected unknown specialist: ${name}`);
    }
    if (seen.has(name)) throw new Error(`roundtable selected duplicate specialist: ${name}`);
    seen.add(name);
    return { agent, reason };
  });
}

function formatRosterNames(roster) {
  return roster.map((agent) => agent.name).join(", ");
}

function normalizeAnswerText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "(no output)";
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalText(value, field) {
  if (value === undefined || value === null) return undefined;
  return requireText(value, field);
}
