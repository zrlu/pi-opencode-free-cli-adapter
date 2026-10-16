import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { AssistantMessageEventStream, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { runOpenCode } from "./server";
import { answerQuestions } from "./questions";
import { answerPermission } from "./permissions";

export function opencodeStreamSimple(model: any, context: any, options: any = {}, ui?: any) {
  const stream = new AssistantMessageEventStream();
  const output: any = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
  const userMessageID = `msg_${randomBytes(12).toString("hex")}`;
  const blocks = new Map<string, { index: number; kind: "text" | "thinking"; ended: boolean }>();
  const steps = new Set<string>();
  const roles = new Map<string, string>([[userMessageID, "user"]]);
  function emit(type: string, data: any) { stream.push({ type, ...data } as any); }
  function finish(id: string) {
    const block = blocks.get(id);
    if (!block || block.ended) return;
    block.ended = true;
    emit(`${block.kind}_end`, { contentIndex: block.index, content: output.content[block.index][block.kind], partial: output });
  }
  function partUpdated(part: any) {
    if (roles.get(part.messageID) === "user") return;
    if (part.type === "step-finish" && !steps.has(part.id)) {
      steps.add(part.id);
      const t = part.tokens ?? {};
      // Each step re-sends the whole prompt, so the prompt fields describe the
      // latest step, not a sum over steps. Summing them made input + cacheRead
      // exceed the context window and triggered false overflow compaction every
      // turn (Pi checks `usage.input + usage.cacheRead > contextWindow`).
      output.usage.input = t.input || 0;
      output.usage.cacheRead = t.cache?.read || 0;
      output.usage.cacheWrite = t.cache?.write || 0;
      // Output and reasoning are genuinely produced per step, so they sum.
      output.usage.output += (t.output || 0) + (t.reasoning || 0);
      output.usage.totalTokens = t.total
        || (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
      return;
    }
    if (part.type !== "text" && part.type !== "reasoning") return;
    let block = blocks.get(part.id);
    if (!block) {
      const kind = part.type === "reasoning" ? "thinking" : "text";
      block = { index: output.content.length, kind, ended: false };
      blocks.set(part.id, block);
      output.content.push(kind === "thinking" ? { type: kind, thinking: "" } : { type: kind, text: "" });
      emit(`${kind}_start`, { contentIndex: block.index, partial: output });
    }
    const old = output.content[block.index][block.kind];
    const next = part.text ?? "";
    // Snapshots repeat all streamed text. Emit only their missing suffix.
    if (next.length > old.length && next.startsWith(old)) {
      output.content[block.index][block.kind] = next;
      emit(`${block.kind}_delta`, { contentIndex: block.index, delta: next.slice(old.length), partial: output });
    }
    if (part.time?.end) finish(part.id);
  }
  function onEvent(event: any) {
    const p = event.properties ?? {};
    if (event.type === "message.updated") roles.set(p.info.id, p.info.role);
    if (event.type === "message.part.updated") partUpdated(p.part);
    if (event.type === "message.part.delta" && p.field === "text") {
      const block = blocks.get(p.partID);
      if (!block || block.ended || roles.get(p.messageID) === "user") return;
      output.content[block.index][block.kind] += p.delta;
      emit(`${block.kind}_delta`, { contentIndex: block.index, delta: p.delta, partial: output });
    }
  }
  (async () => {
    emit("start", { partial: output });
    try {
      const contentText = (content: any) => typeof content === "string" ? content
        : (content ?? []).map((part: any) => part.text ?? (part.type === "toolCall" ? JSON.stringify(part) : "")).filter(Boolean).join("\n");
      const transcript = (context.messages ?? []).map((message: any) => `${message.role}:\n${contentText(message.content)}`).join("\n\n");
      const body: any = {
        messageID: userMessageID,
        model: { providerID: "opencode", modelID: model.id },
        ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
        parts: [{ type: "text", text: `Continue the following conversation. Respond to the final message.\n\n${transcript}` }],
        ...(!ui ? { tools: { question: false } } : {}),
      };
      if (model.reasoning && options.reasoning) body.variant = options.reasoning;
      const result = await runOpenCode(body, onEvent, options.signal,
        ui ? (request, signal) => answerQuestions(ui, request, signal) : undefined,
        ui ? (request, signal) => answerPermission(ui, request, signal) : undefined);
      // Reconcile the final response if its last SSE snapshot has not arrived yet.
      for (const part of result.parts ?? []) partUpdated(part);
      for (const id of blocks.keys()) finish(id);
      if (!output.content.some((part: any) => part.type === "text" && part.text)) throw new Error("OpenCode returned no text");
      emit("done", { reason: "stop", message: output });
      stream.end();
    } catch (error: any) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error?.message ?? String(error);
      emit("error", { reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function (pi: ExtensionAPI) {
  let ui: any;
  for (const event of ["session_start", "before_agent_start", "model_select"] as const) {
    pi.on?.(event as any, (_event: any, ctx: any) => { ui = ctx.hasUI ? ctx.ui : undefined; });
  }
  const run = (model: any, context: any, options: any) => opencodeStreamSimple(model, context, options, ui);
  registerApiProvider({ api: "opencode-free-api", stream: run, streamSimple: run }, "local-opencode-free");
}
