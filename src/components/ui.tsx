/** Shared primitives: buttons, icons, progress bar. No UI dependency needed. */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'surface' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:opacity-90 active:opacity-80',
  surface: 'bg-surface-2 text-ink hover:bg-border active:opacity-80',
  ghost: 'bg-transparent text-ink-soft hover:text-ink hover:bg-surface-2',
  danger: 'bg-transparent text-danger hover:bg-surface-2',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  full?: boolean;
}

export function Button({
  variant = 'surface',
  full,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5',
        'text-sm font-medium transition select-none',
        'disabled:opacity-40 disabled:pointer-events-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        VARIANTS[variant],
        full ? 'w-full' : '',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/** Circular icon button — used a lot in the player transport. */
export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  className = '',
  children,
  ...rest
}: ButtonProps & { label: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'h-9 w-9',
    md: 'h-11 w-11',
    lg: 'h-16 w-16',
  } as const;
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={[
        'inline-flex items-center justify-center rounded-full transition select-none',
        'disabled:opacity-40 disabled:pointer-events-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        sizes[size],
        VARIANTS[variant],
        className,
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-border bg-surface p-4 ${className}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons — 24px stroke icons, inlined to avoid an icon-library dependency.
// ---------------------------------------------------------------------------

const svg = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
  'aria-hidden': true,
};

type IconProps = { className?: string };
const cls = (c?: string) => c ?? 'h-5 w-5';

export const CameraIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8a1 1 0 0 0 .83-.45l.74-1.1A1 1 0 0 1 9.7 4h4.6a1 1 0 0 1 .83.45l.74 1.1a1 1 0 0 0 .83.45h1.8A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
    <circle cx="12" cy="12.5" r="3.5" />
  </svg>
);

export const ImageIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L16 17M14 14l1.8-1.8a2 2 0 0 1 2.8 0L20 13.5" />
  </svg>
);

export const FileIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </svg>
);

export const PlayIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)} fill="currentColor" stroke="none">
    <path d="M8 5.5a1 1 0 0 1 1.53-.85l9 6.5a1 1 0 0 1 0 1.7l-9 6.5A1 1 0 0 1 8 18.5z" />
  </svg>
);

export const PauseIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)} fill="currentColor" stroke="none">
    <rect x="6.5" y="5" width="4" height="14" rx="1.3" />
    <rect x="13.5" y="5" width="4" height="14" rx="1.3" />
  </svg>
);

export const PrevIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)} fill="currentColor" stroke="none">
    <path d="M17 6.2a1 1 0 0 0-1.55-.83l-7.2 4.8a1 1 0 0 0 0 1.66l7.2 4.8A1 1 0 0 0 17 15.8z" />
    <rect x="5" y="5.5" width="2.2" height="13" rx="1.1" />
  </svg>
);

export const NextIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)} fill="currentColor" stroke="none">
    <path d="M7 6.2a1 1 0 0 1 1.55-.83l7.2 4.8a1 1 0 0 1 0 1.66l-7.2 4.8A1 1 0 0 1 7 15.8z" />
    <rect x="16.8" y="5.5" width="2.2" height="13" rx="1.1" />
  </svg>
);

export const LibraryIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 0 9 17H5.5A1.5 1.5 0 0 1 4 15.5z" />
    <path d="M10.5 18.5v-13A1.5 1.5 0 0 1 12 4h3.5A1.5 1.5 0 0 1 17 5.5v10A1.5 1.5 0 0 0 15.5 17H12a1.5 1.5 0 0 0-1.5 1.5" />
    <path d="m17.6 6.4 2 .5a1.5 1.5 0 0 1 1.05 1.83l-2.3 8.6" />
  </svg>
);

export const PlusIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const TrashIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M4 7h16M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1M6 7l.8 12a2 2 0 0 0 2 1.9h6.4a2 2 0 0 0 2-1.9L18 7M10.5 11v6M13.5 11v6" />
  </svg>
);

export const BackIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M15 5.5 8 12l7 6.5" />
  </svg>
);

export const CheckIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>
);

export const CloseIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const PencilIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17z" />
  </svg>
);

export const SpeakerIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M5 9.5h3l4-3.2a.8.8 0 0 1 1.3.63v10.14a.8.8 0 0 1-1.3.63L8 14.5H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z" />
    <path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);

export const SunIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
  </svg>
);

export const MoonIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.2 8.2 0 1 0 20 14.2" />
  </svg>
);

export const SlidersIcon = ({ className }: IconProps) => (
  <svg {...svg} className={cls(className)}>
    <path d="M5 6h9M18 6h1M5 12h3M12 12h7M5 18h9M18 18h1" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="16" cy="18" r="2" />
  </svg>
);
