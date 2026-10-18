import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeError } from './db.js';

/**
 * Local-file ingestion safety. Only files under explicitly allowed knowledge roots, with
 * an allowed extension, outside denied names/directories, are ever read. Paths are
 * resolved through symlinks before every check, so a link cannot escape a root.
 */

export const ALLOWED_EXTENSIONS: Record<string, 'text/plain' | 'text/markdown' | 'application/json'> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

export const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 2_000;

const DENIED_DIRS = new Set(['.git', 'node_modules', 'data', 'dist', 'secrets', 'secret', '.ssh', '.aws', '.gnupg', 'credentials', 'tokens', 'claude outputs', 'supabase', '.next', 'coverage']);

const DENIED_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^credentials.*\.json$/i,
  /^token.*\.json$/i,
  /^google-profiles\.json$/i,
  /^service[-_]?account.*\.json$/i,
  /^package(-lock)?\.json$/i,
  /\.(pem|key|p12|pfx|crt|cer|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(sql|dump|backup|bak|sqlite|sqlite3|db)$/i,
  /secret/i,
  /password/i,
];

export function isDeniedName(name: string): boolean {
  return DENIED_FILE_PATTERNS.some((re) => re.test(name));
}

export function isDeniedDir(name: string): boolean {
  return DENIED_DIRS.has(name.toLowerCase());
}

/** Default root: <repo>/knowledge. Extra roots via PHRO_KNOWLEDGE_ROOTS (path-delimited). */
export function knowledgeRoots(env: NodeJS.ProcessEnv = process.env, baseDir: string = process.cwd()): string[] {
  const extra = (env.PHRO_KNOWLEDGE_ROOTS ?? '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  return [path.resolve(baseDir, 'knowledge'), ...extra.map((p) => path.resolve(baseDir, p))]
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.realpathSync(p));
}

function within(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolves a requested path and refuses anything outside the knowledge roots or on the denylist. */
export function resolveSafeKnowledgePath(requested: string, roots: string[]): { real: string; root: string } {
  if (!requested || /\0/.test(requested)) throw new KnowledgeError('unsafe_path', 'A knowledge path is required.');
  const absolute = path.resolve(requested);
  if (!fs.existsSync(absolute)) throw new KnowledgeError('unsafe_path', 'That knowledge path does not exist.');
  const real = fs.realpathSync(absolute);
  const root = roots.find((r) => within(real, r));
  if (!root) {
    throw new KnowledgeError('unsafe_path', 'Refusing to ingest outside the allowed knowledge roots (./knowledge or PHRO_KNOWLEDGE_ROOTS).');
  }
  const rel = path.relative(root, real);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    if (isDeniedDir(part)) throw new KnowledgeError('unsafe_path', `Refusing to ingest from a denied directory (${part}).`);
  }
  if (fs.statSync(real).isFile() && isDeniedName(path.basename(real))) {
    throw new KnowledgeError('unsafe_path', 'Refusing to ingest a denied file (secrets, credentials, tokens, keys or database dumps).');
  }
  return { real, root };
}

export interface KnowledgeFile {
  absolutePath: string;
  /** Stable key: path relative to the knowledge root, POSIX separators. */
  docKey: string;
  mimeType: 'text/plain' | 'text/markdown' | 'application/json';
  bytes: number;
}

/** Files to ingest under a safe path, sorted for deterministic order. Skipped files are reported. */
export function listKnowledgeFiles(requested: string, roots: string[]): { files: KnowledgeFile[]; skipped: Array<{ docKey: string; reason: string }> } {
  const { real, root } = resolveSafeKnowledgePath(requested, roots);
  const files: KnowledgeFile[] = [];
  const skipped: Array<{ docKey: string; reason: string }> = [];
  const visit = (p: string) => {
    if (files.length + skipped.length > MAX_FILES) return;
    const stat = fs.lstatSync(p);
    const docKey = path.relative(root, p).split(path.sep).join('/');
    if (stat.isSymbolicLink()) {
      skipped.push({ docKey, reason: 'symbolic links are not followed' });
      return;
    }
    if (stat.isDirectory()) {
      if (p !== real && isDeniedDir(path.basename(p))) {
        skipped.push({ docKey, reason: 'denied directory' });
        return;
      }
      for (const name of fs.readdirSync(p).sort()) {
        if (name.startsWith('.') && !/^\.env/i.test(name)) continue; // hidden files are not knowledge
        visit(path.join(p, name));
      }
      return;
    }
    if (!stat.isFile()) return;
    const name = path.basename(p);
    if (isDeniedName(name)) {
      skipped.push({ docKey, reason: 'denied file name' });
      return;
    }
    const mimeType = ALLOWED_EXTENSIONS[path.extname(name).toLowerCase()];
    if (!mimeType) {
      skipped.push({ docKey, reason: 'unsupported file type' });
      return;
    }
    if (stat.size > MAX_FILE_BYTES) {
      skipped.push({ docKey, reason: `larger than ${MAX_FILE_BYTES} bytes` });
      return;
    }
    files.push({ absolutePath: p, docKey, mimeType, bytes: stat.size });
  };
  visit(real);
  return { files, skipped };
}
