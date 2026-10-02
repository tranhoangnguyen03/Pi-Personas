// Local, zero-cost, OpenAI-compatible streaming mock model for driving a real
// `pi --mode rpc` process through actual model-issued tool calls. No network
// beyond 127.0.0.1 and no provider credentials: the provider is declared in
// the throwaway agent dir's models.json (same pattern as
// test/persona-pack-session.test.js and the packed-acceptance script).
//
// `respond(turn)` decides each model reply from the request Pi actually sent:
//   turn.lastUserText   text of the most recent user message
//   turn.toolResults    tool-result texts since that user message, in order
//   turn.allToolResults every tool-result text in the conversation
// and returns { toolCalls: [{ name, arguments }] } or { text }.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROVIDER = "mock-provider";
const MODEL = "mock-model";

function contentText(content) {
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("");
  return String(content ?? "");
}

export async function startMockModel(respond) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      const messages = parsed.messages ?? [];
      let lastUserIndex = -1;
      messages.forEach((message, index) => { if (message.role === "user") lastUserIndex = index; });
      const turn = {
        lastUserText: lastUserIndex >= 0 ? contentText(messages[lastUserIndex].content) : "",
        toolResults: messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool").map((m) => contentText(m.content)),
        allToolResults: messages.filter((m) => m.role === "tool").map((m) => contentText(m.content)),
        system: contentText(messages.find((m) => m.role === "system")?.content),
        toolNames: (parsed.tools ?? []).map((tool) => tool.function?.name),
      };
      requests.push(turn);
      let reply;
      try {
        reply = respond(turn) ?? { text: "ok" };
      } catch (error) {
        reply = { text: `mock model script error: ${error?.message ?? error}` };
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const id = `chatcmpl-mock-${requests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const sendFrame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const frame = (delta, finish_reason = null) =>
        sendFrame({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason }] });
      if (reply.toolCalls?.length) {
        reply.toolCalls.forEach((call, index) => {
          const callId = `call_${requests.length}_${index}`;
          frame({ ...(index === 0 ? { role: "assistant", content: null } : {}), tool_calls: [{ index, id: callId, type: "function", function: { name: call.name, arguments: "" } }] });
          frame({ tool_calls: [{ index, function: { arguments: JSON.stringify(call.arguments ?? {}) } }] });
        });
        frame({}, "tool_calls");
      } else {
        frame({ role: "assistant", content: reply.text ?? "" });
        frame({}, "stop");
      }
      sendFrame({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  return {
    port,
    requests,
    cliArgs: ["--provider", PROVIDER, "--model", MODEL],
    writeModelsJson(agentDir) {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "mock-key",
            models: [{ id: MODEL, name: "Mock Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
          },
        },
      }));
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The exact retry object a confirm-required persona_pack result spells out
// ("... call persona_pack again with {...}"), read back the way a model would.
export function retryFromToolResult(text) {
  const match = String(text).match(/call persona_pack again with (\{.*\})\.?\s*$/m);
  return match ? JSON.parse(match[1]) : undefined;
}
