import { discoverPersonaProject, findUniqueAgent } from "./agents.js";
import { uniqueStrings } from "./frontmatter.js";

export async function resolveAgentScope(root, agentName) {
  const project = await discoverPersonaProject(root);
  const agent = findUniqueAgent(project, agentName);

  const baselineFrontmatter = project.baseline?.frontmatter ?? {};
  const baselineBody = project.baseline?.body?.trim() ?? "";
  const agentBody = agent.body?.trim() ?? "";

  const docs = uniqueStrings([
    ...(baselineFrontmatter.docs ?? []),
    ...(agent.docs ?? []),
  ]);
  const tools = uniqueStrings([
    ...(baselineFrontmatter.tools ?? []),
    ...(agent.tools ?? []),
  ]);

  const promptSections = [];
  if (baselineBody) {
    promptSections.push({
      label: "Baseline",
      body: baselineBody,
    });
  }
  if (agentBody) {
    promptSections.push({
      label: "Agent",
      body: agentBody,
    });
  }

  return {
    agent,
    baseline: project.baseline,
    docs,
    tools,
    consults: agent.consults,
    tags: agent.tags,
    promptSections,
    prompt: promptSections.map((section) => `## ${section.label}\n\n${section.body}`).join("\n\n"),
    derived: {
      defaultReads: docs,
    },
  };
}

export const resolveAgentPreview = resolveAgentScope;
