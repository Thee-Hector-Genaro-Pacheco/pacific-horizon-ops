import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { defaultVoiceStore, type VoiceStore } from './store.js';
import { defaultActionStore, type ActionStore } from '../actions/store.js';
import {
  generateConversationRelayTwiML,
  validateTwilioSignature,
} from './twilio.js';
import {
  getInitialGreeting,
  handleVoiceUtterance,
} from './conversation.js';

export interface VoiceServerOptions {
  port?: number;
  voiceStore?: VoiceStore;
  actionStore?: ActionStore;
  publicBaseUrl?: string;
  publicWssUrl?: string;
}

/**
 * Creates and configures the HTTP and WebSocket server for Twilio ConversationRelay
 */
export function createVoiceServer(options: VoiceServerOptions = {}) {
  const port = options.port || Number.parseInt(process.env.PHRO_VOICE_PORT || '3100', 10);
  const voiceStore = options.voiceStore || defaultVoiceStore;
  const actionStore = options.actionStore || defaultActionStore;

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

        // Base WSS URL: use env, configured option, or derive from host
        let wssBase =
          options.publicWssUrl ||
          process.env.PHRO_PUBLIC_WSS_URL ||
          (process.env.PHRO_PUBLIC_BASE_URL
            ? process.env.PHRO_PUBLIC_BASE_URL.replace(/^http/, 'ws')
            : `ws://${req.headers.host}`);

        // Ensure trailing slash removed
        wssBase = wssBase.replace(/\/$/, '');
        const websocketUrl = `${wssBase}/voice/ws?sessionId=${encodeURIComponent(sessionId)}`;

        const twimlXml = generateConversationRelayTwiML(websocketUrl);
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(twimlXml);
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

    const action = actionStore.getAction(session.actionId);
    if (!action) {
      ws.close(1008, 'Associated action not found');
      return;
    }

    voiceStore.updateSessionStatus(session.sessionId, 'CONNECTED');

    ws.on('message', async (data: Buffer | string) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        const msg = JSON.parse(raw);

        // Handle Twilio ConversationRelay message types
        if (msg.type === 'setup') {
          const callSid = msg.callSid || session.callSid;
          voiceStore.updateSessionStatus(session.sessionId, 'ACTIVE', { callSid });

          // Speak initial greeting
          const greeting = getInitialGreeting(action);
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
          return;
        }

        if (msg.type === 'prompt' && msg.voicePrompt) {
          const freshSession = voiceStore.getSession(sessionId) || session;
          const turn = await handleVoiceUtterance({
            session: freshSession,
            utterance: msg.voicePrompt,
            voiceStore,
            actionStore,
          });

          voiceStore.appendTranscript(session.sessionId, {
            role: 'agent',
            text: turn.responseText,
            timestamp: new Date().toISOString(),
          });

          sendRelayText(ws, turn.responseText);

          if (turn.endCall) {
            sendRelayEnd(ws);
            voiceStore.updateSessionStatus(session.sessionId, 'COMPLETED');
            ws.close(1000, 'Call completed normally');
          }
          return;
        }

        if (msg.type === 'interrupt') {
          // Caller interrupted audio output; ConversationRelay handles audio cutoff
          return;
        }
      } catch (err: unknown) {
        const errStr = err instanceof Error ? err.message : String(err);
        console.error(`[voice:server] Error processing message: ${errStr}`);
      }
    });

    ws.on('close', () => {
      const freshSession = voiceStore.getSession(sessionId);
      if (freshSession && freshSession.status !== 'COMPLETED' && freshSession.status !== 'FAILED') {
        voiceStore.updateSessionStatus(sessionId, 'COMPLETED', {
          reason: 'WebSocket closed',
        });
      }
    });

    ws.on('error', (err) => {
      console.error(`[voice:server] WebSocket error on session ${sessionId}:`, err);
      voiceStore.updateSessionStatus(sessionId, 'FAILED', {
        error: err.message,
      });
    });
  });

  function start(): Promise<void> {
    return new Promise((resolve) => {
      server.listen(port, () => {
        console.log(`\n==============================================`);
        console.log(`       PHRO Voice Gateway (PHRO-003)         `);
        console.log(`==============================================`);
        console.log(`Server listening on port ${port}`);
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

  return { server, wss, port, start, stop };
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

