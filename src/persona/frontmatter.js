import { parseDocument } from "yaml";

const FRONTMATTER_BOUNDARY = "---";

const LIST_FIELDS = new Set(["tools", "docs", "consults", "tags"]);

export function parseFrontmatterDocument(source, filePath = "<memory>") {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_BOUNDARY) {
    return {
      frontmatter: {},
      body: normalized,
      errors: [],
    };
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_BOUNDARY);
  if (end === -1) {
    return {
      frontmatter: {},
      body: normalized,
      errors: [`${filePath}: missing closing frontmatter boundary`],
    };
  }

  const frontmatterSource = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");

  try {
    const document = parseDocument(frontmatterSource, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    const errors = document.errors.map((error) => `${filePath}: ${error.message}`);
    if (errors.length > 0) {
      return {
        frontmatter: {},
        body,
        errors,
      };
    }
    const raw = document.toJS() ?? {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        frontmatter: {},
        body,
        errors: [`${filePath}: frontmatter must be a YAML mapping`],
      };
    }
    return {
      frontmatter: normalizeFrontmatter(raw),
      body,
      errors: [],
    };
  } catch (error) {
    return {
      frontmatter: {},
      body,
      errors: [`${filePath}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function normalizeFrontmatter(raw) {
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (LIST_FIELDS.has(key)) {
      normalized[key] = splitList(value);
    } else if (value === null || value === undefined) {
      normalized[key] = "";
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function splitList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
