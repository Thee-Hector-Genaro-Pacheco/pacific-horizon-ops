import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDemoServices } from '../data/demoAdapter';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('knowledge diagnostics UI is read-only', () => {
  it('the knowledge service exposes only status and search', () => {
    expect(Object.keys(createDemoServices(0).knowledge).sort()).toEqual(['getStatus', 'search']);
    const services = read('../data/services.ts');
    const block = services.slice(services.indexOf('interface KnowledgeService'), services.indexOf('}', services.indexOf('interface KnowledgeService')));
    expect(block).not.toMatch(/ingest|upload|delete|create|update/i);
  });

  it('the page has no ingestion, upload or delete controls and no write requests', () => {
    const page = read('../pages/KnowledgePage.tsx');
    expect(page).not.toMatch(/type="file"|>\s*(Upload|Ingest|Delete|Remove|Add document)\b/i);
    expect(page).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/);
  });

  it('demo search returns provenance fields without internal IDs', async () => {
    const r = await createDemoServices(0).knowledge.search('sponsored');
    expect(Object.keys(r.results[0]).sort()).toEqual(['coverage', 'excerpt', 'lexicalScore', 'rank', 'score', 'section', 'sourceLabel', 'title', 'vectorScore']);
  });
});
