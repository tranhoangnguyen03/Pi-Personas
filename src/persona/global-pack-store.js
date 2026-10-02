/**
 * Global official/custom persona pack store — pure filesystem operations.
 *
 * Every function takes an explicit `storeRoot`; nothing here calls Pi's
 * `getAgentDir()`. The extension boundary resolves the real root (normally
 * `path.join(getAgentDir(), "persona")`, honoring Pi's `PI_CODING_AGENT_DIR`
 * override through `getAgentDir()` itself) and passes it in. That wiring is
 * not part of this task: no live command calls these functions yet.
 *
 * Layout:
 *   <storeRoot>/official/<name>/        installed official pack (self-contained)
 *   <storeRoot>/official/<name>.meta.json   install provenance + base hash
 *   <storeRoot>/custom/<name>/          installed custom pack (self-contained)
 *   <storeRoot>/custom/<name>.meta.json     fork provenance (optional)
 *   <storeRoot>/drafts/<name>/          inactive custom draft, never listed/discoverable
 *
 * Catalog loading (`loadPersonaPackSource`, `readPortablePersonaPack`) stays
 * owned by pack-source.js; callers load a `source` there and hand it to the
 * install/update/create functions here. That mirrors the design doc's
 * responsibility split: catalog/source acquisition is not store ownership.
 */
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";

import { readPortablePersonaPack } from "./pack-source.js";
import { isSafeAgentName } from "./schema.js";

const KINDS = ["official", "custom"];
const MUTATION_LOCK_FILENAME = ".mutation.lock";

// Injectable seam over the handful of fs operations the recovery-sensitive
// paths below need to fail deterministically in tests (a torn swap-in
// rename, a rollback that itself fails, a lock write that fails after the
// lock file was created, a directory that vanishes mid-listing). Not a
// mocking framework: just an overridable indirection, restored in `finally`.
const defaultFsHooks = { rename, open, writeFile, readdir };
const activeFsHooks = { ...defaultFsHooks };

export async function __withFsHookForTesting(overrides, run) {
  const previous = { ...activeFsHooks };
  Object.assign(activeFsHooks, overrides);
  try {
    return await run();
  } finally {
    Object.assign(activeFsHooks, previous);
  }
}

export async function listGlobalPersonaPacks(storeRoot) {
  const official = await listKind(storeRoot, "official");
  const custom = await listKind(storeRoot, "custom");
  return { official, custom };
}

export async function installOfficialPersonaPack(storeRoot, source) {
  assertOfficialSource(source);
  const name = source.manifest.name;
  return withStoreMutationLock(storeRoot, async () => {
    const targetDir = officialDir(storeRoot, name);
    if (await pathExists(targetDir)) {
      throw new Error(`persona pack 'official/${name}' is already installed; use updateOfficialPersonaPack to replace it`);
    }
    await replacePersonaPackDirectory(
      storeRoot,
      targetDir,
      await collectPackFiles(source),
      () => writeJsonAtomically(metaFilePath(storeRoot, "official", name), officialMeta(source)),
    );
    return { qualifiedName: `official/${name}`, version: source.manifest.version };
  });
}

export async function updateOfficialPersonaPack(storeRoot, source, options = {}) {
  assertOfficialSource(source);
  const name = source.manifest.name;
  return withStoreMutationLock(storeRoot, async () => {
    const targetDir = officialDir(storeRoot, name);
    if (!await pathExists(targetDir)) {
      throw new Error(`persona pack 'official/${name}' is not installed; use installOfficialPersonaPack first`);
    }
    const meta = await readMeta(metaFilePath(storeRoot, "official", name));
    if (!meta) {
      throw new Error(`persona pack 'official/${name}' is missing installation metadata; uninstall and reinstall it`);
    }
    const current = await readPortablePersonaPack(targetDir, { type: "installed", ref: `official/${name}` });
    const edited = current.integrity !== meta.baseHash;
    // Re-verify a caller's own preview/plan against this freshly-read state,
    // still inside the mutation lock, before deciding anything destructive:
    // the only trustworthy moment to catch "the installed pack changed since
    // it was previewed" is right here, not in a separate read the caller did
    // before acquiring this lock.
    if (options.verifyBeforeApply) {
      await options.verifyBeforeApply({ integrity: current.integrity, edited });
    }
    if (edited && options.discardLocalEdits !== true) {
      throw new Error(
        `persona pack 'official/${name}' has local edits not present in the recorded install; `
        + "fork it to keep those edits (forkPersonaPack), or pass { discardLocalEdits: true } to replace them",
      );
    }
    await replacePersonaPackDirectory(
      storeRoot,
      targetDir,
      await collectPackFiles(source),
      () => writeJsonAtomically(metaFilePath(storeRoot, "official", name), officialMeta(source)),
    );
    return { qualifiedName: `official/${name}`, version: source.manifest.version, discardedLocalEdits: edited };
  });
}

