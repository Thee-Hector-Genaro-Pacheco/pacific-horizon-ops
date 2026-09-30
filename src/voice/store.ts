import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type VoiceSession,
  type VoiceEvent,
  type VoiceSessionStatus,
  type VoiceConversationState,
  type TranscriptEntry,
  VoiceSessionSchema,
  maskPhoneNumber,
} from './types.js';

export interface VoiceStoreOptions {
  dataDir?: string;
  sessionsFilePath?: string;
  eventsFilePath?: string;
}

export class VoiceStore {
  private readonly dataDir: string;
  private readonly sessionsFilePath: string;
  private readonly eventsFilePath: string;

  constructor(options: VoiceStoreOptions = {}) {
    this.dataDir = options.dataDir || path.resolve(process.cwd(), 'data');
    this.sessionsFilePath =
      options.sessionsFilePath || path.join(this.dataDir, 'voice-sessions.json');
    this.eventsFilePath =
      options.eventsFilePath || path.join(this.dataDir, 'voice-events.jsonl');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Loads all voice sessions from voice-sessions.json
   */
  public loadSessions(): Map<string, VoiceSession> {
    this.ensureDir();
    if (!fs.existsSync(this.sessionsFilePath)) {
      return new Map();
    }

    try {
      const raw = fs.readFileSync(this.sessionsFilePath, 'utf-8');
      if (!raw.trim()) {
        return new Map();
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return new Map();
      }

      const map = new Map<string, VoiceSession>();
      for (const item of parsed) {
        const validated = VoiceSessionSchema.parse(item);
        map.set(validated.sessionId, validated);
      }
      return map;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load voice sessions from ${this.sessionsFilePath}: ${msg}`);
    }
  }

  /**
   * Safely writes voice sessions map using temp-file + atomic rename pattern
   */
  private persistSessions(sessions: Map<string, VoiceSession>): void {
    this.ensureDir();
    const list = Array.from(sessions.values());
    const serialized = JSON.stringify(list, null, 2);

    const tempFilePath = path.join(
      this.dataDir,
      `voice-sessions.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`
    );

    fs.writeFileSync(tempFilePath, serialized, 'utf-8');
    fs.renameSync(tempFilePath, this.sessionsFilePath);
  }

  /**
   * Appends an audit event to voice-events.jsonl
   */
  public appendEvent(event: VoiceEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.eventsFilePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }

  /**
   * Finds a session by sessionId
   */
  public getSession(sessionId: string): VoiceSession | undefined {
    return this.loadSessions().get(sessionId);
  }

  /**
   * Finds a session by callSid
   */
  public findSessionByCallSid(callSid: string): VoiceSession | undefined {
    for (const session of this.loadSessions().values()) {
      if (session.callSid === callSid) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Finds an active session for an actionId
   */
  public findActiveSessionByActionId(actionId: string): VoiceSession | undefined {
    for (const session of this.loadSessions().values()) {
      if (
        session.actionId === actionId &&
        session.status !== 'COMPLETED' &&
        session.status !== 'FAILED'
      ) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Lists all sessions, optionally filtered by status
   */
  public listSessions(filter?: { status?: VoiceSessionStatus }): VoiceSession[] {
    const list = Array.from(this.loadSessions().values());
    if (filter?.status) {
      return list.filter((s) => s.status === filter.status);
    }
    return list;
  }

  /**
   * Creates a new VoiceSession in CREATED status
   */
  public createSession(params: {
    actionId: string;
    toPhone: string;
    fromPhone: string;
  }): VoiceSession {
    const sessionId = `vses_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const session: VoiceSession = {
      sessionId,
      actionId: params.actionId,
      callSid: null,
      status: 'CREATED',
      conversationState: 'GREETING',
      toPhone: params.toPhone,
      fromPhone: params.fromPhone,
      lastSpokenText: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
      transcript: [],
    };

    const sessions = this.loadSessions();
    sessions.set(sessionId, session);
    this.persistSessions(sessions);

    this.appendEvent({
      eventId: `vevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      sessionId,
      actionId: params.actionId,
      timestamp: now,
      fromStatus: null,
      toStatus: 'CREATED',
      conversationState: 'GREETING',
      actor: 'system:voice',
      reason: 'Voice session created for action review',
      metadata: { toPhone: maskPhoneNumber(params.toPhone), fromPhone: maskPhoneNumber(params.fromPhone) },
    });

    return session;
  }

  /**
   * Updates session status and persists change with an audit event
   */
  public updateSessionStatus(
    sessionId: string,
    status: VoiceSessionStatus,
    options?: {
      callSid?: string;
      error?: string;
      reason?: string;
      actor?: string;
      conversationState?: VoiceConversationState;
    }
  ): VoiceSession {
    const sessions = this.loadSessions();
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`VoiceSession "${sessionId}" not found.`);
    }

    const now = new Date().toISOString();
    const prevStatus = session.status;
    session.status = status;
    session.updatedAt = now;

    if (options?.callSid) {
      session.callSid = options.callSid;
    }
    if (options?.error) {
      session.error = options.error;
    }
    if (options?.conversationState) {
      session.conversationState = options.conversationState;
    }
    if (status === 'COMPLETED' || status === 'FAILED') {
      session.completedAt = now;
    }

    sessions.set(sessionId, session);
    this.persistSessions(sessions);

    this.appendEvent({
      eventId: `vevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      sessionId,
      actionId: session.actionId,
      timestamp: now,
      fromStatus: prevStatus,
      toStatus: status,
      conversationState: session.conversationState,
      actor: options?.actor || 'system:voice',
      reason: options?.reason,
      metadata: {
        callSid: session.callSid,
        error: session.error,
      },
    });

    return session;
  }

  /**
   * Updates conversation state and last spoken text
   */
  public updateConversationState(
    sessionId: string,
    state: VoiceConversationState,
    options?: {
      lastSpokenText?: string;
      reason?: string;
      actor?: string;
    }
  ): VoiceSession {
    const sessions = this.loadSessions();
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`VoiceSession "${sessionId}" not found.`);
    }

    const now = new Date().toISOString();
    session.conversationState = state;
    session.updatedAt = now;
    if (options?.lastSpokenText !== undefined) {
      session.lastSpokenText = options.lastSpokenText;
    }

    sessions.set(sessionId, session);
    this.persistSessions(sessions);

    this.appendEvent({
      eventId: `vevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      sessionId,
      actionId: session.actionId,
      timestamp: now,
      fromStatus: session.status,
      toStatus: session.status,
      conversationState: state,
      actor: options?.actor || 'voice:agent',
      reason: options?.reason,
      metadata: {
        lastSpokenText: options?.lastSpokenText,
      },
    });

    return session;
  }

  /**
   * Appends an entry to the session transcript
   */
  public appendTranscript(sessionId: string, entry: TranscriptEntry): VoiceSession {
    const sessions = this.loadSessions();
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`VoiceSession "${sessionId}" not found.`);
    }

    session.transcript.push(entry);
    session.updatedAt = new Date().toISOString();

    sessions.set(sessionId, session);
    this.persistSessions(sessions);
    return session;
  }
}

export const defaultVoiceStore = new VoiceStore();
