#!/usr/bin/env node
// Builds a persistent, isolated manual-acceptance kit for interactively trying
// the candidate Pi Persona extension: a real `npm pack` tarball, installed
// (offline, --ignore-scripts, host peers packed the same way) into a
// disposable project OUTSIDE this checkout, plus an isolated
// PI_CODING_AGENT_DIR, a disposable WORKSPACE, a synthetic legacy workspace
// for /persona migrate, and two schema-2 custom fixture packs ("marketing",
// "philosophy") installed directly into the isolated store (no default set).
//
// Same offline-install pattern as scripts/task8-packed-acceptance/run-acceptance.mjs
// (host peers packed as real tarballs, `npm install --offline --ignore-scripts`);
// see that script's header comment for why. This script does not drive the
// SDK or RPC itself beyond a short smoke check -- see
// scripts/manual-acceptance/verify-kit.mjs for that, and the kit's own
// bin/launch.sh for actually opening the interactive TUI.
//
// Usage: node scripts/manual-acceptance/build-kit.mjs [kitDir]
// Default kitDir: /tmp/pi-persona-manual-acceptance-kit (removed and rebuilt
// fresh each run -- it is disposable fixture data, not user config).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "..", "..");
const KIT_ROOT = path.resolve(process.argv[2] ?? "/tmp/pi-persona-manual-acceptance-kit");

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// ---------------------------------------------------------------------------
// 1. Tarballs: pi-personas itself, plus its host peers, all packed as real
//    tarballs (not directory installs) so `npm install --offline` has no
//    reason to reach the network and installs ordinary non-symlinked copies.
// ---------------------------------------------------------------------------

async function packPackage(pkgDir, destDir) {
  run("npm", ["pack", "--pack-destination", destDir], { cwd: pkgDir });
  const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const scopelessName = pkg.name.replace(/^@/, "").replace("/", "-");
  return { tgzPath: path.join(destDir, `${scopelessName}-${pkg.version}.tgz`), name: pkg.name, version: pkg.version };
}

// ---------------------------------------------------------------------------
// 2. Fixture pack fixtures: two schema-2 custom packs, written straight into
//    the isolated store via the INSTALLED package's own store functions (not
//    this checkout's) -- deterministic, offline, no model calls, no default
//    set. Mirrors scripts/task8-packed-acceptance/run-acceptance.mjs's
//    installRealTeamPack helper.
// ---------------------------------------------------------------------------

async function installFixturePack(pkgRoot, storeRoot, sourceRoot, { name, leadName, specialistName, description }) {
  const { readPortablePersonaPack } = await import(pathToFileURL(path.join(pkgRoot, "src/persona/pack-source.js")).href);
  const { stageCustomPersonaPackDraft, applyCustomPersonaPackDraft } = await import(
    pathToFileURL(path.join(pkgRoot, "src/persona/global-pack-store.js")).href
  );
  const sourceDir = path.join(sourceRoot, name);
  await writeText(path.join(sourceDir, "pack.yaml"), ["schema: 2", `name: ${name}`, "version: 1.0.0", `description: ${description}`].join("\n") + "\n");
  await writeText(
    path.join(sourceDir, "agents", `${leadName}.md`),
    `---\nname: ${leadName}\nrole: generalist\ndescription: ${leadName}, the ${name} team's generalist lead.\n---\nYou lead the ${name} fixture team used for Pi Persona manual acceptance testing.\n`,
  );
  await writeText(
    path.join(sourceDir, "agents", `${specialistName}.md`),
    `---\nname: ${specialistName}\nrole: specialist\ndescription: ${specialistName}, a ${name} team specialist.\n---\nYou are a specialist on the ${name} fixture team used for Pi Persona manual acceptance testing.\n`,
  );
  await writeText(path.join(sourceDir, "references", "_index.md"), `# ${name}\n\nFixture reference library for the ${name} manual-acceptance team.\n`);
  const source = await readPortablePersonaPack(sourceDir, { type: "path", ref: sourceDir });
  await stageCustomPersonaPackDraft(storeRoot, name, source);
  await applyCustomPersonaPackDraft(storeRoot, name);
}

// ---------------------------------------------------------------------------
// 3. Synthetic legacy workspace, for the /persona migrate walkthrough --
//    a pre-pack-model project with its own top-level .pi/agents/*.md, kept
//    entirely separate from the disposable normal-use WORKSPACE dir.
// ---------------------------------------------------------------------------

