// Знак NoxVC (монограмма NV) и логотип. Исходник — brand/src/mark.svg.
import { useId } from 'react';

export const BRAND = 'NoxVC';

export function Mark({ size = 32, className }: { size?: number; className?: string }) {
  const g = useId();
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a68bff" /><stop offset="1" stopColor="#5b33b8" /></linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${g})`} />
      <path d="M18.5 46V18L32 46L45.5 18" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Знак и слово «NoxVC» (VC — акцентом бренда). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <div className="logo" style={{ fontSize: Math.round(size * 0.72) }}>
      <Mark size={size} />
      <span className="logo-word">Nox<span>VC</span></span>
    </div>
  );
}