export async function uninstallOfficialPersonaPack(storeRoot, name, options = {}) {
  assertPackName(name);
  return withStoreMutationLock(storeRoot, async () => {
    const targetDir = officialDir(storeRoot, name);
    if (options.verifyBeforeRemove) {
      if (!await pathExists(targetDir)) {
        throw new Error(`persona pack 'official/${name}' is not installed`);
      }
      const current = await readPortablePersonaPack(targetDir, { type: "installed", ref: `official/${name}` });
      await options.verifyBeforeRemove({ integrity: current.integrity });
    }
    const removed = await removePersonaPackDirectory(storeRoot, targetDir);
    if (!removed) throw new Error(`persona pack 'official/${name}' is not installed`);
    await rm(metaFilePath(storeRoot, "official", name), { force: true });
    // Runs inside this same lock, after removal has actually landed: a
    // caller (pack-lifecycle.js) uses this to clear a matching global
    // default atomically with the removal, so a concurrent default change
    // can never be silently clobbered by a decision made before the lock
    // was acquired.
    if (options.afterRemove) await options.afterRemove();
    return { qualifiedName: `official/${name}`, deleted: true };
  });
}

export async function forkPersonaPack(storeRoot, qualifiedSourceName, newName) {
  const { kind, name } = splitQualifiedName(qualifiedSourceName);
  assertPackName(newName);
  return withStoreMutationLock(storeRoot, async () => {
    const sourceDir = kindDir(storeRoot, kind, name);
    if (!await pathExists(sourceDir)) {
      throw new Error(`persona pack '${qualifiedSourceName}' is not installed`);
    }
    const targetDir = customDir(storeRoot, newName);
    if (await pathExists(targetDir)) {
      throw new Error(`persona pack 'custom/${newName}' already exists`);
    }
    const source = await readPortablePersonaPack(sourceDir, { type: "installed", ref: qualifiedSourceName });
    const files = await collectPackFiles(source);
    if (newName !== source.manifest.name) {
      files.set("pack.yaml", renamePackManifest(files.get("pack.yaml"), newName));
    }
    await replacePersonaPackDirectory(
      storeRoot,
      targetDir,
      files,
      () => writeJsonAtomically(metaFilePath(storeRoot, "custom", newName), {
        forkedFrom: qualifiedSourceName,
        forkedFromVersion: source.manifest.version,
        forkedAt: new Date().toISOString(),
      }),
    );
    return { qualifiedName: `custom/${newName}`, forkedFrom: qualifiedSourceName };
  });
}

// Create and edit both flow through the same inactive-draft mechanism: stage
// writes an already-validated `source` (e.g. from readPortablePersonaPack)
// to drafts/<name>/ verbatim — staging itself performs no independent
// schema validation beyond checking the source's own declared identity
// matches the name it is staged under. preview/cancel touch only the draft.
// apply is where validation is mandatory: it re-reads the draft through
// readPortablePersonaPack (guarding against tampering or corruption between
// staging and applying) before replacing custom/<name> (creating it if this
// is the first apply for that name). A draft is never listed or discoverable
// until applied.
export async function stageCustomPersonaPackDraft(storeRoot, name, source) {
  assertPackName(name);
  if (source.manifest.name !== name) {
    throw new Error(`persona pack draft name mismatch: staging as '${name}' but the source manifest declares '${source.manifest.name}'`);
  }
  return withStoreMutationLock(storeRoot, async () => {
    await replacePersonaPackDirectory(storeRoot, draftDir(storeRoot, name), await collectPackFiles(source));
    return { name, staged: true };
  });
}

