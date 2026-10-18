import 'dotenv/config';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { defaultVoiceStore, type VoiceStore } from './store.js';
import { defaultActionStore, type ActionStore } from '../actions/store.js';
import { type ActionExecutor, DefaultActionExecutor } from '../actions/executor.js';
import {
  generateConversationRelayTwiML,
  generatePrivateLineTwiML,
  validateTwilioSignature,
} from './twilio.js';
import {
  INBOUND_OWNER_WELCOME,
  PRIVATE_LINE_MESSAGE,
  normalizeE164,
  ownerAuthorizerFromEnv,
  type InboundCallerAuthorizer,
} from './inbound.js';
import { maskPhoneNumber } from './types.js';
import {
  getInitialGreeting,
  handleVoiceUtterance,
} from './conversation.js';
import {
  fetchEligibleInboxMessages,
  formatMailboxGreeting,
  type EligibleInboxMessage,
} from './mailbox.js';
import { getAuthenticatedClient, getExpectedAccount } from '../auth.js';
import { PacificOpsRuntimeStore, estimatePlaybackMs } from '../runtime/pacificOpsRuntime.js';
import { VoicePresenceReporter, observeExecutor, type ReporterOptions, type RuntimeSink } from './presenceReporter.js';
import type { PhotoBoothVoiceDeps } from './analytics.js';

export interface VoiceServerOptions {
  port?: number;
  voiceStore?: VoiceStore;
  actionStore?: ActionStore;
  publicBaseUrl?: string;
  publicWssUrl?: string;
  endCallBufferMs?: number;
  executor?: ActionExecutor;
  mailboxMessages?: EligibleInboxMessage[];
  draftCreator?: (params: {
    to: string;
    subject: string;
    bodyText: string;
    threadId?: string;
  }) => Promise<{ draftId: string; messageId?: string; threadId?: string }>;
  /**
   * Where Pacific Ops runtime (presence) events go. Defaults to a runtime store beside the
   * voice store's data. Pass null to disable. Events are observational only.
   */
  runtime?: RuntimeSink | null;
  presenceOptions?: ReporterOptions;
  /** Decides who may enter an inbound session. Defaults to the owner caller-ID beta from env. */
  inboundAuthorizer?: InboundCallerAuthorizer;
  /** Read-only Photo Booth analytics dependencies. Defaults to env-configured clients. */
  photoBooth?: PhotoBoothVoiceDeps;
}

/**
 * Creates and configures the HTTP and WebSocket server for Twilio ConversationRelay
 */
