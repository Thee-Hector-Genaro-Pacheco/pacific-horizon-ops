import { z } from 'zod';

export const VoiceSessionStatusSchema = z.enum([
  'CREATED',
  'CALL_REQUESTED',
  'CONNECTED',
  'ACTIVE',
  'COMPLETED',
  'FAILED',
]);
export type VoiceSessionStatus = z.infer<typeof VoiceSessionStatusSchema>;

export const VoiceConversationStateSchema = z.enum([
  'GREETING',
  'READY',
  'READING_SUMMARY',
  'READING_DRAFT',
  'AWAITING_APPROVAL_CONFIRMATION',
  'AWAITING_REJECTION_CONFIRMATION',
  'COMPLETE',
]);
export type VoiceConversationState = z.infer<typeof VoiceConversationStateSchema>;

export const VoiceIntentSchema = z.enum([
  'SUMMARY',
  'READ_DRAFT',
  'REPEAT',
  'APPROVE',
  'REJECT',
  'HELP',
  'END_CALL',
  'UNKNOWN',
]);
export type VoiceIntent = z.infer<typeof VoiceIntentSchema>;

export const TranscriptEntrySchema = z.object({
  role: z.enum(['agent', 'user']),
  text: z.string(),
  timestamp: z.string(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const VoiceSessionSchema = z.object({
  sessionId: z.string(),
  actionId: z.string(),
  callSid: z.string().nullable(),
  status: VoiceSessionStatusSchema,
  conversationState: VoiceConversationStateSchema,
  toPhone: z.string(),
  fromPhone: z.string(),
  lastSpokenText: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  transcript: z.array(TranscriptEntrySchema),
});
export type VoiceSession = z.infer<typeof VoiceSessionSchema>;

export const VoiceEventSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  actionId: z.string(),
  timestamp: z.string(),
  fromStatus: VoiceSessionStatusSchema.nullable(),
  toStatus: VoiceSessionStatusSchema,
  conversationState: VoiceConversationStateSchema,
  actor: z.string(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type VoiceEvent = z.infer<typeof VoiceEventSchema>;

/**
 * Masks an E.164 phone number for safe CLI and log presentation (e.g. +19492810572 -> +1******0572)
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone) return '';
  const trimmed = phone.trim();
  if (trimmed.length <= 6) {
    return '***';
  }
  const prefix = trimmed.startsWith('+') ? trimmed.slice(0, 2) : trimmed.slice(0, 1);
  const suffix = trimmed.slice(-4);
  const maskLength = Math.max(trimmed.length - prefix.length - suffix.length, 4);
  return `${prefix}${'*'.repeat(maskLength)}${suffix}`;
}

/**
 * Replaces any E.164 phone numbers in a text string with their masked representation
 */
export function maskPhoneNumbersInText(text: string): string {
  if (!text) return '';
  return text.replace(/\+?[0-9]{10,15}\b/g, (match) => maskPhoneNumber(match));
}