async function writeLegacyWorkspace(dir) {
  await writeText(
    path.join(dir, ".pi/agents/coordinator.md"),
    "---\nname: coordinator\nrole: generalist\ndescription: Legacy project coordinator (pre-pack-model fixture).\n---\nYou are the legacy fixture project's coordinator, used to exercise /persona migrate.\n",
  );
  await writeText(
    path.join(dir, ".pi/agents/writer.md"),
    "---\nname: writer\nrole: specialist\ndescription: Legacy project writer (pre-pack-model fixture).\n---\nYou are the legacy fixture project's writer specialist, used to exercise /persona migrate.\n",
  );
  await writeText(
    path.join(dir, "README.md"),
    "# Legacy fixture workspace\n\nSynthetic pre-pack-model Pi Persona project (`.pi/agents/coordinator.md` + `.pi/agents/writer.md`) for exercising `/persona migrate inspect|preview|apply|status|rollback`. Not a real project; safe to mutate/delete and rebuild via build-kit.mjs.\n",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Repo: ${REPO_ROOT}`);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).toString().trim();
  console.log(`Commit: ${commit}${dirty ? " (WARNING: worktree has uncommitted changes)" : " (clean)"}`);
  console.log(`Kit root: ${KIT_ROOT}`);

  if (existsSync(KIT_ROOT)) {
    console.log("Removing existing kit at this path (disposable fixture data) before rebuilding...");
    await rm(KIT_ROOT, { recursive: true, force: true });
  }
  await mkdir(KIT_ROOT, { recursive: true });

  const tarballDir = path.join(KIT_ROOT, "tarballs");
  await mkdir(tarballDir, { recursive: true });

  console.log("\n=== Packing pi-personas + host peers ===");
  const persona = await packPackage(REPO_ROOT, tarballDir);
  const piCodingAgent = await packPackage(path.join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent"), tarballDir);
  const piTui = await packPackage(path.join(REPO_ROOT, "node_modules/@earendil-works/pi-tui"), tarballDir);
  const typebox = await packPackage(path.join(REPO_ROOT, "node_modules/typebox"), tarballDir);
  const yamlPkg = await packPackage(path.join(REPO_ROOT, "node_modules/yaml"), tarballDir);

  console.log("\n=== Installing into a disposable project (offline) ===");
  const projectDir = path.join(KIT_ROOT, "project");
  await mkdir(projectDir, { recursive: true });
  await writeText(path.join(projectDir, "package.json"), JSON.stringify({ name: "pi-persona-manual-acceptance-project", private: true, version: "0.0.0" }, null, 2));
  run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      piCodingAgent.tgzPath,
      piTui.tgzPath,
      typebox.tgzPath,
      yamlPkg.tgzPath,
      persona.tgzPath,
    ],
    { cwd: projectDir },
  );

  const pkgRoot = path.join(projectDir, "node_modules", "pi-personas");
  const piBin = path.join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const extension = path.join(pkgRoot, "extensions", "pi-persona.ts");
  if (!existsSync(piBin)) throw new Error(`installed pi binary missing at ${piBin}`);
  if (!existsSync(extension)) throw new Error(`installed pi-persona extension missing at ${extension}`);
  const installedPiCodingAgentPkg = JSON.parse(await readFile(path.join(projectDir, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));

  console.log("\n=== Seeding isolated agent dir + fixture packs (installed via store, no default) ===");
  const agentDir = path.join(KIT_ROOT, "agent-dir");
  await mkdir(agentDir, { recursive: true });
  const storeRoot = path.join(agentDir, "persona");
  const fixtureSourceRoot = path.join(KIT_ROOT, ".fixture-sources"); // scratch; not part of the kit's tested surface
  await installFixturePack(pkgRoot, storeRoot, fixtureSourceRoot, {
    name: "marketing",
    leadName: "market-lead",
    specialistName: "market-analyst",
    description: "Marketing fixture team for manual acceptance testing.",
  });
  await installFixturePack(pkgRoot, storeRoot, fixtureSourceRoot, {
    name: "philosophy",
    leadName: "philo-lead",
    specialistName: "philo-scout",
    description: "Philosophy fixture team for manual acceptance testing (distinct from the bundled official philosopher-7 catalog pack).",
  });
  await rm(fixtureSourceRoot, { recursive: true, force: true });
  // Deliberately no writeGlobalDefaultPack call: default stays none, so a
  // fresh session starts unbound and team selection must be deliberate.

  console.log("\n=== Writing disposable workspace + synthetic legacy workspace ===");
  const workspaceDir = path.join(KIT_ROOT, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeText(path.join(workspaceDir, "README.md"), "# Disposable workspace\n\nOrdinary cwd for Pi Persona manual acceptance (no pre-existing .pi/agents). Safe to mutate/delete and rebuild via build-kit.mjs.\n");
  const legacyWorkspaceDir = path.join(KIT_ROOT, "legacy-workspace");
  await writeLegacyWorkspace(legacyWorkspaceDir);

  console.log("\n=== Writing launcher + helper scripts ===");
  const binDir = path.join(KIT_ROOT, "bin");
  await mkdir(binDir, { recursive: true });

  const launchSh = `#!/usr/bin/env bash
# Pi Persona manual-acceptance launcher.
# Exact, resolved paths baked in at build time by build-kit.mjs -- nothing
# here depends on the user's real ~/.pi/agent, real npm cache, or any
# checkout-relative import.
#
# Usage:
#   bin/launch.sh workspace [-- <extra pi args>]
#   bin/launch.sh legacy    [-- <extra pi args>]
#   bin/launch.sh <any other dir> [-- <extra pi args>]
#
# Two terminals may run this concurrently: both share PI_CODING_AGENT_DIR
# (same isolated config/store, same installed fixture packs), so
# --session/--session-id/--resume/--continue/--fork all resolve against the
# same session store either way. Pick independent WORKSPACE args
# ("workspace" vs "legacy", or two separate dirs) if you want the two
# terminals to have distinct cwd-scoped state instead.
#
# Offline by default (no credentials are configured, so no model responses
# are possible anyway -- this only additionally suppresses pi's own
# self-update-check network call). For a later authorized pass with real
# credentials configured, run with PI_PERSONA_KIT_OFFLINE=0.
set -euo pipefail

KIT_ROOT="${KIT_ROOT}"
PI_BIN="${piBin}"
EXTENSION="${extension}"
OFFLINE_FLAG=()
if [ "\${PI_PERSONA_KIT_OFFLINE:-1}" != "0" ]; then
  OFFLINE_FLAG=(--offline)
fi

case "\${1:-workspace}" in
  workspace) WORKSPACE="$KIT_ROOT/workspace" ;;
  legacy)    WORKSPACE="$KIT_ROOT/legacy-workspace" ;;
  *)         WORKSPACE="\${1:-$KIT_ROOT/workspace}" ;;