export async function previewCustomPersonaPackDraft(storeRoot, name) {
  assertPackName(name);
  const pendingDraftDir = draftDir(storeRoot, name);
  if (!await pathExists(pendingDraftDir)) {
    throw new Error(`no pending draft for custom pack '${name}'`);
  }
  const draftSource = await readPortablePersonaPack(pendingDraftDir, { type: "draft", ref: name });
  const activeDir = customDir(storeRoot, name);
  const activeExists = await pathExists(activeDir);
  // A brand-new pack has no active content to diff against; reporting every
  // file as "added" (instead of a null diff) keeps the preview shape
  // uniform, so callers don't need an isNew-only branch just to see what a
  // new pack contains.
  const activeSource = activeExists
    ? await readPortablePersonaPack(activeDir, { type: "installed", ref: `custom/${name}` })
    : null;
  const activeFiles = activeSource ? await collectPackFiles(activeSource) : new Map();
  const diff = diffPackFiles(activeFiles, await collectPackFiles(draftSource));
  return {
    name,
    personas: draftSource.personas.map((persona) => ({ name: persona.name, role: persona.role })),
    isNew: !activeExists,
    diff,
    // Snapshot of the active content's integrity at preview time, so a
    // caller that must not silently overwrite an edit made after preview
    // (e.g. persona migration's apply) can pass it back to
    // applyCustomPersonaPackDraft's `verifyBeforeApply` and have that
    // freshness re-checked inside the store's own mutation lock, right
    // before the swap -- not as a second, separately racy check of its own.
    activeIntegrity: activeSource ? activeSource.integrity : null,
    // Companion to activeIntegrity, for the same reason: a caller building a
    // deterministic plan token (pack-lifecycle.js) needs the draft's own
    // freshness captured too, so a draft edited between preview and apply is
    // caught by the same re-verification, not just active-content drift.
    draftIntegrity: draftSource.integrity,
  };
}

export async function cancelCustomPersonaPackDraft(storeRoot, name) {
  assertPackName(name);
  return withStoreMutationLock(storeRoot, async () => {
    await rm(draftDir(storeRoot, name), { recursive: true, force: true });
    return { name, cancelled: true };
  });
}

export async function applyCustomPersonaPackDraft(storeRoot, name, options = {}) {
  assertPackName(name);
  return withStoreMutationLock(storeRoot, async () => {
    const pendingDraftDir = draftDir(storeRoot, name);
    if (!await pathExists(pendingDraftDir)) {
      throw new Error(`no pending draft for custom pack '${name}'`);
    }
    // Re-validate: guards against the draft being tampered with, or left
    // malformed, between staging and applying.
    const draftSource = await readPortablePersonaPack(pendingDraftDir, { type: "draft", ref: name });
    const targetDir = customDir(storeRoot, name);
    // Optional hook, run inside this same mutation lock right before the
    // swap: lets a caller that captured expectations at preview time (e.g.
    // persona migration) refuse to overwrite active content that was
    // created or edited after that preview, instead of trusting whatever
    // stale fact it observed outside the lock. Ordinary custom-pack
    // create/edit does not pass this, so its behavior is unchanged.
    if (options.verifyBeforeApply) {
      const activeExists = await pathExists(targetDir);
      const activeIntegrity = activeExists
        ? (await readPortablePersonaPack(targetDir, { type: "installed", ref: `custom/${name}` })).integrity
        : null;
      await options.verifyBeforeApply({ activeExists, activeIntegrity, draftIntegrity: draftSource.integrity });
    }
    await replacePersonaPackDirectory(storeRoot, targetDir, await collectPackFiles(draftSource));
    await rm(pendingDraftDir, { recursive: true, force: true });
    return { qualifiedName: `custom/${name}`, version: draftSource.manifest.version };
  });
}

