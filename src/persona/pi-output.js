export function sendPersonaOutput(pi, ctx, content, level = "info") {
  if (typeof pi?.sendMessage === "function") {
    pi.sendMessage({
      customType: "pi-persona",
      content,
      display: true,
    });
    return;
  }

  ctx?.ui?.notify?.(content, level);
}