export function createVoiceServer(options: VoiceServerOptions = {}) {
  const port = options.port !== undefined ? options.port : Number.parseInt(process.env.PHRO_VOICE_PORT || '3100', 10);
  const voiceStore = options.voiceStore || defaultVoiceStore;
  const actionStore = options.actionStore || defaultActionStore;
  const executor =
    options.executor !== undefined
      ? options.executor
      : options.actionStore
      ? undefined
      : new DefaultActionExecutor();
  const runtimeSink =
    options.runtime === undefined ? new PacificOpsRuntimeStore({ dataDir: voiceStore.getDataDir() }) : options.runtime;
  const presence = runtimeSink ? new VoicePresenceReporter(runtimeSink, voiceStore, options.presenceOptions) : null;

  /** Public WSS URL Twilio should connect ConversationRelay to for this session. */
  function relayUrlFor(req: http.IncomingMessage, sessionId: string): string {
    let wssBase =
      options.publicWssUrl ||
      process.env.PHRO_PUBLIC_WSS_URL ||
      (process.env.PHRO_PUBLIC_BASE_URL
        ? process.env.PHRO_PUBLIC_BASE_URL.replace(/^http/, 'ws')
        : `ws://${req.headers.host}`);
    wssBase = wssBase.replace(/\/$/, '');
    return `${wssBase}/voice/ws?sessionId=${encodeURIComponent(sessionId)}`;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      // Healthcheck
      if (pathname === '/health' || pathname === '/voice/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'phro-voice' }));
        return;
      }

      // POST /voice/twiml
      if (req.method === 'POST' && pathname === '/voice/twiml') {
        const body = await parseRequestBody(req);
        const signature = req.headers['x-twilio-signature'] as string | undefined;

        const requestUrl =
          (process.env.PHRO_PUBLIC_BASE_URL || `http://${req.headers.host}`) + req.url;

        // Twilio signature validation (fails closed)
        const isValid = validateTwilioSignature(signature, requestUrl, body);
        if (!isValid) {
          console.warn('[voice:server] Rejected invalid Twilio webhook signature on /voice/twiml');
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden: Invalid Twilio Signature');
          return;
        }

        const sessionId = parsedUrl.searchParams.get('sessionId') || body.sessionId;
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: Missing sessionId');
          return;
        }

        const session = voiceStore.getSession(sessionId);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found: VoiceSession not found');
          return;
        }

        const websocketUrl = relayUrlFor(req, sessionId);

        const twimlXml = generateConversationRelayTwiML(websocketUrl);
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(twimlXml);
        return;
      }

      // POST /voice/inbound — someone called the Pacific Ops number (e.g. "Hey Siri, call Pacific Ops").
      // Authorization is decided here, in the signed webhook, before any session exists.
      if (req.method === 'POST' && pathname === '/voice/inbound') {
        const body = await parseRequestBody(req);
        const signature = req.headers['x-twilio-signature'] as string | undefined;
        const requestUrl = (process.env.PHRO_PUBLIC_BASE_URL || `http://${req.headers.host}`) + req.url;

        if (!validateTwilioSignature(signature, requestUrl, body)) {
          console.warn('[voice:server] Rejected invalid Twilio webhook signature on /voice/inbound');
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden: Invalid Twilio Signature');
          return;
        }

        const authorizer = options.inboundAuthorizer ?? ownerAuthorizerFromEnv();
        const decision = authorizer.authorize({ from: body.From, to: body.To });
        const maskedFrom = normalizeE164(body.From) ? maskPhoneNumber(body.From) : 'unrecognized caller';

        if (!decision.authorized) {
          console.warn(`[voice:server] Inbound call refused (${decision.reason}) from ${maskedFrom}`);
          res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
          res.end(generatePrivateLineTwiML(PRIVATE_LINE_MESSAGE));
          return;
        }

        // Same session shape as an outbound mailbox call; only `direction` differs.
        const session = voiceStore.createSession({
          actionId: 'mailbox',
          toPhone: normalizeE164(body.To) ?? '',
          fromPhone: decision.identity.phoneE164,
          conversationState: 'MAILBOX_SELECTING',
          metadata: {
            mode: 'mailbox',
            direction: 'inbound',
            callerRole: decision.identity.role,
            callerAuthMethod: decision.identity.method,
          },
        });
        voiceStore.updateSessionStatus(session.sessionId, 'CREATED', {
          callSid: body.CallSid,
          actor: 'twilio:inbound',
          reason: `Inbound ${decision.identity.role} call authorized (${decision.identity.method})`,
        });
        console.log(`[voice:server] [session:${session.sessionId}] Inbound owner call authorized from ${maskedFrom}`);

        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(
          generateConversationRelayTwiML(relayUrlFor(req, session.sessionId), {
            welcomeGreeting: INBOUND_OWNER_WELCOME,
            parameters: { direction: 'inbound', mode: 'mailbox', callerRole: decision.identity.role },
          })
        );
        return;
      }

      // POST /voice/status
      if (req.method === 'POST' && pathname === '/voice/status') {
        const body = await parseRequestBody(req);
        const signature = req.headers['x-twilio-signature'] as string | undefined;
        const requestUrl =
          (process.env.PHRO_PUBLIC_BASE_URL || `http://${req.headers.host}`) + req.url;

        const isValid = validateTwilioSignature(signature, requestUrl, body);
        if (!isValid) {
          console.warn('[voice:server] Rejected invalid Twilio signature on /voice/status');
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        const sessionId = parsedUrl.searchParams.get('sessionId') || body.sessionId;
        const callSid = body.CallSid;
        const callStatus = body.CallStatus;

        if (sessionId) {
          const session = voiceStore.getSession(sessionId);
          if (session) {
            console.log(
              `[voice:server] [session:${sessionId}] Status callback: CallSid=${callSid || 'n/a'}, CallStatus=${callStatus}`
            );
            if (callStatus === 'in-progress' && session.status === 'CALL_REQUESTED') {
              voiceStore.updateSessionStatus(sessionId, 'ACTIVE', { callSid });
            } else if (callStatus === 'completed') {
              voiceStore.updateSessionStatus(sessionId, 'COMPLETED', { callSid });
            } else if (
              callStatus === 'failed' ||
              callStatus === 'busy' ||
              callStatus === 'no-answer' ||
              callStatus === 'canceled'
            ) {
              voiceStore.updateSessionStatus(sessionId, 'FAILED', {
                callSid,
                error: `Call ended with status: ${callStatus}`,
              });
              presence?.fault(sessionId, `Call not connected (${callStatus})`);
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<Response/>');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[voice:server] HTTP Error: ${msg}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (parsedUrl.pathname !== '/voice/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Validate WebSocket X-Twilio-Signature
      const signature = req.headers['x-twilio-signature'] as string | undefined;
      const requestUrl =
        (process.env.PHRO_PUBLIC_BASE_URL
          ? process.env.PHRO_PUBLIC_BASE_URL.replace(/^http/, 'ws')
          : `ws://${req.headers.host}`) + req.url;

      if (!validateTwilioSignature(signature, requestUrl, {})) {
        console.warn('[voice:server] Rejected WebSocket upgrade: invalid Twilio signature');
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const sessionId = parsedUrl.searchParams.get('sessionId');
      if (!sessionId || !voiceStore.getSession(sessionId)) {
        console.warn('[voice:server] Rejected WebSocket upgrade: unknown VoiceSession');
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (err: unknown) {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const sessionId = parsedUrl.searchParams.get('sessionId');

    if (!sessionId) {
      ws.close(1008, 'Missing sessionId');
      return;
    }

    const session = voiceStore.getSession(sessionId);
    if (!session) {
      ws.close(1008, 'Session not found');
      return;
    }

    // Inbound sessions only exist after the signed /voice/inbound webhook authorized the
    // caller. Re-check the server-side record (never client input) and refuse reuse.
    if (session.metadata?.direction === 'inbound') {
      if (session.metadata?.callerRole !== 'owner') {
        ws.close(1008, 'Unauthorized session');
        return;
      }
      if (session.status === 'COMPLETED' || session.status === 'FAILED') {
        ws.close(1008, 'Session already ended');
        return;
      }
    }

    const isMailboxMode = session.actionId === 'mailbox' || session.metadata?.mode === 'mailbox';
    const action = isMailboxMode ? null : actionStore.getAction(session.actionId);
    if (!isMailboxMode && !action) {
      ws.close(1008, 'Associated action not found');
      return;
    }

    console.log(
      `[voice:server] [session:${sessionId}] WebSocket connected. ${isMailboxMode ? 'Mailbox review session' : `Action: ${action?.actionId} (${action?.status})`}`
    );
    voiceStore.updateSessionStatus(session.sessionId, 'CONNECTED');
    presence?.sessionConnected(sessionId);
    // Execution is observed (not altered) so the Command Center can show EXECUTING / SUCCESS / ERROR.
    const sessionExecutor = executor && presence ? observeExecutor(executor, presence, sessionId) : executor;

    // Keep-alive ping interval to prevent proxy/tunnel idle disconnects
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 20000);

    let isEnding = false;

    ws.on('message', async (data: Buffer | string) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        const msg = JSON.parse(raw);
        console.log(`[voice:server] [session:${sessionId}] Received ConversationRelay message type: ${msg.type}`);

        // Handle Twilio ConversationRelay message types
        if (msg.type === 'setup') {
          const callSid = msg.callSid || session.callSid;
          const claimed = (msg.customParameters ?? {}) as Record<string, unknown>;
          const recordedDirection = (session.metadata?.direction as string | undefined) ?? 'outbound';
          if (claimed.direction !== undefined && claimed.direction !== recordedDirection) {
            // Custom parameters are descriptive; the session record is authoritative.
            console.warn(`[voice:server] [session:${sessionId}] Ignoring customParameters.direction that disagrees with the session record`);
          }
          voiceStore.updateSessionStatus(session.sessionId, 'ACTIVE', { callSid });

          if (isMailboxMode) {
            let messages =
              options.mailboxMessages ||
              (session.metadata?.availableMessages as EligibleInboxMessage[]) ||
              [];

            if (messages.length === 0) {
              try {
                const auth = await getAuthenticatedClient('business');
                const expectedEmail = getExpectedAccount('business');
                messages = await fetchEligibleInboxMessages(auth, { businessEmail: expectedEmail });
              } catch (err) {
                console.error('[voice:server] Failed to fetch mailbox messages:', err);
              }
            }

            const greeting = formatMailboxGreeting(messages);
            console.log(`[voice:server] [session:${sessionId}] Transitioning conversationState -> MAILBOX_SELECTING, sending mailbox greeting`);
            voiceStore.updateSessionMetadata(session.sessionId, {
              ...(session.metadata || {}),
              mode: 'mailbox',
              availableMessages: messages,
            });
            voiceStore.updateConversationState(session.sessionId, 'MAILBOX_SELECTING', {
              lastSpokenText: greeting,
              reason: 'Mailbox greeting sent on connection',
            });

            voiceStore.appendTranscript(session.sessionId, {
              role: 'agent',
              text: greeting,
              timestamp: new Date().toISOString(),
            });

            sendRelayText(ws, greeting);
            presence?.speaking(sessionId, greeting);
            return;
          }

          // Single action greeting
          const greeting = getInitialGreeting(action!);
          console.log(`[voice:server] [session:${sessionId}] Transitioning conversationState -> READY, sending greeting`);
          voiceStore.updateConversationState(session.sessionId, 'READY', {
            lastSpokenText: greeting,
            reason: 'Greeting sent on connection',
          });

          voiceStore.appendTranscript(session.sessionId, {
            role: 'agent',
            text: greeting,
            timestamp: new Date().toISOString(),
          });

          sendRelayText(ws, greeting);
          presence?.speaking(sessionId, greeting);
          return;
        }

        if (msg.type === 'prompt') {
          // If interim STT chunk (last === false), wait for the complete prompt
          if (msg.last === false) {
            if (!isEnding) presence?.ownerSpeaking(sessionId);
            console.log(`[voice:server] [session:${sessionId}] Interim prompt chunk ignored (waiting for last: true)`);
            return;
          }

          const utterance = typeof msg.voicePrompt === 'string' ? msg.voicePrompt.trim() : '';
          if (!utterance) {
            console.log(`[voice:server] [session:${sessionId}] Empty prompt received, ignoring`);
            return;
          }

          if (isEnding) {
            console.log(`[voice:server] [session:${sessionId}] Ignoring prompt because call is already terminating`);
            return;
          }

          const freshSession = voiceStore.getSession(sessionId) || session;
          console.log(`[voice:server] [session:${sessionId}] Processing prompt in state ${freshSession.conversationState}`);
          presence?.processing(sessionId);
          const turn = await handleVoiceUtterance({
            session: freshSession,
            utterance,
            voiceStore,
            actionStore,
            executor: sessionExecutor,
            draftCreator: options.draftCreator,
            photoBooth: options.photoBooth,
            onProgress: (progressText, progressOpts) => {
              console.log(`[voice:server] [session:${sessionId}] Spoken progress: "${progressText}"`);
              voiceStore.appendTranscript(session.sessionId, {
                role: 'agent',
                text: progressText,
                timestamp: new Date().toISOString(),
              });
              sendRelayText(ws, progressText);
              presence?.speaking(sessionId, progressText, { stillWorking: progressOpts?.stillWorking });
            },
          });

          const stateAfter = voiceStore.getSession(sessionId)?.conversationState;
          console.log(`[voice:server] [session:${sessionId}] Handled utterance -> state: ${stateAfter}, endCall: ${turn.endCall}`);

          voiceStore.appendTranscript(session.sessionId, {
            role: 'agent',
            text: turn.responseText,
            timestamp: new Date().toISOString(),
          });

          sendRelayText(ws, turn.responseText);
          presence?.speaking(sessionId, turn.responseText, { final: turn.endCall });

          if (turn.endCall) {
            isEnding = true;
            // Allow adequate time for ConversationRelay TTS synthesis & verbal playback before sending end
            const playbackBufferMs =
              options.endCallBufferMs !== undefined
                ? options.endCallBufferMs
                : estimatePlaybackMs(turn.responseText);
            const graceTimeoutMs =
              options.endCallBufferMs !== undefined ? Math.min(50, options.endCallBufferMs) : 1500;

            console.log(
              `[voice:server] [session:${sessionId}] Call completion initiated. Playing verbal acknowledgement (buffer: ${playbackBufferMs}ms)...`
            );
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                console.log(`[voice:server] [session:${sessionId}] Sending ConversationRelay end message`);
                sendRelayEnd(ws);
                // Give Twilio a short grace window to complete teardown
                setTimeout(() => {
                  if (ws.readyState === WebSocket.OPEN) {
                    console.log(`[voice:server] [session:${sessionId}] Gracefully closing WebSocket`);
                    ws.close(1000, 'Call completed normally');
                  }
                }, graceTimeoutMs);
              }
              voiceStore.updateSessionStatus(session.sessionId, 'COMPLETED');
            }, playbackBufferMs);
          }
          return;
        }

        if (msg.type === 'interrupt') {
          console.log(`[voice:server] [session:${sessionId}] Caller interrupted audio playback`);
          presence?.ownerSpeaking(sessionId);
          return;
        }

        if (msg.type === 'error') {
          console.error(`[voice:server] [session:${sessionId}] ConversationRelay error:`, msg.description || msg);
          presence?.fault(sessionId, 'Voice relay reported an error');
          return;
        }

        if (msg.type === 'dtmf') {
          console.log(`[voice:server] [session:${sessionId}] DTMF received: ${msg.digit || 'unknown'}`);
          return;
        }
      } catch (err: unknown) {
        const errStr = err instanceof Error ? err.message : String(err);
        console.error(`[voice:server] [session:${sessionId}] Error processing message: ${errStr}`);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(
        `[voice:server] [session:${sessionId}] WebSocket closed (code: ${code}, reason: ${reason?.toString() || 'none'})`
      );
      clearInterval(pingInterval);
      presence?.sessionEnded(sessionId);
      const freshSession = voiceStore.getSession(sessionId);
      if (freshSession && freshSession.status !== 'COMPLETED' && freshSession.status !== 'FAILED') {
        voiceStore.updateSessionStatus(sessionId, 'COMPLETED', {
          reason: `WebSocket closed (${code})`,
        });
      }
    });

    ws.on('error', (err) => {
      console.error(`[voice:server] [session:${sessionId}] WebSocket error:`, err);
      clearInterval(pingInterval);
      voiceStore.updateSessionStatus(sessionId, 'FAILED', {
        error: err.message,
      });
      presence?.fault(sessionId, 'Voice connection error');
    });
  });

  function start(): Promise<void> {
    return new Promise((resolve) => {
      server.listen(port, () => {
        presence?.gatewayOnline();
        console.log(`\n==============================================`);
        console.log(`       PHRO Voice Gateway (PHRO-003)         `);
        console.log(`==============================================`);
        console.log(`Server listening on port ${port}`);
        console.log(`TWILIO_AUTH_TOKEN present: ${process.env.TWILIO_AUTH_TOKEN ? 'YES' : 'NO'}`);
        console.log(`HTTP Endpoints:`);
        console.log(`  POST /voice/twiml?sessionId=<sessionId>`);
        console.log(`  POST /voice/status?sessionId=<sessionId>`);
        console.log(`WebSocket Endpoint:`);
        console.log(`  WS   /voice/ws?sessionId=<sessionId>\n`);
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(() => {
          resolve();
        });
      });
    });
  }

  function getPort(): number {
    const addr = server.address() as AddressInfo | null;
    return addr?.port || port;
  }

  return { server, wss, port, getPort, start, stop };
}

function sendRelayText(ws: WebSocket, text: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'text',
        token: text,
        last: true,
      })
    );
  }
}

function sendRelayEnd(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'end',
      })
    );
  }
}

function parseRequestBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        // Try urlencoded first (Twilio default)
        const params = new URLSearchParams(body);
        const result: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
          result[key] = value;
        }
        resolve(result);
      } catch {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({});
        }
      }
    });
  });
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const { start } = createVoiceServer();
  start().catch((err) => {
    console.error('Failed to start Voice Server:', err);
    process.exit(1);
  });
}

