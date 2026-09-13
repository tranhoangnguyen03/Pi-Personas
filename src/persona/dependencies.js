import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RUNTIME_PACKAGES = {
  piSubagents: {
    name: "pi-subagents",
    source: "npm:pi-subagents",
    path: "npm/node_modules/pi-subagents",
    missing: "pi-subagents missing; consults and round-tables are unavailable",
  },
};

export const PI_SUBAGENTS_ROUNDTABLE_MINIMUM_VERSION = "0.34.0";

export async function detectDependencies(root) {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const configuredPackages = await detectConfiguredPackages(agentDir, root);
  return {
    piSubagents: await detectPackage(agentDir, root, configuredPackages, RUNTIME_PACKAGES.piSubagents),
  };
}

export async function isPiSubagentsInstalled(root) {
  const dependency = (await detectDependencies(root)).piSubagents;
  if (dependency.broken) {
    throw new Error(`Cannot read installed pi-subagents at ${dependency.path}: ${dependency.error}`);
  }
  return dependency.ok === true;
}

async function detectPackage(agentDir, root, configuredPackages, spec) {
  const candidates = [
    path.join(root, ".pi", spec.path),
    path.join(agentDir, spec.path),
  ];
  for (const packagePath of candidates) {
    const packageJsonPath = path.join(packagePath, "package.json");
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      return {
        ok: true,
        version: packageJson.version ?? "unknown",
        path: packagePath,
        configured: configuredPackages.some(isPiSubagentsPackage),
        packageSource: configuredPackages.find(isPiSubagentsPackage) ?? spec.source,
      };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      try {
        await access(packageJsonPath);
      } catch {
        continue;
      }
      return {
        ok: false,
        broken: true,
        error: error instanceof Error ? error.message : String(error),
        path: packagePath,
        configured: configuredPackages.some(isPiSubagentsPackage),
        packageSource: configuredPackages.find(isPiSubagentsPackage) ?? spec.source,
      };
    }
  }
  return {
    ok: false,
    path: candidates[0],
    configured: configuredPackages.some(isPiSubagentsPackage),
    packageSource: configuredPackages.find(isPiSubagentsPackage) ?? spec.source,
  };
}

async function detectConfiguredPackages(agentDir, root) {
  return [
    ...await readSettingsPackages(path.join(agentDir, "settings.json")),
    ...await readSettingsPackages(path.join(root, ".pi/settings.json")),
  ];
}

async function readSettingsPackages(settingsPath) {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    return Array.isArray(settings.packages)
      ? settings.packages.map((entry) => typeof entry === "string" ? entry : entry?.source).filter((entry) => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function runtimePackages(packages) {
  return Array.isArray(packages) ? packages.filter(isPiSubagentsPackage) : [];
}

export function isPiSubagentsPackage(entry) {
  const source = typeof entry === "string" ? entry : entry?.source;
  return typeof source === "string" && /(?:^|[/@:])pi-subagents(?:@[^/]+|\.git)?(?:$|[/#?])/.test(source);
}

export function versionAtLeast(actual, minimum) {
  const actualMatch = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(actual ?? ""));
  const minimumMatch = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(minimum ?? ""));
  if (!actualMatch || !minimumMatch) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(actualMatch[index]) - Number(minimumMatch[index]);
    if (difference !== 0) return difference > 0;
  }
  return minimumMatch[4] !== undefined || actualMatch[4] === undefined;
}
