import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { inspectDocPath } from "./doc-index.js";
import { parseFrontmatterDocument } from "./frontmatter.js";
import { isSafeAgentName, validatePersonaFile } from "./schema.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLED_PACKS = new Map([
  ["philosopher-7", path.join(PACKAGE_ROOT, "packs", "philosopher-7")],
]);
const MANIFEST_FIELDS = ["schema", "name", "version", "description"];
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function listBundledPersonaPacks() {
  const packs = [];
  for (const [name, sourceDir] of BUNDLED_PACKS) {
    packs.push(await readPortablePersonaPack(sourceDir, {
      type: "bundled",
      ref: name,
    }));
  }
  return packs;
}

export async function loadPersonaPackSource(root, target) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("pack install requires a bundled name or explicit local path");
  }

  const input = target.trim();
  if (!isExplicitPath(input)) {
    const sourceDir = BUNDLED_PACKS.get(input);
    if (!sourceDir) {
      throw new Error(`unknown bundled persona pack '${input}'; run /persona pack list`);
    }
    return readPortablePersonaPack(sourceDir, { type: "bundled", ref: input });
  }

  const requested = path.isAbsolute(input) ? input : path.resolve(root, input);
  const sourceDir = await realpath(requested).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`persona pack source not found: ${input}`);
    throw error;
  });
  return readPortablePersonaPack(sourceDir, {
    type: "path",
    ref: portableSourceRef(root, sourceDir),
  });
}

export async function loadRecordedPersonaPackSource(root, name, source) {
  if (source?.type === "bundled") {
    if (source.ref !== name || !BUNDLED_PACKS.has(source.ref)) {
      throw new Error(`recorded bundled source is unavailable for '${name}'`);
    }
    return readPortablePersonaPack(BUNDLED_PACKS.get(source.ref), source);
  }
  if (source?.type === "path" && typeof source.ref === "string") {
    const sourceDir = path.isAbsolute(source.ref)
      ? source.ref
      : path.resolve(root, source.ref);
    return readPortablePersonaPack(sourceDir, source);
  }
  throw new Error(`pack '${name}' has no updateable portable source`);
}

// Stat-only prewalk: totals file count and byte size without reading any
// file's content, so a caller enforcing its own bound (e.g. a private
// snapshot ceiling) can reject an oversized or overcrowded pack before
// readPortablePersonaPack allocates buffers for its content. Mirrors which
// entries readPackContents eventually reads (pack.yaml, configure.md,
// agents/, references/), but does not itself validate schema, reject
// symlinks, or otherwise duplicate readPortablePersonaPack's real read path;
// that validation still happens exactly once, in the real read that follows.
export async function estimatePortablePersonaPackSize(sourceDir) {
  const root = await requireDirectory(sourceDir, "persona pack source");
  let files = 0;
  let bytes = 0;

  for (const fileName of ["pack.yaml", "configure.md"]) {
    const info = await stat(path.join(root, fileName)).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isFile()) {
      files += 1;
      bytes += info.size;
    }
  }

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(absolutePath)).size;
      }
    }
  }
  await visit(path.join(root, "agents"));
  await visit(path.join(root, "references"));

  return { files, bytes };
}

export async function readPortablePersonaPack(sourceDir, provenance) {
  const root = await requireDirectory(sourceDir, "persona pack source");
  // configure.md's requiredness depends on the manifest schema, which isn't
  // parsed yet at this point; it is allowed here (so it isn't flagged as an
  // unexpected entry when present) and its presence is enforced per-schema
  // in readPackContents once the manifest is known.
  await validateRootLayout(root, new Set(["pack.yaml", "agents", "references"]), new Set(["configure.md"]));

  const manifestSource = await readFile(path.join(root, "pack.yaml"), "utf8");
  const manifest = parsePackManifest(manifestSource, path.join(root, "pack.yaml"));
  const source = await readPackContents(root, manifest, { includeManifest: true });

  return {
    ...source,
    root,
    manifest,
    provenance,
  };
}

