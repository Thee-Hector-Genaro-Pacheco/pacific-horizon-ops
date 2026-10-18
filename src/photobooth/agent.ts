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
import type { EventSummary, PhotoBoothErrorKind } from './types.js';

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
  /** 'voice' asks for a short answer suitable for text-to-speech. Defaults to 'text'. */
  channel?: 'text' | 'voice';
  /** Prior exchange in the same conversation, so follow-ups like "how many downloads?" stay on the same event. */
  conversation?: PhotoBoothConversationContext;
}

export interface PhotoBoothConversationContext {
  eventId?: string | null;
  previousQuestion?: string | null;
  previousAnswer?: string | null;
}

export interface PhotoBoothToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  cached: boolean;
  errorKind?: PhotoBoothErrorKind | 'unknown_tool' | 'internal';
}

export interface PhotoBoothAnswer {
  answer: string;
  toolCalls: PhotoBoothToolCallRecord[];
  /** How the final text was produced. */
  source: 'model' | 'model_revised' | 'deterministic_fallback';
  semanticViolations: SemanticViolation[];
  /** Event the answer was about (last single-event tool result), or null if none was resolved. */
  eventId: string | null;
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

export const PHOTO_BOOTH_VOICE_STYLE = `This answer will be spoken aloud on a phone call. Use two to four short sentences. Lead with the direct answer and its key numbers and mention at most one operational caveat. Do not read event UUIDs unless the owner asks for the ID, and never read raw ISO timestamps (say "on October 10" only if timing matters). No lists, markdown, JSON, tool names, or implementation details.`;

const DEFAULT_MAX_TOOL_ROUNDS = 6;

function buildMessages(question: string, conversation: PhotoBoothConversationContext | undefined): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  if (conversation?.previousQuestion && conversation.previousAnswer) {
    messages.push({ role: 'user', content: conversation.previousQuestion });
    messages.push({ role: 'assistant', content: conversation.previousAnswer });
  }
  const note = conversation?.eventId
    ? `\n\n(Conversation context: the event under discussion is ${conversation.eventId}. Use it for follow-up questions unless the owner asks about the latest event or a different event.)`
    : '';
  messages.push({ role: 'user', content: `${question}${note}` });
  return messages;
}

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

  const voice = options.channel === 'voice';
  const system = voice ? `${PHOTO_BOOTH_SYSTEM_PROMPT}\n\n${PHOTO_BOOTH_VOICE_STYLE}` : PHOTO_BOOTH_SYSTEM_PROMPT;
  const messages = buildMessages(question, options.conversation);
  const toolCalls: PhotoBoothToolCallRecord[] = [];
  const cache = new Map<string, PhotoBoothToolResult>();
  let lastSummary: EventSummary | null = null;
  let eventId: string | null = null;

  const run = async (): Promise<string> => {
    for (let round = 0; round <= maxRounds; round++) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1200,
        system,
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
        toolCalls.push({
          name: use.name,
          input: use.input,
          ok: result.ok,
          cached: Boolean(cached),
          ...(result.ok ? {} : { errorKind: result.error.kind }),
        });

        if (result.ok && result.tool === 'get_photo_booth_event_summary') {
          lastSummary = result.data as EventSummary;
        }
        if (result.ok && result.tool !== 'compare_photo_booth_events') {
          const id = (result.data as { eventId?: unknown }).eventId;
          if (typeof id === 'string') eventId = id;
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
    return { answer: first, toolCalls, source: 'model', semanticViolations: [], eventId };
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
    return { answer: revised, toolCalls, source: 'model_revised', semanticViolations: firstViolations, eventId };
  }

  const summary = lastSummary as EventSummary | null;
  if (summary) {
    return {
      answer: describeEventSummary(summary, { spoken: voice }),
      toolCalls,
      source: 'deterministic_fallback',
      semanticViolations: revisedViolations,
      eventId,
    };
  }
  // No summary to fall back on; return the revision but surface the violations to the caller.
  return { answer: revised, toolCalls, source: 'model_revised', semanticViolations: revisedViolations, eventId };
}

function createAnthropicClient(): MessagesClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is missing.');
  }
  return new Anthropic({ apiKey });
}
