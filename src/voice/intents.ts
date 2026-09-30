import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { type VoiceIntent, type VoiceConversationState, VoiceIntentSchema } from './types.js';

export const VoiceIntentClassificationSchema = z.object({
  intent: VoiceIntentSchema,
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
});
export type VoiceIntentClassification = z.infer<typeof VoiceIntentClassificationSchema>;

/**
 * Fast deterministic phrase matching for common voice commands
 */
export function matchHeuristicIntent(utterance: string): VoiceIntent | null {
  const norm = utterance.toLowerCase().trim().replace(/[.,!?;:]/g, '');

  if (
    norm === 'help' ||
    norm === 'options' ||
    norm === 'what can i say' ||
    norm === 'what can you do' ||
    norm.includes('what are my options')
  ) {
    return 'HELP';
  }

  if (
    norm === 'repeat' ||
    norm === 'say again' ||
    norm === 'say that again' ||
    norm === 'can you repeat that' ||
    norm === 'pardon'
  ) {
    return 'REPEAT';
  }

  if (
    norm === 'summary' ||
    norm === 'read summary' ||
    norm === 'give me a summary' ||
    norm === 'summarize' ||
    norm.includes('who is it from') ||
    norm.includes('what is the email about')
  ) {
    return 'SUMMARY';
  }

  if (
    norm === 'read draft' ||
    norm === 'read the draft' ||
    norm === 'read reply' ||
    norm === 'read the reply' ||
    norm === 'what does the draft say' ||
    norm === 'draft'
  ) {
    return 'READ_DRAFT';
  }

  if (
    norm === 'bye' ||
    norm === 'goodbye' ||
    norm === 'hang up' ||
    norm === 'end call' ||
    norm === 'quit' ||
    norm === 'exit'
  ) {
    return 'END_CALL';
  }

  if (
    norm === 'approve' ||
    norm === 'approve it' ||
    norm === 'looks good' ||
    norm === 'i approve' ||
    norm === 'approve draft'
  ) {
    return 'APPROVE';
  }

  if (
    norm === 'reject' ||
    norm === 'reject it' ||
    norm === 'decline' ||
    norm === 'do not send' ||
    norm === 'reject draft'
  ) {
    return 'REJECT';
  }

  return null;
}

/**
 * Classifies spoken utterance using Claude Sonnet with safe text block extraction,
 * falling back to heuristic matching if Anthropic is unavailable or errors.
 */
export async function classifyVoiceIntent(
  utterance: string,
  _conversationState: VoiceConversationState
): Promise<{ intent: VoiceIntent; confidence: number }> {
  // First check fast heuristics
  const heuristic = matchHeuristicIntent(utterance);
  if (heuristic) {
    return { intent: heuristic, confidence: 1.0 };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { intent: 'UNKNOWN', confidence: 0.0 };
  }

  try {
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
    const anthropic = new Anthropic({ apiKey });

    const systemPrompt = `You are a voice intent classifier for Pacific Horizon Ops' voice agent.
Your task is to classify a caller's spoken utterance into exactly one of these intents:
- SUMMARY: Caller wants to hear who the email is from or what it is about.
- READ_DRAFT: Caller wants to hear the exact drafted email reply.
- REPEAT: Caller wants the agent to repeat the last thing spoken.
- APPROVE: Caller indicates they want to approve or accept the draft (e.g. "let's approve it", "sounds great approve it").
- REJECT: Caller indicates they want to reject or decline the draft (e.g. "let's reject this", "decline it").
- HELP: Caller asks for instructions or available options.
- END_CALL: Caller wants to finish, hang up, or exit.
- UNKNOWN: Anything else that is unclear or does not fit.

Return ONLY a JSON object:
{
  "intent": "SUMMARY" | "READ_DRAFT" | "REPEAT" | "APPROVE" | "REJECT" | "HELP" | "END_CALL" | "UNKNOWN",
  "confidence": number between 0 and 1,
  "explanation": "brief reason"
}`;

    const response = await anthropic.messages.create({
      model,
      max_tokens: 150,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Caller utterance: "${utterance}"`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock) {
      throw new Error('No text block returned by Claude.');
    }

    let cleaned = textBlock.text.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);

    const parsed = JSON.parse(cleaned.trim());
    const validated = VoiceIntentClassificationSchema.parse(parsed);

    return {
      intent: validated.intent,
      confidence: validated.confidence,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[voice:intents] Intent classification fallback: ${msg}`);
    return { intent: 'UNKNOWN', confidence: 0.0 };
  }
}
