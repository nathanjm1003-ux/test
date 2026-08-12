/**
 * Small unique-id helper.
 *
 * `crypto.randomUUID` is only exposed in secure contexts, and testing this app
 * from a phone usually means plain http://192.168.x.x — so fall back rather
 * than crash on the device the app is meant for.
 */
export function uid(prefix = ''): string {
  const base =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${base}` : base;
}
