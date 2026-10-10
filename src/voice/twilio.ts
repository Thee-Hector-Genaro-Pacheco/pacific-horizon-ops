import twilio from 'twilio';
import { maskPhoneNumbersInText } from './types.js';

export interface FormattedTwilioError {
  status?: number;
  code?: number;
  message: string;
  moreInfo?: string;
}

/**
 * Extracts and sanitizes Twilio RestException metadata, masking any embedded phone numbers.
 * Strictly surfaces ONLY status, code, message, and moreInfo.
 */
export function formatTwilioRestError(err: unknown): FormattedTwilioError | null {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if ('status' in e || 'code' in e || 'moreInfo' in e) {
      const rawMessage = typeof e.message === 'string' ? e.message : 'Unknown error';
      return {
        status: typeof e.status === 'number' ? e.status : undefined,
        code: typeof e.code === 'number' ? e.code : undefined,
        message: maskPhoneNumbersInText(rawMessage),
        moreInfo: typeof e.moreInfo === 'string' ? e.moreInfo : undefined,
      };
    }
  }
  return null;
}

/**
 * Returns an official Twilio client instance
 */
export function getTwilioClient(): twilio.Twilio {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be defined in the environment.');
  }

  return twilio(accountSid, authToken);
}

/**
 * Validates incoming Twilio HTTP webhook and WebSocket signatures
 */
export function validateTwilioSignature(
  signature: string | undefined,
  url: string,
  params: Record<string, string> = {}
): boolean {
  if (process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION === 'true') {
    console.warn(
      '\n[SECURITY WARNING] PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION is true. Twilio signature verification is BYPASSED for development.\n'
    );
    return true;
  }

  if (!signature) {
    return false;
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('TWILIO_AUTH_TOKEN is missing for signature verification.');
    return false;
  }

  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Twilio signature validation error: ${msg}`);
    return false;
  }
}

/**
 * Generates TwiML connecting the call to Twilio ConversationRelay over WebSocket.
 * With no options the output is identical to the original outbound TwiML.
 *
 * `parameters` become <Parameter> children, delivered to the WebSocket in the `setup`
 * message as customParameters. They are descriptive only: the server never grants
 * access based on them (authorization lives in the server-side session record).
 */
export function generateConversationRelayTwiML(
  websocketUrl: string,
  options: { welcomeGreeting?: string; parameters?: Record<string, string> } = {}
): string {
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  const relay = connect.conversationRelay({
    url: websocketUrl,
    dtmfDetection: true,
    ...(options.welcomeGreeting ? { welcomeGreeting: options.welcomeGreeting } : {}),
  });
  for (const [name, value] of Object.entries(options.parameters ?? {})) {
    relay.parameter({ name, value });
  }
  return response.toString();
}

/** Short neutral refusal for callers who are not authorized, then hang up. */
export function generatePrivateLineTwiML(message: string): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say(message);
  response.hangup();
  return response.toString();
}

/**
 * Initiates an outbound Twilio phone call using strictly validated phone numbers
 */
export async function initiateTwilioCall(options: {
  client: twilio.Twilio;
  to: string;
  from: string;
  twimlUrl: string;
  statusCallbackUrl: string;
}): Promise<string> {
  const call = await options.client.calls.create({
    to: options.to,
    from: options.from,
    url: options.twimlUrl,
    statusCallback: options.statusCallbackUrl,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
    record: false, // Call recording strictly disabled
  });

  return call.sid;
}
