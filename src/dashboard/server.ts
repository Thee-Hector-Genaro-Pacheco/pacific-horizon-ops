import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { resolveTokenPath, getExpectedAccount } from '../auth.js';
import { loadSnapshot, snapshotFingerprint, DATA_FILES } from './sources.js';
import { buildReadModel, type ReadModel } from './readModel.js';
import type { ChangeEventDTO, Envelope, RuntimeStateDTO, SystemComponentDTO, SystemHealthDTO } from './types.js';
import { readRuntimeState, resolveRuntimeState, RUNTIME_FILES, type ResolvedRuntimeState } from '../runtime/pacificOpsRuntime.js';
import { buildCalendarHub, CalendarHubRequestError } from '../calendar/hub.js';
import { calendarSourcesFromRegistry, type CalendarSource } from '../calendar/multi.js';
import { parseLocalDate } from '../calendar/time.js';
import { DEFAULT_ORGANIZATION_ID, KnowledgeError, createPgDb, loadKnowledgeDbConfig, type SqlDb } from '../knowledge/db.js';
import { createEmbeddingProvider, type EmbeddingProvider } from '../knowledge/embeddings.js';
import { migrate } from '../knowledge/migrations.js';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { knowledgeStatus } from '../knowledge/status.js';
import type { AgentTraceDTO, KnowledgeSearchDTO, KnowledgeStatusDTO } from './types.js';
import { readTraces } from '../agent/trace.js';
import type { CalendarHubView } from './types.js';

// The DTO is the wire shape of the resolved runtime; keep them structurally identical.
const _runtimeShape: (r: ResolvedRuntimeState) => RuntimeStateDTO = (r) => r;
void _runtimeShape;

/**
 * Pacific Rising Ops — Command Center API.
 *
 * Read-only by design: every route is GET, nothing here can approve, send, call or
 * mutate store files. Approvals continue to flow exclusively through the existing
 * voice and CLI paths, which own the deterministic action state machine.
 *
 * Binds to 127.0.0.1 by default; the API serves owner business data and has no auth layer.
 */

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  baseDir?: string;
  staticDir?: string | null;
  voiceHealthUrl?: string | null;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Read-only Calendar sources for the Calendar Hub. Defaults to the Google profile registry. */
  calendarSources?: () => { sources: CalendarSource[]; timeZone: string };
  /** Read-only knowledge store access. Defaults to PHRO_KNOWLEDGE_DATABASE_URL; null if unset. */
  knowledge?: () => { db: SqlDb; embedder: EmbeddingProvider | null; organizationId: string } | null;
}

