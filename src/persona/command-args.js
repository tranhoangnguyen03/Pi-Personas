export function tokenizeArgs(input, unterminatedMessage) {
  const tokens = [];
  let current = "";
  let quote = null;
  let tokenStarted = false;

  for (const char of String(input)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) tokens.push(current);
      current = "";
      tokenStarted = false;
      continue;
    }
    current += char;
    tokenStarted = true;
  }

  if (quote) throw new Error(unterminatedMessage);
  if (tokenStarted) tokens.push(current);
  return tokens;
}
