/**
 * Deterministic, structure-aware chunking.
 *
 * Markdown and plain text split on headings, then paragraphs, then sentences; a single
 * oversized sentence is hard-split, so no chunk ever exceeds `maxChars`. Neighbouring
 * chunks within a section share a short overlap (the tail of the previous chunk, cut at a
 * word boundary). JSON is rendered as "path: value" lines grouped by top-level key.
 */

export interface ChunkOptions {
  /** Hard ceiling per chunk, in characters. */
  maxChars?: number;
  /** Characters carried over from the previous chunk in the same section. */
  overlapChars?: number;
}

export interface TextChunk {
  ordinal: number;
  text: string;
  /** Heading path, e.g. ["Photo Booth Operating Policy", "Sponsored events"]. */
  headings: string[];
  section: string | null;
  charCount: number;
  tokenEstimate: number;
}

export const DEFAULT_MAX_CHARS = 1200;
export const DEFAULT_OVERLAP_CHARS = 150;
const MAX_CHUNKS_PER_DOCUMENT = 2000;

export class ChunkingError extends Error {}

/** Rough token estimate (~4 characters per token for English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Block {
  headings: string[];
  paragraphs: string[];
}

function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const headings: string[] = [];
  let current: Block = { headings: [], paragraphs: [] };
  let para: string[] = [];
  let inFence = false;
  const flushPara = () => {
    const p = para.join('\n').trim();
    if (p) current.paragraphs.push(p);
    para = [];
  };
  for (const line of text.split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      flushPara();
      if (current.paragraphs.length) blocks.push(current);
      const level = heading[1].length;
      headings.splice(level - 1);
      headings[level - 1] = heading[2].trim();
      current = { headings: headings.filter(Boolean), paragraphs: [] };
      continue;
    }
    if (!inFence && line.trim() === '') flushPara();
    else para.push(line);
  }
  flushPara();
  if (current.paragraphs.length) blocks.push(current);
  return blocks;
}

function splitSentences(paragraph: string): string[] {
  const parts = paragraph.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)\s*/g) ?? [paragraph];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Pieces no longer than maxChars: sentences, with oversized sentences hard-split at spaces. */
function boundedPieces(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const out: string[] = [];
  for (const sentence of splitSentences(paragraph)) {
    if (sentence.length <= maxChars) {
      out.push(sentence);
      continue;
    }
    let rest = sentence;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut < maxChars * 0.5) cut = maxChars;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

function tail(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return '';
  const slice = text.slice(-chars);
  const space = slice.indexOf(' ');
  return space >= 0 ? slice.slice(space + 1) : '';
}

function chunkBlocks(blocks: Block[], opts: Required<ChunkOptions>): TextChunk[] {
  const chunks: TextChunk[] = [];
  const push = (text: string, headings: string[]) => {
    if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) throw new ChunkingError(`Document produces more than ${MAX_CHUNKS_PER_DOCUMENT} chunks.`);
    const t = text.trim();
    if (!t) return;
    chunks.push({
      ordinal: chunks.length,
      text: t,
      headings,
      section: headings.length ? headings[headings.length - 1] : null,
      charCount: t.length,
      tokenEstimate: estimateTokens(t),
    });
  };
  for (const block of blocks) {
    let buffer = '';
    let hasNew = false;
    for (const para of block.paragraphs) {
      for (const piece of boundedPieces(para, opts.maxChars)) {
        const sep = buffer ? '\n\n' : '';
        if (buffer && buffer.length + sep.length + piece.length > opts.maxChars) {
          push(buffer, block.headings);
          const carry = tail(buffer, opts.overlapChars);
          buffer = carry && carry.length + 2 + piece.length <= opts.maxChars ? `${carry}\n\n${piece}` : piece;
        } else {
          buffer = `${buffer}${sep}${piece}`;
        }
        hasNew = true;
      }
    }
    if (buffer && hasNew) push(buffer, block.headings);
  }
  return chunks;
}

function jsonBlocks(value: unknown, title: string): Block[] {
  const lines = (v: unknown, prefix: string, out: string[]) => {
    if (v === null || typeof v !== 'object') {
      out.push(`${prefix || 'value'}: ${String(v)}`);
      return;
    }
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    for (const [k, x] of entries) lines(x, prefix ? `${prefix}.${k}` : k, out);
  };
  if (value === null || typeof value !== 'object') return [{ headings: [title], paragraphs: [String(value)] }];
  const entries = Array.isArray(value) ? value.map((x, i) => [String(i), x] as const) : Object.entries(value as Record<string, unknown>);
  return entries.map(([key, x]) => {
    const out: string[] = [];
    lines(x, key, out);
    return { headings: [title, key], paragraphs: out };
  });
}

/** Chunks normalized text by type. Throws ChunkingError for malformed JSON or runaway documents. */
export function chunkDocument(text: string, mimeType: string, title: string, options: ChunkOptions = {}): TextChunk[] {
  const opts: Required<ChunkOptions> = {
    maxChars: Math.max(200, options.maxChars ?? DEFAULT_MAX_CHARS),
    overlapChars: Math.max(0, Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, Math.floor((options.maxChars ?? DEFAULT_MAX_CHARS) / 4))),
  };
  if (mimeType === 'application/json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ChunkingError('Malformed JSON document.');
    }
    return chunkBlocks(jsonBlocks(parsed, title), opts);
  }
  const blocks = mimeType === 'text/markdown' ? markdownBlocks(text) : [{ headings: [], paragraphs: text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) }];
  return chunkBlocks(blocks, opts);
}

/** Title: first Markdown H1, else the file name without extension. */
export function documentTitle(text: string, mimeType: string, docKey: string): string {
  if (mimeType === 'text/markdown') {
    const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(text);
    if (h1) return h1[1].trim().slice(0, 200);
  }
  const base = docKey.split('/').pop() ?? docKey;
  return base.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 200) || docKey;
}
