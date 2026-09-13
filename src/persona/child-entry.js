import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_RESULT_CHARS = 200_000;
let session;
let cancelled = false;
const toolArgs = new Map();

const onDisconnect = () => {
  cancelled = true;
  void session?.abort();
};
process.on("disconnect", onDisconnect);

process.on("message", (message) => {
  if (message?.type === "cancel") {
    cancelled = true;
    void session?.abort();
    return;
  }
  if (message?.type === "run") void execute(message.request);
});

async function execute(request) {
  let unsubscribe;
  try {
    validateRequest(request);
    const sdk = await import(request.sdkEntry);
    const agentDir = request.agentDir ?? sdk.getAgentDir();
    const settingsManager = sdk.SettingsManager.create(request.cwd, agentDir, {
      projectTrusted: request.projectTrusted === true,
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: request.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      additionalSkillPaths: request.skillPaths,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: request.systemPrompt,
      appendSystemPrompt: [],
    });
    await loader.reload();
    const loadedSkills = new Set(loader.getSkills().skills.map((skill) => skill.name));
    const missingSkills = request.skillNames.filter((name) => !loadedSkills.has(name));
    if (missingSkills.length > 0) throw new Error(`Native child could not load skills: ${missingSkills.join(", ")}`);

    if (request.auth?.env) Object.assign(process.env, request.auth.env);
    const AuthStorage = sdk.AuthStorage ?? (await import(request.authStorageEntry)).AuthStorage;
    const credentials = AuthStorage.inMemory(request.auth?.apiKey
      ? { [request.model.provider]: { type: "api_key", key: request.auth.apiKey } }
      : {});
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials,
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const resolved = sdk.resolveCliModel({
      cliModel: `${request.model.provider}/${request.model.id}`,
      cliThinking: request.thinkingLevel,
      modelRuntime,
    });
    if (resolved.error || !resolved.model) throw new Error(resolved.error || "Native child could not resolve its model.");
    const model = {
      ...resolved.model,
      baseUrl: request.auth?.baseUrl ?? resolved.model.baseUrl,
      headers: { ...resolved.model.headers, ...request.auth?.headers },
    };
    const sessionManager = createSessionManager(sdk.SessionManager, request);
    ({ session } = await sdk.createAgentSession({
      cwd: request.cwd,
      agentDir,
      model,
      thinkingLevel: resolved.thinkingLevel ?? request.thinkingLevel,
      modelRuntime,
      tools: request.tools,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    }));
    send({ type: "started" });

    const usage = emptyUsage();
    let toolCount = 0;
    let turnCount = 0;
    let tokens = 0;
    let lastStreamProgress = 0;
    let lastAssistant;
    unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        toolCount += 1;
        toolArgs.set(event.toolCallId, event.args);
        sendProgress({ toolCount, turnCount, tokens, currentTool: event.toolName, currentToolArgs: compactArgs(event.args) });
      } else if (event.type === "tool_execution_end") {
        const args = toolArgs.get(event.toolCallId);
        toolArgs.delete(event.toolCallId);
        sendProgress({
          toolCount,
          turnCount,
          tokens,
          failedTool: event.isError ? event.toolName : undefined,
          recentTools: [{ tool: event.toolName, args: compactArgs(args), endMs: Date.now() }],
        });
      } else if (event.type === "turn_end") {
        turnCount += 1;
        if (event.message?.role === "assistant") {
          lastAssistant = event.message;
          addUsage(usage, event.message.usage);
          tokens += Number(event.message.usage?.totalTokens) || 0;
        }
        sendProgress({ toolCount, turnCount, tokens });
      } else if (event.type === "message_update" && Date.now() - lastStreamProgress >= 1_000) {
        lastStreamProgress = Date.now();
        sendProgress({ toolCount, turnCount, tokens });
      }
    });
    if (cancelled) throw new Error("Native Pi Persona child was cancelled.");
    await session.prompt(request.task, { expandPromptTemplates: false });
    lastAssistant ??= [...session.messages].reverse().find((message) => message?.role === "assistant");
    if (cancelled || lastAssistant?.stopReason === "aborted") throw new Error("Native Pi Persona child was cancelled.");
    if (lastAssistant?.stopReason === "error") throw new Error(lastAssistant.errorMessage || "Native Pi Persona child model call failed.");
    const text = session.getLastAssistantText()?.trim();
    if (!text) throw new Error("Native Pi Persona child completed without an answer.");
    await sendResult({
      type: "result",
      result: {
        status: "completed",
        text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Output truncated]` : text,
        usage,
        model: `${model.provider}/${model.id}`,
      },
    });
  } catch (error) {
    await sendResult({
      type: "result",
      result: {
        status: cancelled ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    unsubscribe?.();
    await session?.dispose?.();
    session = undefined;
    toolArgs.clear();
    process.removeListener("disconnect", onDisconnect);
    if (process.connected) process.disconnect();
    process.exit(0);
  }
}

function createSessionManager(SessionManager, request) {
  const id = randomUUID();
  if (request.context !== "fork") return SessionManager.inMemory(request.cwd, { id });
  return SessionManager.inMemory(request.cwd, { id }, [{
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: request.cwd,
  }, ...request.branch]);
}

function validateRequest(request) {
  if (!request || typeof request !== "object") throw new Error("Native child request is required.");
  for (const key of ["cwd", "sdkEntry", "personaName", "systemPrompt", "task"]) {
    if (typeof request[key] !== "string" || !request[key]) throw new Error(`Native child request ${key} is required.`);
  }
  if (!request.model?.provider || !request.model?.id) throw new Error("Native child request model is required.");
  if (!Array.isArray(request.skillNames) || !Array.isArray(request.skillPaths) || !Array.isArray(request.tools)) {
    throw new Error("Native child resource lists are required.");
  }
  if (request.context === "fork" && !Array.isArray(request.branch)) throw new Error("Native fork context requires a branch snapshot.");
}

function sendProgress(progress) {
  send({ type: "progress", progress });
}

function send(message) {
  if (process.connected) process.send?.(message);
}

function sendResult(message) {
  if (!process.connected) return Promise.resolve();
  return new Promise((resolve) => process.send(message, () => resolve()));
}

function compactArgs(value) {
  const text = JSON.stringify(value ?? {});
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) total[key] += Number(usage[key]) || 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) total.cost[key] += Number(usage.cost?.[key]) || 0;
}
