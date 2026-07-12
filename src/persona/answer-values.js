export function childResults(response) {
  const results = response?.result?.details?.results;
  return Array.isArray(results) ? results : [];
}

export function stringifyAnswerValue(value) {
  if (typeof value === "string") return value.trim() || undefined;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value, null, 2);
}

export function normalizeAnswerText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "(no output)";
}

export function isIntercomReceiptText(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim());
  return /^Delivered (?:single subagent result|parallel subagent results|chain subagent results) via intercom\.$/.test(lines[0] ?? "")
    && lines.includes("Full grouped output was sent over intercom.");
}

export function requireText(value, errorMessage) {
  if (typeof value !== "string" || !value.trim()) throw new Error(errorMessage);
  return value.trim();
}
