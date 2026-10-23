import { z } from 'zod';

/**
 * The grounded answerer's output contract. One object, this exact shape (unchanged from
 * PHRO-AI-001): a verdict, the answer, and claims each tied to an evidence ID and a
 * verbatim quote. The same shape is sent to the provider as a JSON schema, so the model
 * is constrained to it; the zod schema below re-validates whatever comes back.
 */

export const AnswerDraftSchema = z
  .object({
    verdict: z.enum(['supported', 'insufficient']),
    answer: z.string(),
    claims: z
      .array(
        z
          .object({
            claim: z.string(),
            /** "E1", or "E2+E3" for one statement split across two adjacent chunks. */
            evidenceId: z.string().regex(/^E\d{1,2}(?:\+E\d{1,2})?$/),
            quote: z.string(),
          })
          .strict()
      )
      .max(8),
  })
  .strict();
export type AnswerDraft = z.infer<typeof AnswerDraftSchema>;

/** JSON schema for provider-side structured output (output_config.format). Mirrors AnswerDraftSchema. */
export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'answer', 'claims'],
  properties: {
    verdict: { type: 'string', enum: ['supported', 'insufficient'] },
    answer: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidenceId', 'quote'],
        properties: {
          claim: { type: 'string' },
          evidenceId: { type: 'string' },
          quote: { type: 'string' },
        },
      },
    },
  },
} as const;

export type ParseFailureStage = 'empty' | 'json' | 'schema';

export type ParsedDraft = { ok: true; draft: AnswerDraft } | { ok: false; stage: ParseFailureStage; detail: string };

/**
 * Strict parse. Allowed before parsing, and nothing else: trim, drop a byte-order mark,
 * and remove ONE outer ```json fence when the whole reply is that single fenced block.
 * The remaining text must be exactly one JSON object: leading/trailing prose, multiple
 * objects or truncated JSON fail. No regex repair, no invented fields. `detail` is safe
 * metadata (stage, JSON error class, schema paths), never response content.
 */
export function parseAnswerDraft(text: string): ParsedDraft {
  let t = text.replace(/^﻿/, '').trim();
  if (!t) return { ok: false, stage: 'empty', detail: 'no text in reply' };
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON';
    // Keep only the error class/position, never the offending text.
    return { ok: false, stage: 'json', detail: message.replace(/"[^"]*"/g, '"…"').slice(0, 120) };
  }
  const parsed = AnswerDraftSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      stage: 'schema',
      detail: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}:${i.code}`)
        .join(', ')
        .slice(0, 160),
    };
  }
  return { ok: true, draft: parsed.data };
}
