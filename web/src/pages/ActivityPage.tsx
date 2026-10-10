import { Activity } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityItem } from '../components/ops';
import { EmptyState, ErrorState, PageHeader, Panel, Segmented, SkeletonRows } from '../components/primitives';
import type { ActivityDTO, ActivityKind } from '../data/contract';
import { useResource } from '../data/useResource';

type Filter = 'all' | 'email' | 'approvals' | 'voice' | 'failures';

const GROUPS: Record<Exclude<Filter, 'all'>, ActivityKind[]> = {
  email: ['email_received', 'email_classified', 'email_triaged', 'lead_identified', 'draft_generated', 'email_sent'],
  approvals: ['approval_requested', 'approval_confirmed', 'approval_rejected', 'execution_started', 'email_sent'],
  voice: ['call_initiated', 'call_connected', 'call_completed', 'call_failed', 'voice_turn'],
  failures: ['execution_failed', 'call_failed'],
};

function dayHeading(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function ActivityPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const activity = useResource((s) => s.activity.listActivity(300), [], ['activity']);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  // Highlight events that arrive while the page is open.
  useEffect(() => {
    if (!activity.data) return;
    const ids = new Set(activity.data.map((a) => a.id));
    if (seen.current) {
      const incoming = [...ids].filter((id) => !seen.current!.has(id));
      if (incoming.length) setFresh(new Set(incoming));
    }
    seen.current = ids;
  }, [activity.data]);

  const visible = useMemo(
    () => (activity.data ?? []).filter((a) => filter === 'all' || GROUPS[filter].includes(a.kind)),
    [activity.data, filter]
  );

  const byDay = useMemo(() => {
    const out: Array<[string, ActivityDTO[]]> = [];
    for (const a of visible) {
      const h = dayHeading(a.at);
      const last = out[out.length - 1];
      if (last && last[0] === h) last[1].push(a);
      else out.push([h, [a]]);
    }
    return out;
  }, [visible]);

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Agent activity"
        description="Every step Pacific Ops takes, from classification and drafting to voice approval and Gmail execution. Updates arrive live."
      />
      <div className="toolbar">
        <Segmented
          label="Filter activity"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'email', label: 'Email' },
            { value: 'approvals', label: 'Approvals' },
            { value: 'voice', label: 'Voice' },
            { value: 'failures', label: 'Failures' },
          ]}
        />
      </div>

      {activity.loading ? (
        <Panel flush>
          <SkeletonRows rows={10} label="Loading activity" />
        </Panel>
      ) : activity.error && !activity.data ? (
        <Panel>
          <ErrorState error={activity.error} onRetry={activity.reload} />
        </Panel>
      ) : byDay.length === 0 ? (
        <Panel>
          <EmptyState icon={Activity} title="No activity in this view">
            {filter === 'failures' ? 'No failures recorded.' : 'Agent events will stream in here as they happen.'}
          </EmptyState>
        </Panel>
      ) : (
        <div className="stack">
          {byDay.map(([day, items]) => (
            <Panel key={day} title={day} count={items.length} flush>
              <ul className="activity-list" style={{ padding: '6px 0' }}>
                {items.map((a) => (
                  <ActivityItem key={a.id} item={a} isNew={fresh.has(a.id)} />
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