esac
shift || true

export PI_CODING_AGENT_DIR="$KIT_ROOT/agent-dir"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

exec "$PI_BIN" \\
  --extension "$EXTENSION" \\
  --no-skills --no-prompt-templates --no-themes --no-context-files \\
  --approve \\
  "\${OFFLINE_FLAG[@]}" \\
  "$@"
`;
  await writeText(path.join(binDir, "launch.sh"), launchSh);
  await run("chmod", ["+x", path.join(binDir, "launch.sh")]);

  const stageDraftMjs = `#!/usr/bin/env node
// Small helper for the manual fork/edit/preview/apply walkthrough: writes a
// deterministic new specialist agent file into an already-staged draft.
//
// Run "/persona pack edit <draftName>" (after "/persona pack fork <source>
// <draftName>" if starting from a fork, or "/persona pack create
// <draftName>" for a brand-new pack) inside the launched TUI FIRST -- that
// is what actually stages the draft directory this helper writes into; fork
// alone applies immediately and does not by itself leave anything pending
// to preview. Then, without needing to know or type the raw isolated-store
// path yourself:
//
// Usage: node bin/stage-draft-change.mjs <draftName> [agentName]
// Then inside Pi: /persona pack preview <draftName>  (see the new file)
//                  /persona pack apply <draftName>    (confirm to apply)
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const KIT_ROOT = "${KIT_ROOT}";
const draftName = process.argv[2];
const agentName = process.argv[3] ?? "new-specialist";
if (!draftName) {
  console.error("Usage: node bin/stage-draft-change.mjs <draftName> [agentName]");
  process.exit(1);
}

