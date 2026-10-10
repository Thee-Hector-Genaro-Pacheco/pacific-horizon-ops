import { Database, FlaskConical, KeyRound, Lock, Plug, Radar } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { SystemHealthIndicator } from '../components/ops';
import { ErrorState, Kbd, PageHeader, Panel, SkeletonRows } from '../components/primitives';
import { useData } from '../data/DataProvider';
import { useResource } from '../data/useResource';
import { PacificOpsPresence } from '../presence/PacificOpsPresence';
import { PRESENCE_STATES, STATE_STATUS, type PacificOpsState } from '../presence/states';

export function SettingsPage() {
  const { mode, setMode } = useData();
  const location = useLocation();
  const health = useResource((s) => s.dashboard.getHealth(), [], ['health']);
  const [preview, setPreview] = useState<PacificOpsState>('idle');
  const [audio, setAudio] = useState(0.6);
  const [useAudio, setUseAudio] = useState(false);

  useEffect(() => {
    if (location.hash === '#presence') document.getElementById('presence')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash]);

  return (
    <>
      <PageHeader eyebrow="System" title="Settings" description="Data source, integrations, the Pacific Ops presence, and the security posture of this console." />

      <div className="stack">
        <Panel title="Data source" icon={Database} id="data-source">
          <div className="mode-switch" role="group" aria-label="Data source">
            <button type="button" className="mode-option" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>
              <strong>Live operations</strong>
              <span>Real PHRO state from the read-only Command Center API. Requires <code className="mono">npm run dashboard:serve</code>.</span>
            </button>
            <button type="button" className="mode-option" aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>
              <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FlaskConical size={14} aria-hidden /> Demo data
              </strong>
              <span>Sample records for exploring the interface. Labeled DEMO everywhere and never mixed with live data.</span>
            </button>
          </div>
        </Panel>

        <Panel title="Pacific Ops presence" icon={Radar} id="presence" flush>
          <div className="presence-lab">
            <div style={{ position: 'relative', minHeight: 420, background: 'linear-gradient(180deg, var(--bg-1), var(--bg-0))' }}>
              <PacificOpsPresence
                state={preview}
                audioLevel={useAudio ? audio : undefined}
                headline="Preview only, not live state"
                telemetry={[{ label: 'Mode', value: 'PREVIEW', tone: 'tone-idle' }]}
                annotations={[{ label: STATE_STATUS[preview], tone: preview === 'awaiting_approval' ? 'tone-warn' : preview === 'error' ? 'tone-fail' : 'tone-info' }]}
              />
            </div>
            <div className="presence-lab-controls">
              <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                Preview each runtime state. The Command Center drives the same component from real voice and action state.
              </p>
              <div className="state-buttons" role="group" aria-label="Preview state">
                {PRESENCE_STATES.map((s) => (
                  <button key={s} type="button" aria-pressed={preview === s} onClick={() => setPreview(s)}>
                    <i className={`dot ${s === 'error' ? 'tone-fail' : s === 'awaiting_approval' ? 'tone-warn' : s === 'success' || s === 'idle' ? 'tone-ok' : 'tone-info'}`} aria-hidden />
                    {s.replace('_', ' ')}
                  </button>
                ))}
              </div>
              <label style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-sm)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={useAudio} onChange={(e) => setUseAudio(e.target.checked)} /> Manual audio level
                </span>
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={audio}
                  disabled={!useAudio}
                  onChange={(e) => setAudio(Number(e.target.value))}
                  aria-label="Audio level"
                />
              </label>
              <code className="mono muted" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
                {`<PacificOpsPresence state="${preview}"${useAudio ? ` audioLevel={${audio.toFixed(2)}}` : ''} />`}
              </code>
            </div>
          </div>
        </Panel>

        <div className="grid-even">
          <Panel title="Integrations" icon={Plug}>
            {health.data ? (
              <ul className="health-list">
                {health.data.components.map((c) => (
                  <SystemHealthIndicator key={c.key} component={c} variant="row" />
                ))}
              </ul>
            ) : health.error ? (
              <ErrorState error={health.error} onRetry={health.reload} compact />
            ) : (
              <SkeletonRows rows={4} />
            )}
            <p className="muted" style={{ marginTop: 12, fontSize: 'var(--fs-xs)' }}>
              Connected means recent successful activity. Configured means credentials exist but nothing has used them in the last 24 hours.
            </p>
          </Panel>

          <Panel title="Security posture" icon={Lock}>
            <ul className="safety-card">
              {[
                'The Command Center API is read-only. Every non-GET request is rejected.',
                'The API binds to 127.0.0.1 by default.',
                'Gmail message, thread and draft IDs and Twilio call SIDs are never sent to the browser.',
                'Phone numbers are masked server-side, transcripts included.',
                'OAuth tokens, Twilio and Anthropic credentials stay on the server.',
                'Approve and send only happen through voice confirmation or the CLI state machine.',
              ].map((line) => (
                <li key={line} className="safety-step">
                  <KeyRound size={14} aria-hidden style={{ color: 'var(--cyan)', marginTop: 2 }} />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <Panel title="Keyboard">
          <dl className="kv" style={{ gridTemplateColumns: '140px 1fr' }}>
            <dt>
              <Kbd>⌘</Kbd> <Kbd>K</Kbd>
            </dt>
            <dd>Command palette: search email, customers, actions and calls, or run commands</dd>
            <dt>
              <Kbd>Esc</Kbd>
            </dt>
            <dd>Close drawers, palette and popovers</dd>
            <dt>
              <Kbd>Tab</Kbd>
            </dt>
            <dd>Every control is keyboard reachable, with visible focus</dd>
          </dl>
        </Panel>
      </div>
    </>
  );
}
