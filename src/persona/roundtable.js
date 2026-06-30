import { assertUniqueAgentNames, discoverPersonaProject, findPrimaryGeneralist } from "./agents.js";
import { resolveAgentScope } from "./resolver.js";
import { buildScopedSubagentStep } from "./runtime.js";

const MAX_ROSTER_SIZE = 5;

export async function resolveRoundtableLaunchRequest(root, input = {}) {
  const query = requireText(input.query, "roundtable query");
  const context = input.context === "fork" ? "fork" : "fresh";
  const project = await discoverPersonaProject(root);
  assertUniqueAgentNames(project);
  const generalist = findPrimaryGeneralist(project, "roundtable");
  const roster = selectRoundtableRoster(project, query);
  if (roster.length === 0) {
    throw new Error("roundtable requires at least one specialist agent");
  }

  const scopes = new Map();
  for (const agent of [generalist, ...roster]) {
    scopes.set(agent.name, await resolveAgentScope(root, agent.name));
  }

  const chain = buildRoundtableChain({
    query,
    generalist,
    generalistScope: scopes.get(generalist.name),
    roster,
    scopes,
  });

  return {
    query,
    context,
    generalist,
    roster,
    subagentParams: {
      chain,
      task: query,
      clarify: false,
      agentScope: "both",
      context,
    },
  };
}

export function selectRoundtableRoster(project, query, options = {}) {
  const max = options.max ?? MAX_ROSTER_SIZE;
  const specialists = project.agents.filter((agent) => agent.role === "specialist");
  const scored = specialists
    .map((agent) => ({
      agent,
      score: scoreAgent(agent, query),
    }))
    .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));

  const eligible = scored.some((entry) => entry.score > 0)
    ? scored.filter((entry) => entry.score > 0)
    : scored;
  return eligible.slice(0, max).map((entry) => entry.agent);
}

export function formatRoundtableRosterPreview(roundtable) {
  const lines = [
    "# Pi Persona Round-table",
    "",
    `Query: ${roundtable.query}`,
    `Moderator: ${roundtable.generalist.name}`,
    `Context: ${roundtable.context}`,
    "",
    "## Roster",
  ];

  for (const agent of roundtable.roster) {
    lines.push(`- ${agent.name} - ${agent.description}`);
  }

  return lines.join("\n");
}

function buildRoundtableChain({ query, generalist, generalistScope, roster, scopes }) {
  return [
    {
      phase: "Round 1",
      parallel: roster.map((agent) => {
        const scope = scopes.get(agent.name);
        return buildScopedSubagentStep(scope, buildRoundOneTask(scope, query, roster));
      }),
    },
    {
      phase: "Round 2",
      parallel: roster.map((agent) => {
        const scope = scopes.get(agent.name);
        return buildScopedSubagentStep(scope, buildRoundTwoTask(scope, query, roster));
      }),
    },
    {
      phase: "Synthesis",
      ...buildScopedSubagentStep(generalistScope, buildSynthesisTask(generalistScope, query, roster)),
    },
  ];
}

function buildRoundOneTask(scope, query, roster) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Round 1 - Independent Position",
    "",
    `Specialist: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    `Query: ${query}`,
    "",
    "Give your independent specialist position. Do not reference peer answers; you have not seen them yet.",
    "Do not call persona_consult or subagent. The round-table is already the multi-agent interaction.",
  ].join("\n"));
}

function buildRoundTwoTask(scope, query, roster) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Round 2 - Reveal And Revise",
    "",
    `Specialist: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    `Query: ${query}`,
    "",
    "Peer round-1 positions:",
    "{previous}",
    "",
    "Revise, qualify, reinforce, or concede your position after reading the peer positions.",
    "Do not call persona_consult or subagent. Answer only as your specialist role.",
  ].join("\n"));
}

function buildSynthesisTask(scope, query, roster) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Moderator Synthesis",
    "",
    `Moderator: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    `Query: ${query}`,
    "",
    "Round-table outputs:",
    "{previous}",
    "",
    "Synthesize where specialists converged, where tensions remain, the recommended next action, and any specialist failures with their impact.",
  ].join("\n"));
}

function withDocs(scope, task) {
  if (scope.docs.length === 0) return task;
  return `[Read from: ${scope.docs.join(", ")}]\n\n${task}`;
}

function scoreAgent(agent, query) {
  const queryTokens = tokenize(query);
  const haystack = tokenize([
    agent.name,
    agent.description,
    ...(agent.tags ?? []),
    ...(agent.docs ?? []),
  ].join(" "));
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) score += 1;
  }
  return score;
}

function tokenize(value) {
  return new Set(String(value).toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function formatRosterNames(roster) {
  return roster.map((agent) => agent.name).join(", ");
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}
