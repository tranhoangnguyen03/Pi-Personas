export function sendPersonaOutput(pi, ctx, content, level = "info") {
  if (typeof pi?.sendMessage === "function") {
    pi.sendMessage({
      content,
      display: true,
    });
    return;
  }

  ctx?.ui?.notify?.(content, level);
}
