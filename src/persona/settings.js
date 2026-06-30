import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SETTINGS_PATH = ".pi/settings.json";
const SUBAGENT_TOOL = "subagent";

export async function readProjectSettings(root) {
  try {
    return JSON.parse(await readFile(path.join(root, SETTINGS_PATH), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeProjectSettings(root, settings) {
  const filePath = path.join(root, SETTINGS_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function ensureNestedConsultRuntimeOverride(root, agentName) {
  const settings = await readProjectSettings(root);
  settings.subagents = isRecord(settings.subagents) ? settings.subagents : {};
  settings.subagents.agentOverrides = isRecord(settings.subagents.agentOverrides)
    ? settings.subagents.agentOverrides
    : {};

  const existing = settings.subagents.agentOverrides[agentName];
  const override = isRecord(existing) ? existing : {};
  override.tools = addSubagentTool(override.tools);
  settings.subagents.agentOverrides[agentName] = override;

  await writeProjectSettings(root, settings);
  return settings;
}

export function hasNestedConsultRuntimeOverride(settings, agent) {
  if (normalizeToolList(agent.tools).includes(SUBAGENT_TOOL)) return true;

  const override = settings?.subagents?.agentOverrides?.[agent.name];
  return normalizeToolList(override?.tools).includes(SUBAGENT_TOOL);
}

function addSubagentTool(value) {
  return [...new Set([...normalizeToolList(value), SUBAGENT_TOOL])];
}

function normalizeToolList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