const RECENT_SUCCESS_MS = 24 * 60 * 60 * 1000;

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createDashboardServer(options: DashboardServerOptions = {}) {
  const env = options.env ?? process.env;
  const port = options.port ?? Number.parseInt(env.PHRO_DASHBOARD_PORT || '3200', 10);
  const host = options.host ?? env.PHRO_DASHBOARD_HOST ?? '127.0.0.1';
  const baseDir = options.baseDir ?? process.cwd();
  const dataDir = options.dataDir ?? path.resolve(baseDir, 'data');
  const staticDir =
    options.staticDir === undefined ? path.resolve(baseDir, 'web', 'dist') : options.staticDir;
  const voicePort = env.PHRO_VOICE_PORT || '3100';
  const voiceHealthUrl =
    options.voiceHealthUrl === undefined ? `http://127.0.0.1:${voicePort}/health` : options.voiceHealthUrl;
  const now = options.now ?? Date.now;

  let cache: { fingerprint: string; model: ReadModel; builtAt: number } | null = null;

  function model(): ReadModel {
    const fingerprint = snapshotFingerprint(dataDir);
    // Rebuild when files change, and at least every 30s so time-relative state (presence, staleness) stays honest.
    if (!cache || cache.fingerprint !== fingerprint || now() - cache.builtAt > 30_000) {
      const ownerEmails = [env.PHRO_GMAIL_BUSINESS_ACCOUNT, env.PHRO_GMAIL_PERSONAL_ACCOUNT].filter(
        (e): e is string => !!e?.trim()
      );
      cache = {
        fingerprint,
        model: buildReadModel(loadSnapshot(dataDir), { now: now(), ownerEmails }),
        builtAt: now(),
      };
    }
    return cache.model;
  }

  async function probeVoice(): Promise<boolean> {
    if (!voiceHealthUrl) return false;
    try {
      const res = await fetch(voiceHealthUrl, { signal: AbortSignal.timeout(800) });
      return res.ok;
    } catch {
      return false;
    }
  }

  function hasRefreshableToken(): boolean {
    try {
      const { tokenPath } = resolveTokenPath('business', baseDir);
      if (!fs.existsSync(tokenPath)) return false;
      const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) as Record<string, unknown>;
      // Only presence is checked; token values never leave this function.
      return typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0;
    } catch {
      return false;
    }
  }

  async function health(): Promise<SystemHealthDTO> {
    const m = model();
    const checkedAt = new Date(now()).toISOString();
    const t = now();
    const within = (iso: string | null | undefined) => !!iso && t - new Date(iso).getTime() < RECENT_SUCCESS_MS;

    const lastGmailSuccess = m.activity.find(
      (a) => a.kind === 'email_sent' || a.kind === 'draft_generated' || a.kind === 'email_triaged'
    )?.at;
    const tokenOk = hasRefreshableToken();
    const accountBound = !!getExpectedAccount('business');
    const gmail: SystemComponentDTO = {
      key: 'gmail',
      label: 'Gmail',
      status: !tokenOk ? 'offline' : within(lastGmailSuccess) ? 'online' : 'configured',
      detail: !tokenOk
        ? 'No business token on file'
        : within(lastGmailSuccess)
          ? 'Business account · recent activity'
          : accountBound
            ? 'Business account bound · idle'
            : 'Token on file · account binding not set',
      checkedAt,
    };

    const twilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER_E164);
    const lastConnectedCall = m.calls.find((c) => c.relay === 'connected');
    const twilio: SystemComponentDTO = {
      key: 'twilio',
      label: 'Twilio',
      status: !twilioConfigured ? 'offline' : within(lastConnectedCall?.startedAt) ? 'online' : 'configured',
      detail: !twilioConfigured
        ? 'Credentials not configured'
        : within(lastConnectedCall?.startedAt)
          ? 'Calls connecting'
          : 'Credentials present',
      checkedAt,
    };

    const voiceUp = await probeVoice();
    const voice: SystemComponentDTO = {
      key: 'voice',
      label: 'Pacific Ops',
      status: voiceUp ? 'online' : 'offline',
      detail: voiceUp ? 'Voice gateway responding' : 'Voice gateway not running locally',
      checkedAt,
    };

    const agentConfigured = !!env.ANTHROPIC_API_KEY;
    const agent: SystemComponentDTO = {
      key: 'agent',
      label: 'Agent',
      status: agentConfigured ? (within(m.commandCenter.lastAgentRunAt) ? 'online' : 'configured') : 'offline',
      detail: agentConfigured
        ? m.commandCenter.lastAgentRunAt
          ? 'Classifier ready'
          : 'Classifier ready · no runs yet'
        : 'Model key not configured',
      checkedAt,
    };

    const components = [gmail, twilio, voice, agent];
    const offline = components.filter((c) => c.status === 'offline').length;
    return {
      overall: offline === 0 ? 'healthy' : offline >= 3 ? 'down' : 'degraded',
      components,
    };
  }

  /* ----------------------- Pacific Ops runtime ----------------------- */

  let voiceGateway: RuntimeStateDTO['voiceGateway'] = 'unknown';
  let voiceCheckedAt = 0;
  async function gatewayStatus(): Promise<RuntimeStateDTO['voiceGateway']> {
    if (!voiceHealthUrl) return 'unknown';
    if (now() - voiceCheckedAt > 5_000) {
      voiceCheckedAt = now();
      voiceGateway = (await probeVoice()) ? 'online' : 'offline';
    }
    return voiceGateway;
  }

  async function runtimeNow(): Promise<RuntimeStateDTO> {
    return resolveRuntimeState(readRuntimeState(dataDir), { now: now(), voiceGateway: await gatewayStatus() });
  }

  const runtimeClients = new Set<http.ServerResponse>();
  let lastRuntime = '';
  let runtimePushing = false;
  async function pushRuntime(): Promise<void> {
    if (runtimeClients.size === 0 || runtimePushing) return;
    runtimePushing = true;
    try {
      const payload = JSON.stringify(await runtimeNow());
      if (payload === lastRuntime) return;
      lastRuntime = payload;
      for (const res of runtimeClients) res.write(`event: runtime\ndata: ${payload}\n\n`);
    } finally {
      runtimePushing = false;
    }
  }
  // File watching delivers changes immediately; this tick covers hold/stale decay, voice
  // gateway restarts and platforms where fs.watch is unreliable. Reads one small file.
  const runtimeTick = setInterval(() => void pushRuntime(), 1_000);
  runtimeTick.unref();

  /* ---------------------------- SSE ---------------------------- */

  const clients = new Set<http.ServerResponse>();
  let watcher: fs.FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let pendingTopics = new Set<ChangeEventDTO['topics'][number]>();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': keep-alive\n\n');
    for (const res of runtimeClients) res.write(': keep-alive\n\n');
  }, 25_000);
  heartbeat.unref();

  function topicsFor(fileName: string): ChangeEventDTO['topics'] {
    if (fileName.startsWith(DATA_FILES.actions) || fileName.startsWith(DATA_FILES.actionEvents)) {
      return ['actions', 'inbox', 'activity'];
    }
    if (fileName.startsWith(DATA_FILES.sessions) || fileName.startsWith(DATA_FILES.voiceEvents)) {
      return ['calls', 'activity', 'inbox'];
    }
    if (fileName.startsWith(DATA_FILES.runs)) return ['inbox', 'activity'];
    if (fileName.startsWith('mailbox-cleanup')) return ['activity'];
    return [];
  }

  function ensureWatcher() {
    if (watcher || !fs.existsSync(dataDir)) return;
    try {
      watcher = fs.watch(dataDir, (_event, fileName) => {
        if (!fileName) return;
        const name = fileName.toString();
        if (name.includes('.tmp.')) return;
        if (name === RUNTIME_FILES.state) {
          void pushRuntime();
          return;
        }
        for (const topic of topicsFor(name)) pendingTopics.add(topic);
        if (pendingTopics.size === 0) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const payload: ChangeEventDTO = { at: new Date(now()).toISOString(), topics: [...pendingTopics] };
          pendingTopics = new Set();
          for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
        }, 250);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  /* --------------------------- Routes --------------------------- */

  function send<T>(res: http.ServerResponse, status: number, data: T) {
    const envelope: Envelope<T> = { data, generatedAt: new Date(now()).toISOString(), source: 'live' };
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(envelope));
  }

  function notFound(res: http.ServerResponse, what = 'Not found') {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: what }));
  }

  // Knowledge store: opened lazily, migrated once, shared across requests.
  let knowledgeDeps: { db: SqlDb; embedder: EmbeddingProvider | null; organizationId: string; ready: Promise<unknown> } | null | undefined;
  function knowledge() {
    if (knowledgeDeps === undefined) {
      const injected = options.knowledge;
      if (injected) {
        const d = injected();
        knowledgeDeps = d ? { ...d, ready: migrate(d.db) } : null;
      } else if (!env.PHRO_KNOWLEDGE_DATABASE_URL?.trim()) {
        knowledgeDeps = null;
      } else {
        const db = createPgDb(loadKnowledgeDbConfig(env));
        knowledgeDeps = {
          db,
          embedder: createEmbeddingProvider(env),
          organizationId: env.PHRO_ORGANIZATION_ID?.trim() || DEFAULT_ORGANIZATION_ID,
          ready: migrate(db),
        };
      }
    }
    return knowledgeDeps;
  }

  function emptyKnowledgeStatus(database: KnowledgeStatusDTO['database'], detail: string | null): KnowledgeStatusDTO {
    return { database, detail, organizationId: DEFAULT_ORGANIZATION_ID, sources: 0, documents: 0, chunks: 0, chunksWithVectors: 0, embedding: null, lastIngestion: null, recentQueries: [] };
  }

  async function handleKnowledge(sub: string | undefined, url: URL, res: http.ServerResponse) {
    const k = knowledge();
    if (sub === 'status') {
      if (!k) return send(res, 200, emptyKnowledgeStatus('not_configured', 'Set PHRO_KNOWLEDGE_DATABASE_URL to enable the knowledge store.'));
      try {
        await k.ready;
        const s = await knowledgeStatus(k.db, k.organizationId, k.embedder);
        return send(res, 200, { ...s, detail: null } satisfies KnowledgeStatusDTO);
      } catch (err) {
        knowledgeDeps = undefined; // retry migration/connection on the next request
        return send(res, 200, emptyKnowledgeStatus('offline', err instanceof KnowledgeError ? err.message : 'Knowledge database is unavailable.'));
      }
    }
    if (sub === 'search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q || q.length > 500) return badRequest(res, 'q is required (max 500 characters)');
      if (!k) {
        res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Knowledge store is not configured.' }));
        return;
      }
      try {
        await k.ready;
        const r = await retrieveKnowledge(k.db, k.embedder, { organizationId: k.organizationId, query: q, limit: 8 });
        const body: KnowledgeSearchDTO = {
          query: q,
          mode: r.mode,
          degraded: r.degraded,
          latencyMs: r.latencyMs,
          results: r.results.map((x, i) => ({
            rank: i + 1,
            title: x.title,
            section: x.section,
            sourceLabel: x.sourceLabel,
            excerpt: x.text.slice(0, 400),
            score: x.score,
            coverage: x.coverage,
            lexicalScore: x.lexicalScore,
            vectorScore: x.vectorScore,
          })),
        };
        return send(res, 200, body);
      } catch {
        knowledgeDeps = undefined;
        res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Knowledge database is unavailable.' }));
        return;
      }
    }
    return notFound(res);
  }

  function badRequest(res: http.ServerResponse, message: string) {
    res.writeHead(400, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
  }

  async function handleApi(pathname: string, url: URL, res: http.ServerResponse, req: http.IncomingMessage) {
    const parts = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const [resource, id] = parts.map(decodeURIComponent);
    const m = model();

    switch (resource) {
      case 'health':
        return send(res, 200, await health());
      case 'command-center':
        return send(res, 200, m.commandCenter);
      case 'inbox': {
        if (!id) return send(res, 200, m.inbox);
        const item = m.inbox.find((i) => i.id === id);
        return item ? send(res, 200, item) : notFound(res);
      }
      case 'actions': {
        if (!id) return send(res, 200, m.actions);
        const action = m.actions.find((a) => a.id === id);
        return action ? send(res, 200, action) : notFound(res);
      }
      case 'calls': {
        if (!id) return send(res, 200, m.calls);
        const call = m.calls.find((c) => c.id === id);
        return call ? send(res, 200, call) : notFound(res);
      }
      case 'activity': {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
        return send(res, 200, m.activity.slice(0, limit));
      }
      case 'leads':
        return send(res, 200, m.leads);
      case 'customers': {
        if (!id) return send(res, 200, m.customers);
        const customer = m.customers.find((c) => c.id === id);
        return customer ? send(res, 200, customer) : notFound(res);
      }
      case 'analytics':
        return send(res, 200, m.analytics);
      case 'knowledge':
        return handleKnowledge(id, url, res);
      case 'agent': {
        if (id !== 'traces') return notFound(res);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
        // Traces are redacted when written; only display fields are returned (no session/request IDs).
        const traces: AgentTraceDTO[] = readTraces(dataDir, limit).map((t) => ({
          traceId: t.traceId,
          at: t.at,
          channel: t.channel,
          inputPreview: t.inputPreview,
          // Only knowledge rewrites carry a canonical preview; mutation text is never rewritten.
          normalization:
            t.normalization && t.intent.intent === 'knowledge.query'
              ? { changed: t.normalization.changed, confidence: t.normalization.confidence, method: t.normalization.method, canonicalPreview: t.normalization.canonicalPreview }
              : null,
          followUp: t.followUp ?? null,
          resolution: t.resolution ?? null,
          resolvedDomain: t.resolvedDomain ?? null,
          responseDomain: t.responseDomain ?? null,
          intent: t.intent,
          plan: t.plan,
          providersInvoked: t.providersInvoked,
          toolsConsidered: t.toolsConsidered,
          policy: t.policy,
          approvalRequired: t.approvalRequired,
          toolOutcome: t.toolOutcome,
          latencyMs: t.latencyMs,
          status: t.status,
          dryRun: t.dryRun,
        }));
        return send(res, 200, traces);
      }
      case 'calendar': {
        const viewParam = url.searchParams.get('view') ?? 'today';
        if (!['month', 'week', 'day', 'upcoming', 'today'].includes(viewParam)) return badRequest(res, 'view must be month, week, day, upcoming or today');
        const dateParam = url.searchParams.get('date');
        const anchor = dateParam ? parseLocalDate(dateParam) : null;
        if (dateParam && !anchor) return badRequest(res, 'date must be YYYY-MM-DD');
        const sourceIds = (url.searchParams.get('sources') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        let configured: { sources: CalendarSource[]; timeZone: string };
        try {
          configured = (options.calendarSources ?? (() => calendarSourcesFromRegistry('all', { env })))();
        } catch (err) {
          res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Calendar is not configured: ${err instanceof Error ? err.message : 'unknown error'}` }));
          return;
        }
        try {
          const hub = await buildCalendarHub({
            ...configured,
            now: new Date(now()),
            view: viewParam as CalendarHubView,
            anchor,
            sourceIds,
            sessions: loadSnapshot(dataDir).sessions,
          });
          return send(res, 200, hub);
        } catch (err) {
          if (err instanceof CalendarHubRequestError) return badRequest(res, err.message);
          throw err;
        }
      }
      case 'runtime': {
        if (id === 'state') return send(res, 200, await runtimeNow());
        if (id !== 'events') return notFound(res);
        ensureWatcher();
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        // Every new subscriber gets the current state immediately; no waiting for the next event.
        const current = JSON.stringify(await runtimeNow());
        lastRuntime = current;
        res.write(`event: runtime\ndata: ${current}\n\n`);
        runtimeClients.add(res);
        req.on('close', () => runtimeClients.delete(res));
        return;
      }
      case 'stream': {
        ensureWatcher();
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write('retry: 5000\n\n');
        res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date(now()).toISOString() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      default:
        return notFound(res);
    }
  }

  function serveStatic(pathname: string, res: http.ServerResponse) {
    if (!staticDir || !fs.existsSync(staticDir)) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Pacific Rising Ops API is running. Build the Command Center with `npm run web:build`, or run `npm run web:dev`.');
      return;
    }
    const root = path.resolve(staticDir);
    const requested = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    const inside = requested === root || requested.startsWith(root + path.sep);
    let target = inside && fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : null;
    // SPA fallback for client-side routes (no extension).
    if (!target && inside && !path.extname(pathname)) target = path.join(root, 'index.html');
    if (!target || !fs.existsSync(target)) return notFound(res);

    const ext = path.extname(target);
    const immutable = target.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed: the Command Center API is read-only');
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(url.pathname, url, res, req);
        return;
      }
      serveStatic(url.pathname, res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dashboard] ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });

  function start(): Promise<void> {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        console.log(`Pacific Rising Ops — Command Center API on http://${host}:${getPort()} (read-only)`);
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    clearInterval(heartbeat);
    clearInterval(runtimeTick);
    for (const res of runtimeClients) res.end();
    runtimeClients.clear();
    if (debounce) clearTimeout(debounce);
    watcher?.close();
    for (const res of clients) res.end();
    clients.clear();
    // Close a knowledge pool this server opened itself (injected stores are owned by the caller).
    if (knowledgeDeps && !options.knowledge) void knowledgeDeps.db.close().catch(() => {});
    knowledgeDeps = undefined;
    return new Promise((resolve) => server.close(() => resolve()));
  }

  function getPort(): number {
    const addr = server.address() as AddressInfo | null;
    return addr?.port ?? port;
  }

  return { server, start, stop, getPort, health, model };
}

if (process.argv[1]?.endsWith(`dashboard${path.sep}server.ts`) || process.argv[1]?.endsWith(`dashboard${path.sep}server.js`)) {
  createDashboardServer()
    .start()
    .catch((err) => {
      console.error('Failed to start Command Center API:', err);
      process.exit(1);
    });
}