export async function deleteCustomPersonaPack(storeRoot, name, options = {}) {
  assertPackName(name);
  return withStoreMutationLock(storeRoot, async () => {
    const targetDir = customDir(storeRoot, name);
    if (options.verifyBeforeRemove) {
      if (!await pathExists(targetDir)) {
        throw new Error(`persona pack 'custom/${name}' is not installed`);
      }
      const current = await readPortablePersonaPack(targetDir, { type: "installed", ref: `custom/${name}` });
      await options.verifyBeforeRemove({ integrity: current.integrity });
    }
    const removed = await removePersonaPackDirectory(storeRoot, targetDir);
    if (!removed) throw new Error(`persona pack 'custom/${name}' is not installed`);
    await rm(metaFilePath(storeRoot, "custom", name), { force: true });
    if (options.afterRemove) await options.afterRemove();
    return { qualifiedName: `custom/${name}`, deleted: true };
  });
}

// ---- internals ----

function assertPackName(name) {
  if (!isSafeAgentName(name)) {
    throw new Error(`persona pack name must begin with a lowercase letter and contain only lowercase letters, numbers, or hyphens (received '${name}')`);
  }
}

function assertOfficialSource(source) {
  if (!source || source.provenance?.type !== "bundled") {
    throw new Error("official packs can only be installed or updated from the bundled catalog");
  }
}

function splitQualifiedName(qualifiedName) {
  const parts = String(qualifiedName).split("/");
  const [kind, name] = parts;
  if (parts.length !== 2 || !KINDS.includes(kind) || !name) {
    throw new Error(`qualified persona pack identity must be 'official/<name>' or 'custom/<name>' (received '${qualifiedName}')`);
  }
  assertPackName(name);
  return { kind, name };
}

function officialDir(storeRoot, name) {
  return kindDir(storeRoot, "official", name);
}

function customDir(storeRoot, name) {
  return kindDir(storeRoot, "custom", name);
}

function draftDir(storeRoot, name) {
  return path.join(storeRoot, "drafts", name);
}

function kindDir(storeRoot, kind, name) {
  return path.join(storeRoot, kind, name);
}

function metaFilePath(storeRoot, kind, name) {
  return path.join(storeRoot, kind, `${name}.meta.json`);
}

function officialMeta(source) {
  return {
    source: source.provenance,
    baseHash: source.integrity,
    version: source.manifest.version,
    installedAt: new Date().toISOString(),
  };
}

async function collectPackFiles(source) {
  const files = new Map(source.files);
  // readPortablePersonaPack folds pack.yaml into the integrity hash but
  // strips it from the returned file map; read it back so the store keeps a
  // self-contained pack (pack.yaml, agents/, references/, configure.md).
  files.set("pack.yaml", await readFile(path.join(source.root, "pack.yaml")));
  return files;
}

// Forking under a different name must rewrite the manifest's declared
// identity so the on-disk pack.yaml matches its new directory, not just the
// qualified name the store returns. Done through the same YAML library used
// to parse it (parseDocument + set), not a hand-rolled regex, so punctuation
// or formatting elsewhere in the manifest cannot be corrupted by the rename.
function renamePackManifest(manifestBuffer, newName) {
  const document = parseDocument(manifestBuffer.toString("utf8"), { prettyErrors: false, uniqueKeys: true });
  document.set("name", newName);
  return Buffer.from(String(document), "utf8");
}

