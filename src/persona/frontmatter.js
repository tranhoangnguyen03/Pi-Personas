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

  const frontmatterLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const errors = [];
  const raw = {};

  for (const line of frontmatterLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      errors.push(`${filePath}: malformed frontmatter line '${trimmed}'`);
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key) {
      errors.push(`${filePath}: empty frontmatter key`);
      continue;
    }
    raw[key] = value;
  }

  return {
    frontmatter: normalizeFrontmatter(raw),
    body,
    errors,
  };
}

function normalizeFrontmatter(raw) {
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (LIST_FIELDS.has(key)) {
      normalized[key] = splitList(value);
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
