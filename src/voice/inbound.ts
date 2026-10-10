/**
 * Inbound Pacific Ops call entry: caller normalization and authorization.
 *
 * OWNER BETA: authorization is caller-ID allowlisting against PHRO_OWNER_PHONE_E164.
 * Caller ID can be spoofed on the PSTN, so this is acceptable only for the controlled
 * owner beta. It sits behind the `InboundCallerAuthorizer` interface so a stronger
 * method (spoken passphrase, PIN via DTMF, Twilio Verify, STIR/SHAKEN attestation
 * checks) can replace or be layered onto it without touching the webhook or the
 * conversation logic.
 *
 * Authorization is decided once, in the signed HTTP webhook, before any session or
 * ConversationRelay connection exists. Nothing downstream re-derives it from client
 * input.
 */

export type CallDirection = 'inbound' | 'outbound';
export type CallerRole = 'owner';

export interface CallerIdentity {
  role: CallerRole;
  /** How the caller was authenticated; future methods extend this union. */
  method: 'caller_id';
  /** Normalized E.164 of the caller. Internal only; mask before logging. */
  phoneE164: string;
}

export type CallerRejectionReason =
  | 'missing_from'
  | 'malformed_from'
  | 'not_owner'
  | 'owner_not_configured'
  | 'wrong_destination';

export type CallerDecision =
  | { authorized: true; identity: CallerIdentity }
  | { authorized: false; reason: CallerRejectionReason };

export interface InboundCallerAuthorizer {
  authorize(input: { from?: string | null; to?: string | null }): CallerDecision;
}

/**
 * Strict E.164 normalization. Removes common formatting characters and requires a
 * leading "+", a non-zero country digit and 8–15 digits in total. Anything else
 * (including Twilio's "anonymous" / restricted caller values) is rejected rather
 * than guessed at.
 */
export function normalizeE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.trim().replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

/** Owner beta: the caller's number must equal the configured owner number. */
export function createOwnerCallerIdAuthorizer(config: {
  ownerE164: string | undefined;
  /** When set, the call must have been placed to this number (defense in depth). */
  businessE164?: string | undefined;
}): InboundCallerAuthorizer {
  const owner = normalizeE164(config.ownerE164);
  const business = config.businessE164 ? normalizeE164(config.businessE164) : null;

  return {
    authorize({ from, to }) {
      if (!owner) return { authorized: false, reason: 'owner_not_configured' };
      if (from === undefined || from === null || String(from).trim() === '') return { authorized: false, reason: 'missing_from' };
      const caller = normalizeE164(from);
      if (!caller) return { authorized: false, reason: 'malformed_from' };
      if (business && normalizeE164(to) !== business) return { authorized: false, reason: 'wrong_destination' };
      if (caller !== owner) return { authorized: false, reason: 'not_owner' };
      return { authorized: true, identity: { role: 'owner', method: 'caller_id', phoneE164: caller } };
    },
  };
}

/** Reads configuration at call time so a changed .env takes effect on restart without code changes. */
export function ownerAuthorizerFromEnv(env: NodeJS.ProcessEnv = process.env): InboundCallerAuthorizer {
  return createOwnerCallerIdAuthorizer({
    ownerE164: env.PHRO_OWNER_PHONE_E164,
    businessE164: env.TWILIO_PHONE_NUMBER_E164,
  });
}

/** Spoken by ConversationRelay the moment the owner's call connects, while the inbox loads. */
export const INBOUND_OWNER_WELCOME = "Welcome back. I'll check your three most recent inbox messages.";

/** Neutral refusal: does not reveal who the line belongs to or whether a number is known. */
export const PRIVATE_LINE_MESSAGE = 'This Pacific Ops line is private.';
