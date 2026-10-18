import { KnowledgeError } from './db.js';
import { EMBEDDING_DIMENSION } from './migrations.js';

/**
 * Embedding provider abstraction. The knowledge store only depends on this interface;
 * the vendor is a configuration choice. There is no fake or random fallback: a provider
 * that cannot embed throws KnowledgeError('embedding_unavailable').
 */
export interface EmbeddingProvider {
  /** Stable identifier stored with every vector, e.g. "ollama:nomic-embed-text". */
  readonly model: string;
  readonly dimension: number;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  batchSize?: number;
}

/**
 * Local, free embeddings through Ollama's HTTP API (no npm dependency). Default model
 * nomic-embed-text: 768 dimensions, Apache-2.0, trained with "search_document:" /
 * "search_query:" task prefixes, which are applied here.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimension = EMBEDDING_DIMENSION;
  private readonly baseUrl: string;
  private readonly name: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: NonNullable<OllamaOptions['fetchImpl']>;
  private readonly batchSize: number;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.name = options.model ?? 'nomic-embed-text';
    this.model = `ollama:${this.name}`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? ((i, init) => fetch(i, init));
    this.batchSize = options.batchSize ?? 32;
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    const prefix = this.name.startsWith('nomic-embed') ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => prefix + t);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.name, input: batch }),
          signal: controller.signal,
        });
      } catch {
        throw new KnowledgeError('embedding_unavailable', `Embedding service at ${this.baseUrl} is not reachable. Is Ollama running?`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        throw new KnowledgeError(
          'embedding_unavailable',
          res.status === 404 ? `Embedding model "${this.name}" is not available. Run: ollama pull ${this.name}` : `Embedding service returned HTTP ${res.status}.`
        );
      }
      const body = (await res.json().catch(() => null)) as { embeddings?: unknown } | null;
      const vectors = body?.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        throw new KnowledgeError('embedding_unavailable', 'Embedding service returned an unexpected response.');
      }
      for (const v of vectors) out.push(validateVector(v, this.dimension));
    }
    return out;
  }
}

export function validateVector(v: unknown, dimension: number): number[] {
  if (!Array.isArray(v) || v.length !== dimension || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new KnowledgeError('embedding_unavailable', `Embedding has the wrong shape (expected ${dimension} finite numbers).`);
  }
  return v as number[];
}

/**
 * PHRO_EMBEDDINGS_PROVIDER: "ollama" (default) or "none" (explicit lexical-only).
 * PHRO_OLLAMA_URL, PHRO_EMBEDDINGS_MODEL optional. Returns null only for "none".
 */
export function createEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  const kind = (env.PHRO_EMBEDDINGS_PROVIDER ?? 'ollama').trim().toLowerCase();
  if (kind === 'none') return null;
  if (kind === 'ollama') {
    return new OllamaEmbeddingProvider({ baseUrl: env.PHRO_OLLAMA_URL?.trim() || undefined, model: env.PHRO_EMBEDDINGS_MODEL?.trim() || undefined });
  }
  throw new KnowledgeError('config', `Unknown PHRO_EMBEDDINGS_PROVIDER "${kind}" (use "ollama" or "none").`);
}
