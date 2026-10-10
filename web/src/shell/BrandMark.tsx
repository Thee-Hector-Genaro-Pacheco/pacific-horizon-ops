import { useId } from 'react';

/** Pacific Rising mark: a sun cresting a stack of horizon lines. */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  const id = useId();
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b4f0f8" />
          <stop offset="1" stopColor="#45d8ea" />
        </linearGradient>
        <radialGradient id={`${id}-r`} cx="0.5" cy="0.62" r="0.6">
          <stop offset="0" stopColor="#efa545" stopOpacity="0.45" />
          <stop offset="1" stopColor="#efa545" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#0e1218" stroke="rgba(150,175,205,0.18)" />
      <circle cx="16" cy="19" r="10" fill={`url(#${id}-r)`} />
      <path d="M9 18.5a7 7 0 0 1 14 0" fill="none" stroke={`url(#${id}-g)`} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.5 21.5h19" stroke="#45d8ea" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9 24.5h14" stroke="#45d8ea" strokeOpacity="0.55" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M12 27h8" stroke="#45d8ea" strokeOpacity="0.28" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="16" cy="11.5" r="1.1" fill="#efa545" />
    </svg>
  );
}