function diffPackFiles(activeFiles, draftFiles) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [filePath, content] of draftFiles) {
    if (!activeFiles.has(filePath)) added.push(filePath);
    else if (!activeFiles.get(filePath).equals(content)) changed.push(filePath);
  }
  for (const filePath of activeFiles.keys()) {
    if (!draftFiles.has(filePath)) removed.push(filePath);
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

async function listKind(storeRoot, kind) {
  const kindRoot = path.join(storeRoot, kind);
  if (!await pathExists(kindRoot)) return [];
  const entries = await activeFsHooks.readdir(kindRoot, { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue; // skip *.meta.json sidecars
    const name = entry.name;
    // listing takes no lock (readers stay lock-free by design; see
    // withStoreMutationLock), so a concurrent replace can rename this
    // directory away between the readdir above and the read below. Rather
    // than surface that as a raw, confusing ENOENT deep in pack-source
    // parsing (or worse, silently skip the entry and return a partial,
    // incoherent list), report it as an explicit, retryable condition.
    let source;
    try {
      source = await readPortablePersonaPack(kindDir(storeRoot, kind, name), { type: "installed", ref: `${kind}/${name}` });
    } catch (error) {
      // pack-source.js's requireDirectory converts a missing directory into
      // a plain Error without a .code, so detect the race by re-checking
      // existence rather than matching an error shape: if the directory is
      // gone now, this was a concurrent removal/replace, not a genuinely
      // invalid pack, and a real validation error must still surface as-is.
      if (!await pathExists(kindDir(storeRoot, kind, name))) {
        throw new Error(`persona pack store is busy: '${kind}/${name}' changed while listing; retry the listing`);
      }
      throw error;
    }
    const meta = await readMeta(metaFilePath(storeRoot, kind, name));
    results.push({
      qualifiedName: `${kind}/${name}`,
      kind,
      name,
      manifest: source.manifest,
      personas: source.personas.map((persona) => ({ name: persona.name, role: persona.role })),
      hasBaseline: Boolean(source.baseline),
      integrity: source.integrity,
      meta,
      edited: kind === "official" && meta ? meta.baseHash !== source.integrity : false,
    });
  }
  return results;
}

// Recoverable staged replacement, not a claimed single atomic operation: the
// new content is fully written to a temp staging directory first, then
// swapped in with two renames (old target -> backup, staging -> target). If
// either rename fails, the backup is renamed back before the error
// propagates. There is a brief window between the two renames where the
// target does not exist; avoiding even that would need platform-specific
// tricks this store does not attempt.
//
// `afterSwap`, when given, runs after the content swap-in succeeds — this is
// where callers write the pack's `.meta.json` sidecar. If it throws, the
// content swap is rolled back through the exact same backup-restore path
// used for a failed swap-in rename, so content and metadata can never land
// in a state where one describes a version the other doesn't: either both
// the new content and new metadata land, or the target is left exactly as
// it was before the call (old content + old metadata, or nothing at all for
// a fresh install). If that rollback itself fails, the pre-replacement
// content is preserved on disk (never deleted) and its exact path is
// reported, matching the swap-in-failure recovery path below.
async function replacePersonaPackDirectory(storeRoot, targetDir, files, afterSwap) {
  await mkdir(storeRoot, { recursive: true });
  const relativeTarget = path.relative(storeRoot, targetDir);
  await assertNoSymlinkEscape(storeRoot, relativeTarget);
  await mkdir(path.dirname(targetDir), { recursive: true });

  const staging = await mkdtemp(path.join(storeRoot, ".pack-stage-"));
  for (const [relativePath, content] of files) {
    const destination = path.join(staging, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }

  const backupParent = await mkdtemp(path.join(storeRoot, ".pack-backup-"));
  const backupTarget = path.join(backupParent, "previous");
  const hadExisting = await pathExists(targetDir);

  if (hadExisting) {
    try {
      await activeFsHooks.rename(targetDir, backupTarget);
    } catch (error) {
      // Nothing moved yet: the original is still exactly where it was.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await rm(backupParent, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // Shared recovery for both a failed swap-in rename and a failed afterSwap
  // step: clear whatever is currently at targetDir (nothing, for a failed
  // swap-in; the just-landed new content, for a failed afterSwap) and
  // restore the backup, if any existed. Always throws: `error` if recovery
  // succeeded, or a wrapped error naming the preserved backup path if the
  // recovery rename itself failed.
  async function recoverAndThrow(stage, error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    if (hadExisting) {
      try {
        await activeFsHooks.rename(backupTarget, targetDir);
      } catch (rollbackError) {
        // The rollback rename itself failed: the previous content is still
        // sitting at backupTarget and nowhere else. Deleting backupParent
        // here (as a prior version of this code did, unconditionally) would
        // destroy the only remaining copy, so it is preserved on disk and
        // its exact path is reported so it can be restored by hand.
        const recoveryError = new Error(
          `persona pack store ${stage} for ${targetDir} failed (${error.message}) and automatic `
          + `rollback also failed (${rollbackError.message}); the previous content was preserved at `
          + `${backupTarget} — move it back to ${targetDir} manually to recover it`,
        );
        recoveryError.cause = error;
        recoveryError.backupPath = backupTarget;
        throw recoveryError;
      }
    }
    await rm(backupParent, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  try {
    await activeFsHooks.rename(staging, targetDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await recoverAndThrow("replacement swap-in", error);
  }

  if (afterSwap) {
    try {
      await afterSwap();
    } catch (error) {
      await recoverAndThrow("metadata write", error);
    }
  }

  await rm(backupParent, { recursive: true, force: true });
}

async function removePersonaPackDirectory(storeRoot, targetDir) {
  if (!await pathExists(targetDir)) return false;
  const relativeTarget = path.relative(storeRoot, targetDir);
  await assertNoSymlinkEscape(storeRoot, relativeTarget);
  const backupParent = await mkdtemp(path.join(storeRoot, ".pack-backup-"));
  const backupTarget = path.join(backupParent, "previous");
  try {
    await rename(targetDir, backupTarget);
  } catch (error) {
    await rm(backupParent, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // Best-effort cleanup only: if this fails, the pack is still correctly
  // gone from official/custom (removal already succeeded); a temp backup
  // directory is left behind rather than a persistent archive.
  await rm(backupParent, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function readMeta(metaPath) {
  try {
    return JSON.parse(await readFile(metaPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await activeFsHooks.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await activeFsHooks.rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// Duplicated from pack-lifecycle.js's project-scoped assertPathComponentsNotSymlinks
// (which is hardcoded to a project root + ".pi" paths) rather than imported,
// since the global store root has no ".pi" concept. Transitional: fold into
// one shared helper if/when the project-local lifecycle is retired.
//
// Exported (in addition to being used internally by this module) so
// pack-session.js can validate containment/symlink-escape for the store
// paths it reads and the runtime-sessions directory it writes into, without
// a second hand-rolled copy of this same check.
export async function assertNoSymlinkEscape(storeRoot, relativePath) {
  const root = path.resolve(storeRoot);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`persona pack store path must stay inside the store root: ${relativePath}`);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`symbolic links are not supported in the persona pack store: ${path.relative(root, current).split(path.sep).join("/")}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

// ponytail: one store-wide writer, same precedent as pack-lifecycle.js's
// withMutationLock; revisit only if parallel global-store mutations become a
// real need. Exported (as withPersonaPackStoreLock) so pack-session.js's
// writeGlobalDefaultPack can serialize against the same lock: without that,
// setting/clearing the default and installing/removing a pack could
// interleave arbitrarily, letting a removal's default-clearing step clobber
// a default written concurrently by an unrelated /persona team default call.
export async function withStoreMutationLock(storeRoot, operation) {
  await mkdir(storeRoot, { recursive: true });
  await assertNoSymlinkEscape(storeRoot, MUTATION_LOCK_FILENAME);
  const lockFile = path.join(storeRoot, MUTATION_LOCK_FILENAME);
  try {
    return await withLockFile(lockFile, operation);
  } catch (error) {
    // A process killed mid-mutation leaves its lock behind. Store operations
    // take milliseconds, so a lock whose recorded owner is gone is stale:
    // clear it once and retry. Anything uncertain keeps the error.
    if (error?.code !== "PERSONA_STORE_LOCKED" || !await clearStaleLock(lockFile)) throw error;
    return withLockFile(lockFile, operation);
  }
}

async function clearStaleLock(lockFile) {
  const ownerIsGone = async () => {
    let pid;
    try {
      pid = JSON.parse(await readFile(lockFile, "utf8"))?.pid;
    } catch {
      return false;
    }
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  };
  // ponytail: check-then-remove; a second process could take the lock in
  // between. Needs a crash plus two simultaneous store writes; use an
  // atomic rename-claim if that ever matters.
  if (!await ownerIsGone()) return false;
  await rm(lockFile, { force: true });
  return true;
}

async function withLockFile(lockFile, operation) {
  let handle;
  let lockFileCreated = false;
  try {
    handle = await activeFsHooks.open(lockFile, "wx");
    lockFileCreated = true;
    await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8");
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    // The exclusive create can succeed and a later step (the write, the
    // close) can still fail; in that case the lock file exists on disk even
    // though this function is about to throw, and it must not be left
    // behind to permanently jam every future operation on this store.
    if (lockFileCreated) await rm(lockFile, { force: true }).catch(() => {});
    if (error?.code === "EEXIST") {
      throw Object.assign(
        new Error("another persona pack store operation is in progress; retry shortly. If the previous process exited, remove the store's .mutation.lock and retry"),
        { code: "PERSONA_STORE_LOCKED" },
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lockFile, { force: true });
  }
}