export async function readPersonaPackDraft(draftDir, name) {
  if (!isSafeAgentName(name)) {
    throw new Error("pack name must begin with a lowercase letter and contain only lowercase letters, numbers, or hyphens");
  }
  const root = await requireDirectory(draftDir, `persona pack draft '${name}'`);
  // Drafts are always schema 1 (project-native authoring predates schema 2),
  // so configure.md stays a required root entry here.
  await validateRootLayout(root, new Set(["configure.md", "agents", "references"]));
  const source = await readPackContents(root, {
    schema: 1,
    name,
    version: null,
    description: `Project-native persona pack ${name}.`,
  }, { includeManifest: false });
  return {
    ...source,
    root,
    manifest: {
      schema: 1,
      name,
      version: null,
      description: `Project-native persona pack ${name}.`,
    },
    provenance: { type: "project" },
  };
}

export function materializePersonaPack(source) {
  const name = source.manifest.name;
  // Temporary boundary: project-local materialization predates pack-scoped
  // baselines and has only one project-wide `.pi/agents/_baseline.md` slot
  // (matched by filename, not path). Copying a pack's `_baseline.md` in would
  // either silently become the whole project's baseline or collide with an
  // existing one, so this path is rejected outright instead of pretending
  // the installation preserved the pack's shared instructions. It is
  // revisited when pack content resolves from its own retained store instead
  // of being copied into a project.
  if (source.manifest.schema === 2 && source.baseline) {
    throw new Error(
      `persona pack '${name}' declares agents/_baseline.md, which project-local materialization does not yet support; remove the pack's baseline before installing it into a project`,
    );
  }
  const files = new Map();
  for (const [sourcePath, content] of source.files) {
    let destination;
    if (sourcePath === "configure.md") {
      destination = `.pi/persona-packs/${name}/configure.md`;
    } else if (sourcePath.startsWith("agents/")) {
      destination = `.pi/agents/packs/${name}/${sourcePath.slice("agents/".length)}`;
    } else if (sourcePath.startsWith("references/")) {
      destination = `.pi/persona-packs/${name}/references/${sourcePath.slice("references/".length)}`;
    } else {
      continue;
    }
    if (files.has(destination)) {
      throw new Error(`persona pack source maps more than one file to ${destination}`);
    }
    files.set(destination, content);
  }
  return files;
}

export function materializePersonaPackLibrarySeeds(source) {
  const name = source.manifest.name;
  const personaNames = new Set(source.personas.map((persona) => persona.name));
  const files = new Map();
  for (const [sourcePath, content] of source.files) {
    if (!sourcePath.startsWith("references/")) continue;
    const suffix = sourcePath.slice("references/".length);
    const [scope, ...rest] = suffix.split("/");
    const destination = scope === "shared"
      ? `library/shared/${name}/${rest.join("/")}`
      : personaNames.has(scope) && rest.length > 0
        ? `library/personal/${scope}/${rest.join("/")}`
        : `library/shared/${name}/${suffix}`;
    if (destination.endsWith("/")) continue;
    if (files.has(destination)) {
      throw new Error(`persona pack source maps more than one seed file to ${destination}`);
    }
    files.set(destination, content);
  }
  return files;
}

export function hashPersonaPackFiles(files) {
  return Object.fromEntries(
    [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, content]) => [filePath, sha256(content)]),
  );
}

export function validateMaterializedPersonaPack(name, files) {
  const agentPrefix = `.pi/agents/packs/${name}/`;
  const packPrefix = `.pi/persona-packs/${name}/`;
  const referencesPrefix = `${packPrefix}references/`;
  const agentFiles = new Map();

  assertMaterializedFileTopology(files);
  const guide = files.get(`${packPrefix}configure.md`);
  if (!guide || !guide.toString("utf8").trim()) {
    throw new Error(`persona pack '${name}' must contain a non-empty configuration guide`);
  }
  for (const [filePath, content] of files) {
    if (filePath.startsWith(agentPrefix)) {
      if (!filePath.endsWith(".md")) {
        throw new Error(`persona pack agent files must use .md: ${filePath}`);
      }
      agentFiles.set(`agents/${filePath.slice(agentPrefix.length)}`, content);
      continue;
    }
    if (filePath === `${packPrefix}configure.md`) continue;
    if (!filePath.startsWith(referencesPrefix)) {
      throw new Error(`file path is outside persona pack '${name}': ${filePath}`);
    }
  }

  if (agentFiles.size === 0) throw new Error(`persona pack '${name}' must contain at least one agent`);
  return validatePackAgents({ name }, agentFiles);
}

