import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodType } from "zod";
import { config, required } from "../env";

export type MessageParam = Anthropic.MessageParam;
export type Message = Anthropic.Message;
export type ToolDef = Anthropic.Tool;
export type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/** The narrow slice of the Anthropic client the brain uses (mocked in tests). */
export interface LLM {
  create(params: CreateParams): Promise<Message>;
}

export class AnthropicLLM implements LLM {
  private readonly client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  }
  create(params: CreateParams): Promise<Message> {
    return this.client.messages.create(params);
  }
}

export function llmFromEnv(): LLM {
  return new AnthropicLLM(required("ANTHROPIC_API_KEY"));
}

/** Convert a zod object schema into an Anthropic tool input_schema. */
export function toolSchema(schema: ZodType): ToolDef["input_schema"] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json as ToolDef["input_schema"];
}

/**
 * Ask the model for one structured object by forcing a single tool call.
 * Used by the Gmail scan (extraction), briefs and Top-5 ranking.
 */
export async function structuredCall<T>(
  llm: LLM,
  opts: {
    system: Anthropic.TextBlockParam[];
    user: string;
    toolName: string;
    toolDescription: string;
    schema: ZodType<T>;
    maxTokens?: number;
  },
): Promise<unknown> {
  const res = await llm.create({
    model: config.claudeModel(),
    max_tokens: opts.maxTokens ?? config.claudeMaxTokens(),
    system: opts.system,
    tools: [{ name: opts.toolName, description: opts.toolDescription, input_schema: toolSchema(opts.schema) }],
    tool_choice: { type: "tool", name: opts.toolName, disable_parallel_tool_use: true },
    messages: [{ role: "user", content: opts.user }],
  });
  const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === opts.toolName);
  if (!block) throw new Error(`Model did not call ${opts.toolName} (stop_reason=${res.stop_reason})`);
  return block.input;
}
