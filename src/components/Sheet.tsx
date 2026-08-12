/** Bottom sheet — the settings surface. Closes on backdrop click or Escape. */

import { useEffect, type ReactNode } from 'react';
import { CloseIcon, IconButton } from './ui';

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl border-t border-border bg-surface p-5 safe-bottom"
      >
        <div className="mx-auto max-w-lg">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">{title}</h2>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