function assertMaterializedFileTopology(files) {
  const filePaths = new Set(files.keys());
  for (const filePath of filePaths) {
    let parent = path.posix.dirname(filePath);
    while (parent !== ".") {
      if (filePaths.has(parent)) {
        throw new Error(`persona pack path '${parent}' cannot be both a file and a directory`);
      }
      parent = path.posix.dirname(parent);
    }
  }
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function parsePackManifest(source, filePath) {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${filePath}: ${document.errors[0].message}`);
  }
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath}: pack manifest must be a YAML mapping`);
  }

  const keys = Object.keys(value).sort();
  const expected = [...MANIFEST_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${filePath}: manifest fields must be exactly ${MANIFEST_FIELDS.join(", ")}`);
  }
  if (value.schema !== 1 && value.schema !== 2) {
    throw new Error(`${filePath}: unsupported pack schema '${value.schema}'`);
  }
  if (!isSafeAgentName(value.name)) {
    throw new Error(`${filePath}: name must begin with a lowercase letter and contain only lowercase letters, numbers, or hyphens`);
  }
  parseStableVersion(value.version);
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error(`${filePath}: description must be a non-empty string`);
  }
  return {
    schema: value.schema,
    name: value.name,
    version: value.version,
    description: value.description.trim(),
  };
}

async function readPackContents(root, manifest, options) {
  const configurePath = path.join(root, "configure.md");
  // Schema 1 requires configure.md as mandatory, non-empty adaptation
  // guidance. Schema 2 makes it fully optional — a pack may ship no
  // configuration step at all — so a missing file is only an error under
  // schema 1.
  const configure = await readFile(configurePath).catch((error) => {
    if (error?.code === "ENOENT" && manifest.schema !== 1) return null;
    if (error?.code === "ENOENT") throw new Error(`${root}: missing required configure.md`);
    throw error;
  });
  if (manifest.schema === 1 && !configure.toString("utf8").trim()) {
    throw new Error(`${configurePath}: configuration guide must not be empty`);
  }

  const agentTree = await readTree(path.join(root, "agents"), "agents");
  const referencesTree = await readTree(path.join(root, "references"), "references");
  if (agentTree.files.size === 0) throw new Error(`${root}: persona pack must contain at least one agent`);
  for (const filePath of agentTree.files.keys()) {
    if (!filePath.endsWith(".md")) {
      throw new Error(`${root}: agents may contain only Markdown files (${filePath})`);
    }
  }

  const files = new Map([
    ...(configure !== null ? [["configure.md", configure]] : []),
    ...agentTree.files,
    ...referencesTree.files,
  ]);
  if (options.includeManifest) {
    files.set("pack.yaml", await readFile(path.join(root, "pack.yaml")));
  }

  const { personas, baseline } = manifest.schema === 2
    ? await validatePackAgentsV2(root, manifest, agentTree.files)
    : { personas: validatePackAgents(manifest, agentTree.files), baseline: null };
  const integrity = hashSourceFiles(files);
  if (options.includeManifest) files.delete("pack.yaml");

  return {
    files,
    personas,
    baseline,
    integrity,
  };
}

function validatePackAgents(manifest, agentFiles) {
  const personas = [];
  const names = new Map();

  for (const [sourcePath, content] of agentFiles) {
    const fileName = path.posix.basename(sourcePath);
    if (fileName.startsWith("_")) {
      throw new Error(`${sourcePath}: persona packs cannot contain control agent files`);
    }
    const parsed = parseFrontmatterDocument(content.toString("utf8"), sourcePath);
    const file = {
      relativePath: sourcePath,
      fileName,
      isControl: false,
      frontmatter: parsed.frontmatter,
      rawFrontmatter: parsed.rawFrontmatter,
      parseErrors: parsed.errors,
    };
    const errors = parsed.errors.length > 0
      ? parsed.errors
      : validatePersonaFile(file)
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    const role = parsed.frontmatter.role ?? "specialist";
    if (!["generalist", "specialist"].includes(role)) {
      throw new Error(`${sourcePath}: pack personas must use role: generalist or specialist`);
    }
    if (role === "generalist" && parsed.frontmatter.primary === true) {
      throw new Error(`${sourcePath}: pack generalist cannot be a project-wide primary`);
    }
    if (role === "specialist" && Object.hasOwn(parsed.rawFrontmatter, "primary")) {
      throw new Error(`${sourcePath}: pack specialists cannot declare primary`);
    }

    const name = parsed.frontmatter.name;
    if (names.has(name)) {
      throw new Error(`duplicate persona name '${name}' in ${names.get(name)} and ${sourcePath}`);
    }
    names.set(name, sourcePath);

    const personalLibrary = `library/personal/${name}/`;
    const sharedPackLibrary = `library/shared/${manifest.name}/`;
    if (!(parsed.frontmatter.docs ?? []).includes(personalLibrary)) {
      throw new Error(`${sourcePath}: pack persona must declare its personal library: ${personalLibrary}`);
    }
    if (!(parsed.frontmatter.docs ?? []).includes(sharedPackLibrary)) {
      throw new Error(`${sourcePath}: pack persona must declare its pack-shared library: ${sharedPackLibrary}`);
    }
    for (const docPath of parsed.frontmatter.docs ?? []) {
      if (docPath === personalLibrary || docPath === sharedPackLibrary) continue;
      throw new Error(`${sourcePath}: docs may use only ${personalLibrary} and ${sharedPackLibrary}`);
    }

    personas.push({
      name,
      role,
      description: parsed.frontmatter.description,
      docs: parsed.frontmatter.docs ?? [],
      sourcePath,
    });
  }

  const generalists = personas.filter((persona) => persona.role === "generalist");
  const specialists = personas.filter((persona) => persona.role === "specialist");
  if (generalists.length !== 1) {
    throw new Error(`persona pack '${manifest.name}' must contain exactly one generalist; found ${generalists.length}`);
  }
  if (specialists.length === 0) {
    throw new Error(`persona pack '${manifest.name}' must contain at least one specialist`);
  }
  return personas.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Schema 2 persona validation. Unlike schema 1, `agents/_baseline.md` is
 * allowed as optional shared instructions (excluded from the roster, never a
 * role), and each persona may declare `packDocs` (pack-relative references,
 * file or directory, resolved against the pack's own `references/` root)
 * instead of mandatory workspace-relative `docs`. `packDocs` itself is
 * optional — omitted or empty is valid. `docs` keeps its schema-1
 * workspace-relative meaning and stays optional extra context.
 */
async function validatePackAgentsV2(root, manifest, agentFiles) {
  const personas = [];
  const names = new Map();
  let baseline = null;

  for (const [sourcePath, content] of agentFiles) {
    const fileName = path.posix.basename(sourcePath);
    const parsed = parseFrontmatterDocument(content.toString("utf8"), sourcePath);

    if (fileName === "_baseline.md") {
      if (baseline) {
        throw new Error(`persona pack '${manifest.name}' declares more than one _baseline.md`);
      }
      baseline = validatePackControlFile(sourcePath, parsed);
      continue;
    }
    if (fileName.startsWith("_")) {
      throw new Error(`${sourcePath}: only _baseline.md may be a control agent file in a schema 2 pack`);
    }

    const file = {
      relativePath: sourcePath,
      fileName,
      isControl: false,
      frontmatter: parsed.frontmatter,
      rawFrontmatter: parsed.rawFrontmatter,
      parseErrors: parsed.errors,
    };
    const errors = parsed.errors.length > 0
      ? parsed.errors
      : validatePersonaFile(file)
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    const role = parsed.frontmatter.role ?? "specialist";
    if (!["generalist", "specialist"].includes(role)) {
      throw new Error(`${sourcePath}: pack personas must use role: generalist or specialist`);
    }
    if (role === "generalist" && parsed.frontmatter.primary === true) {
      throw new Error(`${sourcePath}: pack generalist cannot be a project-wide primary`);
    }
    if (role === "specialist" && Object.hasOwn(parsed.rawFrontmatter, "primary")) {
      throw new Error(`${sourcePath}: pack specialists cannot declare primary`);
    }

    const name = parsed.frontmatter.name;
    if (names.has(name)) {
      throw new Error(`duplicate persona name '${name}' in ${names.get(name)} and ${sourcePath}`);
    }
    names.set(name, sourcePath);

    // packDocs is optional: a persona may declare none, or any of the pack's
    // own content (another specialist's notes, a nested path, a single
    // file), as long as it stays inside the pack's reference root. That
    // containment (checked below) is the real boundary, not a mandatory
    // minimum or an allowlist of exact paths — restricting which or how many
    // of its own files a persona may read would handcuff useful
    // cross-references without protecting any actual trust or data boundary.
    const packDocs = parsed.frontmatter.packDocs ?? [];
    for (const ref of packDocs) {
      const inspection = await inspectDocPath(path.join(root, "references"), ref);
      if (!inspection.ok || (inspection.type !== "directory" && inspection.type !== "file")) {
        throw new Error(`${sourcePath}: packDocs reference not found: ${ref}`);
      }
    }

    personas.push({
      name,
      role,
      description: parsed.frontmatter.description,
      docs: parsed.frontmatter.docs ?? [],
      packDocs,
      sourcePath,
    });
  }

  const generalists = personas.filter((persona) => persona.role === "generalist");
  const specialists = personas.filter((persona) => persona.role === "specialist");
  if (generalists.length !== 1) {
    throw new Error(`persona pack '${manifest.name}' must contain exactly one generalist; found ${generalists.length}`);
  }
  if (specialists.length === 0) {
    throw new Error(`persona pack '${manifest.name}' must contain at least one specialist`);
  }

  return {
    personas: personas.sort((left, right) => left.name.localeCompare(right.name)),
    baseline,
  };
}

function validatePackControlFile(sourcePath, parsed) {
  const file = {
    relativePath: sourcePath,
    fileName: path.posix.basename(sourcePath),
    isControl: true,
    frontmatter: parsed.frontmatter,
    rawFrontmatter: parsed.rawFrontmatter,
    parseErrors: parsed.errors,
  };
  const errors = parsed.errors.length > 0
    ? parsed.errors
    : validatePersonaFile(file)
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { relativePath: sourcePath, frontmatter: parsed.frontmatter, body: parsed.body };
}

async function validateRootLayout(root, required, optional = new Set()) {
  const allowed = new Set([...required, ...optional]);
  const entries = await readdir(root, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  for (const requiredName of required) {
    if (!names.has(requiredName)) throw new Error(`${root}: missing required ${requiredName}`);
  }
  for (const entry of entries) {
    if (!allowed.has(entry.name)) {
      throw new Error(`${root}: unexpected source entry '${entry.name}'`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`${root}: symbolic links are not allowed in persona pack sources`);
    }
  }
  for (const directory of ["agents", "references"]) {
    if (!entries.find((entry) => entry.name === directory)?.isDirectory()) {
      throw new Error(`${root}: ${directory} must be a directory`);
    }
  }
  for (const fileName of [...allowed].filter((name) => !["agents", "references"].includes(name))) {
    const entry = entries.find((candidate) => candidate.name === fileName);
    if (entry && !entry.isFile()) {
      throw new Error(`${root}: ${fileName} must be a file`);
    }
  }
}

async function readTree(root, prefix) {
  const files = new Map();
  const directories = new Set([prefix]);

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.name.includes("\\")) {
        throw new Error(`${absolutePath}: backslashes are not allowed in portable persona pack paths`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`${absolutePath}: symbolic links are not allowed in persona pack sources`);
      }
      if (entry.isDirectory()) {
        directories.add(relativePath);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.set(relativePath, await readFile(absolutePath));
      } else {
        throw new Error(`${absolutePath}: unsupported filesystem entry`);
      }
    }
  }

  await visit(root, prefix);
  return { files, directories };
}

async function requireDirectory(input, label) {
  const root = path.resolve(input);
  const details = await stat(root).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} not found: ${input}`);
    throw error;
  });
  if (!details.isDirectory()) throw new Error(`${label} is not a directory: ${input}`);
  return root;
}

function hashSourceFiles(files) {
  const hash = createHash("sha256");
  for (const [filePath, content] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(filePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function parseStableVersion(version) {
  if (typeof version !== "string" || !STABLE_SEMVER.test(version)) {
    throw new Error(`pack version must be a stable semantic version (received '${version}')`);
  }
  return version.split(".").map((part) => BigInt(part));
}

function isExplicitPath(value) {
  return path.isAbsolute(value)
    || value.startsWith(".")
    || value.includes("/")
    || value.includes("\\");
}

function portableSourceRef(root, sourceDir) {
  const relative = path.relative(path.resolve(root), sourceDir);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `./${relative.split(path.sep).join("/")}`;
  }
  return sourceDir;
}
