import { DEFAULT_ORGANIZATION_ID } from '../knowledge/db.js';
import type { VoiceSession } from '../voice/types.js';
import { defaultQueryRewriter, type CanonicalQuery } from './canonicalize.js';
import { followUpTrace, type FollowUpResolution } from './followUp.js';
import { AgentHarness } from './harness.js';
import { routeIntentDeterministic } from './intents.js';
import { sessionContextFromVoice } from './session.js';
import type { HarnessDeps } from './tools.js';
import { FileTraceRecorder } from './trace.js';
import { createAgentRequest, type AgentRequest, type IntentName, type IntentResult } from './types.js';

type ReadToolId = 'knowledge.search' | 'calendar.read' | 'calendar.conflicts' | 'gmail.read' | 'photobooth.analytics';
type ReadFollowUp = Extract<FollowUpResolution, { kind: 'read' }>;

const TOOL_INTENT: Record<ReadToolId, IntentName> = {
  'knowledge.search': 'knowledge.query',
  'calendar.read': 'calendar.schedule',
  'calendar.conflicts': 'calendar.conflicts',
  'gmail.read': 'gmail.inbox',
  'photobooth.analytics': 'photobooth.analytics',
};
const DOMAIN_OF_TOOL: Record<ReadToolId, IntentResult['domain']> = {
  'knowledge.search': 'knowledge',
  'calendar.read': 'calendar',
  'calendar.conflicts': 'calendar',
  'gmail.read': 'gmail',
  'photobooth.analytics': 'photo_booth',
};

function voiceRequest(session: VoiceSession, utterance: string): AgentRequest {
  return createAgentRequest({
    sessionId: session.sessionId,
    organizationId: DEFAULT_ORGANIZATION_ID,
    channel: 'voice',
    actor: { kind: 'owner', id: 'owner' },
    input: utterance.slice(0, 2000) || '(empty)',
  });
}

/**
 * The intent recorded for a voice read turn. The conversation layer only calls a read tool
 * after its own deterministic domain detector (or the follow-up resolver) matched, so the
 * trace names that intent instead of a misleading "unknown".
 */
function voiceIntent(toolId: ReadToolId, utterance: string, followUp?: ReadFollowUp): IntentResult {
  const read = (intent: IntentName, reason: string): IntentResult => ({ domain: DOMAIN_OF_TOOL[toolId], intent, confidence: 1, source: 'deterministic', highRisk: false, entities: { route: reason }, requestedScope: null });
  if (followUp) return read(followUp.intent, `follow_up:${followUp.reason}`);
  const det = routeIntentDeterministic(utterance);
  if (det.intent !== 'unknown' && !det.highRisk && DOMAIN_OF_TOOL[toolId] === det.domain) return det;
  return read(TOOL_INTENT[toolId], 'domain_detector');
}

/**
 * Voice adapter for read domains. The conversation layer has already routed the turn
 * deterministically; this runs the matching registered read tool through the harness
 * (policy, execution boundary, trace) and hands back the domain's own result so spoken
 * behaviour is unchanged. Mailbox drafting, approval and sending do not come through here.
 */
export async function runVoiceReadTool<R>(
  toolId: ReadToolId,
  opts: { session: VoiceSession; utterance: string; previous: unknown; deps: HarnessDeps; dataDir: string; followUp?: ReadFollowUp }
): Promise<R | null> {
  const harness = new AgentHarness({ deps: opts.deps, recorder: new FileTraceRecorder(opts.dataDir) });
  const request = voiceRequest(opts.session, opts.utterance);
  const session = sessionContextFromVoice(opts.session, { organizationId: DEFAULT_ORGANIZATION_ID });
  const { outcome } = await harness.runTool<R>(
    toolId,
    request,
    session,
    { question: request.input, ...(opts.previous ? { context: opts.previous } : {}) },
    'deterministic_command',
    { intent: voiceIntent(toolId, request.input, opts.followUp), followUp: opts.followUp ? followUpTrace(opts.followUp) : undefined }
  );
  return outcome?.ok ? outcome.result : null;
}

/**
 * Traces a voice turn that ran no tool: an acknowledgement, a clarification, or a reply
 * built from stored display-safe context (e.g. "where does it say that?").
 */
export function recordVoiceTurn(opts: {
  session: VoiceSession;
  utterance: string;
  dataDir: string;
  status: 'acknowledged' | 'needs_clarification' | 'answered';
  kind: 'acknowledgement' | 'clarification' | 'context_answer';
  reason: string;
  followUp?: ReadFollowUp;
}): void {
  const harness = new AgentHarness({ recorder: new FileTraceRecorder(opts.dataDir) });
  const intent: IntentResult | undefined = opts.followUp
    ? { domain: 'knowledge', intent: opts.followUp.intent, confidence: 1, source: 'deterministic', highRisk: false, entities: { route: `follow_up:${opts.followUp.reason}` }, requestedScope: null }
    : undefined;
  harness.recordTurn(voiceRequest(opts.session, opts.utterance), {
    status: opts.status,
    kind: opts.kind,
    reason: opts.reason,
    intent,
    followUp: opts.followUp ? followUpTrace(opts.followUp) : undefined,
  });
}

/**
 * Knowledge by voice: the harness canonicalizes the transcript (read-only), then grounds
 * with the canonical question. Returns the domain result, or a clarification to speak.
 */
export async function runVoiceKnowledge<R>(opts: {
  session: VoiceSession;
  utterance: string;
  lastQuestion: string | null;
  deps: HarnessDeps;
  dataDir: string;
  followUp?: ReadFollowUp;
}): Promise<{ result: R | null; clarification: string | null; canonical: CanonicalQuery }> {
  const k = opts.deps.knowledge;
  const rewriter = k?.rewrite !== undefined ? k.rewrite : k?.answer ? null : defaultQueryRewriter();
  const harness = new AgentHarness({ deps: opts.deps, recorder: new FileTraceRecorder(opts.dataDir), rewriter });
  const request = createAgentRequest({
    sessionId: opts.session.sessionId,
    organizationId: DEFAULT_ORGANIZATION_ID,
    channel: 'voice',
    actor: { kind: 'owner', id: 'owner' },
    input: opts.utterance.slice(0, 2000) || '(empty)',
  });
  const session = sessionContextFromVoice(opts.session, { organizationId: DEFAULT_ORGANIZATION_ID });
  const out = await harness.runKnowledgeQuery<R>(request, session, {
    lastQuestion: opts.lastQuestion,
    intent: voiceIntent('knowledge.search', request.input, opts.followUp),
    followUp: opts.followUp ? followUpTrace(opts.followUp) : undefined,
  });
  return { result: out.outcome?.ok ? out.outcome.result : null, clarification: out.clarification, canonical: out.canonical };
}
