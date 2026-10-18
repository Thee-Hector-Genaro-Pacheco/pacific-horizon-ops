import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDemoServices } from '../data/demoAdapter';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('agent trace view is read-only', () => {
  it('the agent service only lists traces', () => {
    expect(Object.keys(createDemoServices(0).agent)).toEqual(['listTraces']);
  });

  it('the page has no controls that run, approve or send anything', () => {
    const page = read('../pages/AgentTracesPage.tsx');
    expect(page).not.toMatch(/<button|onClick|method:\s*['"](POST|PUT|PATCH|DELETE)/i);
    expect(page).not.toMatch(/>\s*(Approve|Send|Run|Execute|Retry tool)\b/i);
  });

  it('demo traces carry no session or request identifiers', async () => {
    const traces = await createDemoServices(0).agent.listTraces();
    expect(traces.length).toBeGreaterThan(0);
    for (const t of traces) {
      expect(t).not.toHaveProperty('sessionId');
      expect(t).not.toHaveProperty('requestId');
    }
  });
});
