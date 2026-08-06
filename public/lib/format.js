// Small display formatters shared by the UI.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/** Seconds to `h:mm:ss` / `m:ss`. */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Unix seconds to a local date string. */
export function formatDate(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '—';
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** Format a playback rate the way a speed control should read: 1x, 1.5x, 10x. */
export function formatRate(rate) {
  const rounded = Math.round(rate * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0$/, '')}x`;
}

/** Semitones to a signed display string. */
export function formatSemitones(semitones) {
  const rounded = Math.round(semitones * 10) / 10;
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}
