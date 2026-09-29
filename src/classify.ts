import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { EmailMessage } from './gmail.js';

export const ClassificationSchema = z.object({
  category: z.enum([
    'booking_inquiry',
    'quote_followup',
    'event_logistics',
    'payment',
    'reschedule_or_cancel',
    'post_event',
    'vendor_or_marketing',
    'system_notification',
    'personal',
    'other',
  ]),
  priority: z.enum(['high', 'medium', 'low']),
  requiresResponse: z.boolean(),
  summary: z.string(),
  customerName: z.string().nullable(),
  eventType: z.string().nullable(),
  eventDate: z.string().nullable(),
  location: z.string().nullable(),
  missingInformation: z.array(z.string()),
  draftReply: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type Classification = z.infer<typeof ClassificationSchema>;

const BUSINESS_DOC_PATH = path.resolve(process.cwd(), 'business.md');

/**
 * Loads the business context markdown
 */
function loadBusinessDoc(): string {
  if (fs.existsSync(BUSINESS_DOC_PATH)) {
    return fs.readFileSync(BUSINESS_DOC_PATH, 'utf-8');
  }
  return '(No business.md file found)';
}

/**
 * Strips code fences or extra whitespace around JSON output
 */
function cleanJsonText(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

/**
 * Classifies an email message using Claude and validates with Zod.
 * Retries once if validation fails. Returns null on failure.
 */
export async function classifyEmail(email: EmailMessage): Promise<Classification | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is missing.');
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const anthropic = new Anthropic({ apiKey });
  const businessContext = loadBusinessDoc();

  const systemPrompt = `You are an email triage assistant for Pacific Horizon Labs, a photo booth rental business in Southern California.

Here is the current business documentation and rules:
=== BUSINESS INFO START ===
${businessContext}
=== BUSINESS INFO END ===

Your job is to classify incoming emails and generate draft responses when a reply is required.

Rules:
1. Return ONLY a JSON object conforming strictly to the schema below. Do NOT output markdown code fences, backticks, or any conversational prose.
2. The draft reply must strictly adhere to business.md. Package names, prices, add-ons, travel fees, availability, commitments, and policies must come from business.md. Never invent or assume missing business facts, rates, or dates. If business.md lacks enough information or details are missing (e.g., event date, hours, location, package preference), the draft reply must politely ask for the missing information or state that a customized quote and availability will be confirmed once details are provided. Do not fabricate business offerings.
3. If requiresResponse is false, draftReply MUST be null.
4. If requiresResponse is true, draftReply must be a friendly, professional plain-text email reply (no HTML).
5. Category options: "booking_inquiry", "quote_followup", "event_logistics", "payment", "reschedule_or_cancel", "post_event", "vendor_or_marketing", "system_notification", "personal", "other".
6. Priority options: "high", "medium", "low".
7. Confidence must be a floating point number between 0 and 1.
8. summary must be a concise, one-sentence description of the email.

JSON Schema:
{
  "category": "booking_inquiry" | "quote_followup" | "event_logistics" | "payment" | "reschedule_or_cancel" | "post_event" | "vendor_or_marketing" | "system_notification" | "personal" | "other",
  "priority": "high" | "medium" | "low",
  "requiresResponse": boolean,
  "summary": string,
  "customerName": string | null,
  "eventType": string | null,
  "eventDate": string | null,
  "location": string | null,
  "missingInformation": string[],
  "draftReply": string | null,
  "confidence": number
}`;

  const emailPayload = `From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date}

Body:
${email.body || '(Empty body)'}`;

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Please classify the following email according to instructions:\n\n${emailPayload}`,
    },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 2000,
        system: systemPrompt,
        messages,
      });

      const textContent = response.content.find(
        (block) => block.type === 'text'
      );

      if (!textContent) {
        throw new Error('Claude response did not contain a text block.');
      }

      const rawJson = cleanJsonText(textContent.text);
      const parsed = JSON.parse(rawJson);
      const validated = ClassificationSchema.parse(parsed);
      return validated;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[classify] Attempt ${attempt} failed for message ${email.messageId}: ${errorMsg}`);

      if (attempt === 1) {
        messages.push({
          role: 'assistant',
          content: '{"error": "invalid"}',
        });
        messages.push({
          role: 'user',
          content: `Validation failed with error: ${errorMsg}. Please re-output ONLY valid raw JSON conforming strictly to the schema.`,
        });
      } else {
        console.error(`[classify] Failed to classify message ${email.messageId} after 2 attempts. Skipping.`);
        return null;
      }
    }
  }

  return null;
}
