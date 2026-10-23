/**
 * Structured knowledge logs: one JSON line per event. Only counts, ids, timings, kinds and
 * short safe labels are accepted; document text, queries beyond a short preview, and
 * anything secret-like are never logged.
 */
export type KnowledgeLogEvent =
  | 'ingestion.started'
  | 'ingestion.document'
  | 'ingestion.completed'
  | 'ingestion.failed'
  | 'retrieval.completed'
  | 'retrieval.failed'
  | 'embedding.failed'
  | 'database.failed'
  | 'answer.completed'
  | 'answer.generation_failed';

type Field = string | number | boolean | null | undefined | string[];

export type KnowledgeLogger = (event: KnowledgeLogEvent, fields: Record<string, Field>) => void;

export const consoleKnowledgeLogger: KnowledgeLogger = (event, fields) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'knowledge', event, ...fields }));
};

export const silentKnowledgeLogger: KnowledgeLogger = () => {};
