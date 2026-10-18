import Anthropic from '@anthropic-ai/sdk';
import type { PhotoBoothAnalyticsClient } from './client.js';
import { PHOTO_BOOTH_TOOLS, executePhotoBoothTool, type PhotoBoothToolResult } from './tools.js';
import {
  PHOTO_BOOTH_DATASET_RULES,
  PHOTO_BOOTH_METRIC_RULES,
  describeEventSummary,
  findSemanticViolations,
  type SemanticViolation,
} from './semantics.js';
import type { EventSummary } from './types.js';

/** Minimal surface of the Anthropic client the agent uses, so tests can inject a fake. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface PhotoBoothAgentOptions {
  analytics: PhotoBoothAnalyticsClient;
  anthropic?: MessagesClient;
  model?: string;
  maxToolRounds?: number;
}

export interface PhotoBoothToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  cached: boolean;
}

export interface PhotoBoothAnswer {
  answer: string;
  toolCalls: PhotoBoothToolCallRecord[];
  /** How the final text was produced. */
  source: 'model' | 'model_revised' | 'deterministic_fallback';
  semanticViolations: SemanticViolation[];
}

export const PHOTO_BOOTH_SYSTEM_PROMPT = `You are Pacific Rising Ops, the operations agent for Pacific Horizon Labs, a photo booth rental business.
You answer questions about Photo Booth performance using ONLY the read-only Photo Booth analytics tools. The analytics API is the source of truth and has already done every calculation; never recompute, estimate, or invent numbers.

Tool routing:
- For "latest event", "last event", "tonight", or any question without an event UUID: call get_latest_photo_booth_event, then get_photo_booth_event_summary with the returned eventId.
- get_photo_booth_event_summary covers sessions, claim views, downloads, Instagram/TikTok/Google Review CTA clicks, and basic private feedback. Only call the feedback or delivery tools when the question needs their extra detail (feedback categories/triage, completion rate, media counts, unfinalized sessions).
- To compare two events, call compare_photo_booth_events once with both UUIDs. If the user gives fewer than two UUIDs, ask for them rather than guessing.
- Do not repeat a tool call you already made in this conversation.

If a tool returns ok:false, the data is unavailable. Say so plainly with the reason. NEVER report zeros, "no activity", or partial guesses for a failed call. A successful result with zero counts is a real empty result and may be reported as such.

${PHOTO_BOOTH_METRIC_RULES}

${PHOTO_BOOTH_DATASET_RULES}

Answer style: plain text, no markdown headers or tables. Lead with the direct answer, use the exact numbers from the tools, keep it to a short paragraph or two, and mention at most one or two operational items worth reviewing (for example unfinalized sessions). Refer to the event by its UUID only when needed for clarity.`;

const DEFAULT_MAX_TOOL_ROUNDS = 6;

/**
 * Answers a natural-language Photo Booth question with an Anthropic tool-use loop
 * over the read-only analytics tools, then enforces metric semantics on the reply.
 */
export async function answerPhotoBoothQuestion(
  question: string,
  options: PhotoBoothAgentOptions
): Promise<PhotoBoothAnswer> {
  const anthropic = options.anthropic ?? createAnthropicClient();
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
  const maxRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
  const toolCalls: PhotoBoothToolCallRecord[] = [];
  const cache = new Map<string, PhotoBoothToolResult>();
  let lastSummary: EventSummary | null = null;

  const run = async (): Promise<string> => {
    for (let round = 0; round <= maxRounds; round++) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1200,
        system: PHOTO_BOOTH_SYSTEM_PROMPT,
        tools: PHOTO_BOOTH_TOOLS,
        messages,
      });
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
      }
      if (round === maxRounds) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const key = `${use.name}:${JSON.stringify(use.input)}`;
        const cached = cache.get(key);
        const result = cached ?? (await executePhotoBoothTool(use.name, use.input, options.analytics));
        if (!cached && result.ok) cache.set(key, result);
        toolCalls.push({ name: use.name, input: use.input, ok: result.ok, cached: Boolean(cached) });

        if (result.ok && result.tool === 'get_photo_booth_event_summary') {
          lastSummary = result.data as EventSummary;
        }
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new Error('Photo Booth agent exceeded the maximum number of tool rounds.');
  };

  const first = await run();
  const firstViolations = findSemanticViolations(first);
  if (firstViolations.length === 0) {
    return { answer: first, toolCalls, source: 'model', semanticViolations: [] };
  }

  console.warn(`[photobooth] Answer flagged for ${firstViolations.map((v) => v.rule).join(', ')}; requesting revision.`);
  messages.push({
    role: 'user',
    content: `Revise your previous answer. It misstates what the telemetry proves: ${firstViolations
      .map((v) => `"${v.match}" (${v.rule})`)
      .join('; ')}. Follow the Photo Booth metric meanings exactly and keep every number unchanged. Reply with the revised answer only.`,
  });
  const revised = await run();
  const revisedViolations = findSemanticViolations(revised);
  if (revisedViolations.length === 0) {
    return { answer: revised, toolCalls, source: 'model_revised', semanticViolations: firstViolations };
  }

  const summary = lastSummary as EventSummary | null;
  if (summary) {
    return {
      answer: describeEventSummary(summary),
      toolCalls,
      source: 'deterministic_fallback',
      semanticViolations: revisedViolations,
    };
  }
  // No summary to fall back on; return the revision but surface the violations to the caller.
  return { answer: revised, toolCalls, source: 'model_revised', semanticViolations: revisedViolations };
}

function createAnthropicClient(): MessagesClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is missing.');
  }
  return new Anthropic({ apiKey });
}
