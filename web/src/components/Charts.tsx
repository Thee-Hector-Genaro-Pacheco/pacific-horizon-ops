import { useEffect, useRef, useState } from 'react';
import type { SeriesPoint } from '../data/contract';
import { dayLabel } from '../lib/format';

/**
 * Single-series daily bar chart. One hue (identity is carried by the panel title),
 * recessive grid, rounded data-ends anchored to the baseline, per-bar hover tooltip
 * with hit targets wider than the bars, and an accessible table alternative.
 */
export function BarChart({ data, label, unit = '', height = 160 }: { data: SeriesPoint[]; label: string; unit?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const padL = 26;
  const padB = 20;
  const padT = 8;
  const max = Math.max(1, ...data.map((d) => d.value));
  const niceMax = max <= 4 ? max : Math.ceil(max / 5) * 5;
  const plotH = height - padB - padT;
  const slot = (width - padL) / Math.max(1, data.length);
  const barW = Math.min(22, slot * 0.56);
  const ticks = [0, niceMax / 2, niceMax].map((v) => Math.round(v));
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}, last ${data.length} days`}>
        <g className="chart-grid">
          {ticks.map((t) => (
            <line key={t} x1={padL} x2={width} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="chart-axis">
          {ticks.map((t) => (
            <text key={t} x={0} y={y(t) + 3}>
              {t}
            </text>
          ))}
          {data.map((d, i) =>
            i % Math.ceil(data.length / 7) === 0 || i === data.length - 1 ? (
              <text key={d.date} x={padL + slot * i + slot / 2} y={height - 4} textAnchor="middle">
                {dayLabel(d.date)}
              </text>
            ) : null
          )}
        </g>
        {data.map((d, i) => {
          const x = padL + slot * i + (slot - barW) / 2;
          const h = d.value === 0 ? 2 : Math.max(3, (d.value / niceMax) * plotH);
          const top = padT + plotH - h;
          const r = Math.min(4, barW / 2, h);
          // Rounded top corners only; the bar stays anchored flat on the baseline.
          const path = `M${x},${padT + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${padT + plotH} Z`;
          return (
            <g key={d.date}>
              <rect
                className="chart-hit"
                x={padL + slot * i}
                y={padT}
                width={slot}
                height={plotH}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
              <path d={path} className={`chart-bar${d.value === 0 ? ' is-zero' : ''}${hover === i ? ' is-hover' : ''}`} style={{ pointerEvents: 'none' }} />
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="chart-tooltip" style={{ left: `${((padL + slot * hover + slot / 2) / width) * 100}%`, top: `${(y(data[hover].value) / height) * 100}%` }}>
          <strong>
            {data[hover].value}
            {unit}
          </strong>
          <span className="muted">{dayLabel(data[hover].date)}</span>
        </div>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HBarList({ items, label }: { items: Array<{ label: string; value: number }>; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="hbar-list" aria-label={label}>
      {items.map((i) => (
        <li className="hbar" key={i.label}>
          <span className="hbar-label">{i.label}</span>
          <span className="hbar-track" aria-hidden>
            <span className="hbar-fill" style={{ display: 'block', width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="hbar-value">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}
