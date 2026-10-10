import { describe, expect, it } from 'vitest';
import { buildDemoDataset, createDemoServices } from './demoAdapter';

describe('demo dataset', () => {
  const data = buildDemoDataset(Date.parse('2026-10-04T22:00:00Z'));

  it('is unmistakably demo data', () => {
    const ids = [...data.inbox, ...data.actions, ...data.calls, ...data.leads].map((x) => x.id);
    expect(ids.every((id) => id.startsWith('demo_'))).toBe(true);
    expect(createDemoServices(0).kind).toBe('demo');
  });

  it('is internally consistent', () => {
    const actionIds = new Set(data.actions.map((a) => a.id));
    for (const m of data.inbox) if (m.actionId) expect(actionIds.has(m.actionId)).toBe(true);
    const customerIds = new Set(data.customers.map((c) => c.id));
    for (const l of data.leads) expect(customerIds.has(l.customerId)).toBe(true);
    expect(data.commandCenter.counts.pendingApprovals).toBe(data.actions.filter((a) => a.status === 'AWAITING_APPROVAL').length);
  });

  it('never contains real-looking phone numbers or prices', () => {
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/\+1\d{10}/);
    expect(text).not.toMatch(/\$\d/);
  });

  it('serves records through the service interface', async () => {
    const s = createDemoServices(0);
    const inbox = await s.mailbox.listInbox();
    await expect(s.mailbox.getInboxItem(inbox[0].id)).resolves.toMatchObject({ id: inbox[0].id });
    await expect(s.actions.getAction('missing')).rejects.toThrow(/not found/);
  });
});
