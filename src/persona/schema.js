const ALLOWED_ROLES = new Set(["generalist", "specialist", "runtime"]);
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const LIST_FIELDS = ["docs", "skills", "tools", "consults", "tags"];
const CONTROL_AGENT_FIELDS = ["name", "description", "role", "primary", "model"];

export const DIRECT_PERSONA_RESERVED_NAMES = new Set([
  "agent",
  "arminsayshi",
  "chain",
  "changelog",
  "clone",
  "compact",
  "copy",
  "debug",
  "dementedelves",
  "export",
  "fork",
  "hotkeys",
  "import",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "parallel",
  "persona",
  "persona-list",
  "persona-roundtable",
  "quit",
  "reload",
  "resume",
  "run",
  "run-chain",
  "scoped-models",
  "session",
  "settings",
  "share",
  "subagents-doctor",
  "subagents-models",
  "tree",
  "trust",
]);

const RUNTIME_ONLY_FIELDS = [
  "defaultReads",
  "systemPromptMode",
  "inheritSkills",
  "inheritProjectContext",
  "defaultContext",
];

export function validatePersonaSchema(project) {
  return project.files.flatMap((file) => file.schemaIssues ?? validatePersonaFile(file));
}

export function validatePersonaFile(file) {
  const issues = [];
  if (file.isControl) validateControlFile(file, issues);
  else validateAgentFile(file, issues);
  return issues;
}

export function isSafeAgentName(value) {
  return typeof value === "string" && AGENT_NAME_PATTERN.test(value);
}

export function isDirectPersonaCommandName(value) {
  return isSafeAgentName(value) && !DIRECT_PERSONA_RESERVED_NAMES.has(value);
}

function validateControlFile(file, issues) {
  const raw = rawFrontmatter(file);
  if (Object.hasOwn(raw, "name") && Object.hasOwn(raw, "description")) {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: control file is launchable; remove name or description`,
    });
  }
  for (const field of CONTROL_AGENT_FIELDS) {
    if (!Object.hasOwn(raw, field)) continue;
    if ((field === "name" || field === "description")
      && Object.hasOwn(raw, "name")
      && Object.hasOwn(raw, "description")) continue;
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: control files cannot declare agent field '${field}'`,
    });
  }

  validateListFields(file, raw, issues);
  for (const field of RUNTIME_ONLY_FIELDS) {
    if (Object.hasOwn(raw, field)) {
      issues.push(runtimeFieldIssue(file, field));
    }
  }
}

function validateAgentFile(file, issues) {
  const raw = rawFrontmatter(file);
  validateRequiredString(file, raw, "name", issues);
  validateRequiredString(file, raw, "description", issues);

  if (typeof raw.name === "string" && raw.name.trim() && !isSafeAgentName(raw.name)) {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: name must match ${AGENT_NAME_PATTERN}`,
    });
  } else if (typeof raw.name === "string" && DIRECT_PERSONA_RESERVED_NAMES.has(raw.name)) {
    issues.push({
      severity: "warning",
      file: file.relativePath,
      message: `${file.relativePath}: /${raw.name} is reserved; launch with /persona use ${raw.name}`,
    });
  }

  const role = raw.role ?? "specialist";
  if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: unknown role '${role}'`,
    });
  }

  validatePrimaryField(file, raw, role, issues);
  validateOptionalString(file, raw, "model", issues);
  validateListFields(file, raw, issues);

  for (const field of RUNTIME_ONLY_FIELDS) {
    if (Object.hasOwn(raw, field)) {
      issues.push(runtimeFieldIssue(file, field));
    }
  }
}

function validatePrimaryField(file, raw, role, issues) {
  if (!Object.hasOwn(raw, "primary")) return;

  if (typeof raw.primary !== "boolean") {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: primary must be true or false`,
    });
    return;
  }

  if (raw.primary === true && role !== "generalist") {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: primary: true is only valid on role: generalist`,
    });
  }
}

function validateRequiredString(file, raw, field, issues) {
  if (!Object.hasOwn(raw, field)) {
    issues.push(fieldIssue(file, `missing required field '${field}'`));
    return;
  }
  if (typeof raw[field] !== "string" || !raw[field].trim()) {
    issues.push(fieldIssue(file, `${field} must be a non-empty string`));
  }
}

function validateOptionalString(file, raw, field, issues) {
  if (!Object.hasOwn(raw, field)) return;
  if (typeof raw[field] !== "string" || !raw[field].trim()) {
    issues.push(fieldIssue(file, `${field} must be a non-empty string when provided`));
  }
}

function validateListFields(file, raw, issues) {
  for (const field of LIST_FIELDS) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = raw[field];
    if (value === null || value === undefined) continue;
    if (typeof value === "string") continue;
    if (!Array.isArray(value)) {
      issues.push(fieldIssue(file, `${field} must be a string or an array of non-empty strings`));
      continue;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] !== "string" || !value[index].trim()) {
        issues.push(fieldIssue(file, `${field}[${index}] must be a non-empty string`));
      }
    }
  }
}

function rawFrontmatter(file) {
  return file.rawFrontmatter ?? file.frontmatter ?? {};
}

function fieldIssue(file, message) {
  return {
    severity: "error",
    file: file.relativePath,
    message: `${file.relativePath}: ${message}`,
  };
}

function runtimeFieldIssue(file, field) {
  return {
    severity: "warning",
    file: file.relativePath,
    message: `${file.relativePath}: runtime-only field '${field}' belongs in adapter defaults, not the user-facing agent schema`,
  };
}
