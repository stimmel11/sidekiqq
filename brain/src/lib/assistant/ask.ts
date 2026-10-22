import type Anthropic from "@anthropic-ai/sdk";
import type { Deps } from "../deps";
import { config } from "../env";
import type { Action, AskRequest, AskResponse } from "../models";
import { newId } from "../util";
import { runtimeContext, systemBlocks } from "./prompt";
import { enforceSpoken } from "./spoken";
import { executeTool, RESPOND_TOOL, RespondSchema, toolDefinitions, type ToolContext } from "./tools";

/**
 * /api/ask core: Claude tool-use loop.
 *  1. Load conversation history (Redis, sliding TTL).
 *  2. Loop: model calls lookup/update tools; we execute them and feed results back.
 *  3. The model ends by calling `respond` { reply, spoken }; on the last allowed iteration
 *     we force that tool so the loop always terminates with a structured answer.
 *  4. `spoken` is length-guarded server-side regardless of what the model produced.
 */
export async function runAsk(deps: Deps, req: AskRequest): Promise<AskResponse> {
  const now = deps.clock();
  const conversationId = req.conversationId ?? newId("conv");
  const history = await deps.repos.conversations.load(conversationId);

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: "user", content: req.text },
  ];

  const system = await systemBlocks(runtimeContext({ now, device: req.device }));
  const tools = toolDefinitions();
  const actions: Action[] = [];
  const ctx: ToolContext = { deps, now, device: req.device, actions };
  const maxIterations = config.maxToolIterations();
  const llm = deps.llm();

  let reply: string | null = null;
  let spoken: string | null = null;
  let lastText = "";

  for (let i = 0; i < maxIterations && reply === null; i++) {
    const forceRespond = i === maxIterations - 1;
    const res = await llm.create({
      model: config.claudeModel(),
      max_tokens: config.claudeMaxTokens(),
      system,
      tools,
      tool_choice: forceRespond ? { type: "tool", name: RESPOND_TOOL, disable_parallel_tool_use: true } : { type: "auto" },
      messages,
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) lastText = text;

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) {
      // Model answered in plain text without calling respond: accept it.
      reply = text || "I don't have an answer for that yet.";
      break;
    }

    messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (use.name === RESPOND_TOOL) {
        const parsed = RespondSchema.safeParse(use.input);
        if (parsed.success) {
          reply = parsed.data.reply;
          spoken = parsed.data.spoken;
        } else {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "respond needs non-empty reply and spoken strings." });
        }
        continue;
      }
      // Execute side-effecting tools even if respond came in the same turn.
      const out = await executeTool(use.name, use.input, ctx);
      results.push({ type: "tool_result", tool_use_id: use.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    if (reply !== null) break;
    // Every tool_use must be answered, including a malformed respond.
    const answered = new Set(results.map((r) => r.tool_use_id));
    for (const use of toolUses) {
      if (!answered.has(use.id)) results.push({ type: "tool_result", tool_use_id: use.id, content: "ok" });
    }
    messages.push({ role: "user", content: results });
  }

  if (reply === null) {
    reply = lastText || "Sorry, I couldn't finish that. Please try again.";
  }
  const finalSpoken = enforceSpoken(spoken, reply);

  await deps.repos.conversations.append(conversationId, [
    { role: "user", content: req.text, at: now.toISOString() },
    { role: "assistant", content: reply, at: deps.clock().toISOString() },
  ]);

  return { reply, spoken: finalSpoken, conversationId, actions };
}
