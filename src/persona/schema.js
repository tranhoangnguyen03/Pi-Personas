const ALLOWED_ROLES = new Set(["generalist", "specialist", "runtime"]);

const RUNTIME_ONLY_FIELDS = [
  "defaultReads",
  "systemPromptMode",
  "inheritSkills",
  "inheritProjectContext",
  "defaultContext",
];

export function validatePersonaSchema(project) {
  const issues = [];

  for (const file of project.files) {
    if (file.isControl) {
      validateControlFile(file, issues);
    } else {
      validateAgentFile(file, issues);
    }
  }

  return issues;
}

function validateControlFile(file, issues) {
  if (file.frontmatter.name && file.frontmatter.description) {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: control file is launchable; remove name or description`,
    });
  }

  for (const field of RUNTIME_ONLY_FIELDS) {
    if (Object.hasOwn(file.frontmatter, field)) {
      issues.push(runtimeFieldIssue(file, field));
    }
  }
}

function validateAgentFile(file, issues) {
  if (!file.frontmatter.name) {
    issues.push(requiredFieldIssue(file, "name"));
  }
  if (!file.frontmatter.description) {
    issues.push(requiredFieldIssue(file, "description"));
  }

  const role = file.frontmatter.role ?? "specialist";
  if (!ALLOWED_ROLES.has(role)) {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: unknown role '${role}'`,
    });
  }

  if (role === "specialist" && file.frontmatter.consults?.includes("all")) {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: specialist cannot use consults: all`,
    });
  }

  validatePrimaryField(file, role, issues);

  for (const field of RUNTIME_ONLY_FIELDS) {
    if (Object.hasOwn(file.frontmatter, field)) {
      issues.push(runtimeFieldIssue(file, field));
    }
  }
}

function validatePrimaryField(file, role, issues) {
  if (!Object.hasOwn(file.frontmatter, "primary")) return;

  if (typeof file.frontmatter.primary !== "boolean") {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: primary must be true or false`,
    });
    return;
  }

  if (file.frontmatter.primary === true && role !== "generalist") {
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: primary: true is only valid on role: generalist`,
    });
  }
}

function requiredFieldIssue(file, field) {
  return {
    severity: "error",
    file: file.relativePath,
    message: `${file.relativePath}: missing required field '${field}'`,
  };
}

function runtimeFieldIssue(file, field) {
  return {
    severity: "warning",
    file: file.relativePath,
    message: `${file.relativePath}: runtime-only field '${field}' belongs in adapter defaults, not the user-facing agent schema`,
  };
}