const draftAgentsDir = path.join(KIT_ROOT, "agent-dir", "persona", "drafts", draftName, "agents");
await mkdir(draftAgentsDir, { recursive: true });
const target = path.join(draftAgentsDir, \`\${agentName}.md\`);
await writeFile(
  target,
  \`---\\nname: \${agentName}\\nrole: specialist\\ndescription: \${agentName}, added by stage-draft-change.mjs to demonstrate the fork/edit/preview/apply flow.\\n---\\nYou are \${agentName}, added mid-flight to demonstrate a draft edit before preview/apply.\\n\`,
  "utf8",
);
console.log(\`Wrote \${target}\`);
console.log(\`Next, inside the launched Pi session: /persona pack preview \${draftName}   then   /persona pack apply \${draftName}\`);
`;
  await writeText(path.join(binDir, "stage-draft-change.mjs"), stageDraftMjs);

  const cleanupSh = `#!/usr/bin/env bash
# Removes exactly this kit's directory tree. Nothing outside
# ${KIT_ROOT} is touched (no user ~/.pi/agent, no real npm cache/config).
set -euo pipefail
KIT_ROOT="${KIT_ROOT}"
echo "Removing $KIT_ROOT ..."
rm -rf -- "$KIT_ROOT"
echo "Done."
`;
  await writeText(path.join(binDir, "cleanup.sh"), cleanupSh);
  await run("chmod", ["+x", path.join(binDir, "cleanup.sh")]);

  console.log("\n=== Writing manifest ===");
  const manifest = {
    builtAt: new Date().toISOString(),
    kitRoot: KIT_ROOT,
    sourceRepo: {
      path: REPO_ROOT,
      commit,
      worktreeClean: dirty.length === 0,
    },
    node: process.version,
    globalPiCli: (() => {
      try {
        return execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })(),
    installedPiCodingAgentVersion: installedPiCodingAgentPkg.version,
    piBin,
    extension,
    tarballs: {
      "pi-personas": { path: persona.tgzPath, version: persona.version, sha256: await sha256(persona.tgzPath) },
      "@earendil-works/pi-coding-agent": { path: piCodingAgent.tgzPath, version: piCodingAgent.version, sha256: await sha256(piCodingAgent.tgzPath) },
      "@earendil-works/pi-tui": { path: piTui.tgzPath, version: piTui.version, sha256: await sha256(piTui.tgzPath) },
      typebox: { path: typebox.tgzPath, version: typebox.version, sha256: await sha256(typebox.tgzPath) },
      yaml: { path: yamlPkg.tgzPath, version: yamlPkg.version, sha256: await sha256(yamlPkg.tgzPath) },
    },
    fixturePacks: {
      "custom/marketing": { leadName: "market-lead", specialistName: "market-analyst" },
      "custom/philosophy": { leadName: "philo-lead", specialistName: "philo-scout" },
    },
    officialCatalogAvailable: ["philosopher-7"],
    defaultTeam: null,
  };
  await writeText(path.join(KIT_ROOT, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("\n=== Writing MANUAL-ACCEPTANCE.md ===");
  const template = await readFile(path.join(HERE, "MANUAL-ACCEPTANCE.template.md"), "utf8");
  const filled = template
    .replaceAll("{{KIT_ROOT}}", KIT_ROOT)
    .replaceAll("{{BUILT_AT}}", manifest.builtAt)
    .replaceAll("{{COMMIT}}", commit)
    .replaceAll("{{WORKTREE_CLEAN}}", String(manifest.sourceRepo.worktreeClean))
    .replaceAll("{{PERSONA_VERSION}}", persona.version)
    .replaceAll("{{PERSONA_SHA}}", manifest.tarballs["pi-personas"].sha256)
    .replaceAll("{{PI_CODING_AGENT_VERSION}}", installedPiCodingAgentPkg.version)
    .replaceAll("{{GLOBAL_PI_VERSION}}", String(manifest.globalPiCli))
    .replaceAll("{{EXTENSION_PATH}}", extension)
    .replaceAll("{{PI_BIN_PATH}}", piBin)
    .replaceAll("{{REPO_ROOT}}", REPO_ROOT);
  await writeText(path.join(KIT_ROOT, "MANUAL-ACCEPTANCE.md"), filled);

  console.log("\nKit built at:", KIT_ROOT);
  console.log("Next: node scripts/manual-acceptance/verify-kit.mjs", KIT_ROOT);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
