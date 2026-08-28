// These are persisted foreground-dispatch transitions.  A poll can skip an
// intermediate write, so a reachable later state is also a valid advance.
export const FOREGROUND_DISPATCH_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['claimed', 'cancelled']),
  claimed: Object.freeze(['pending', 'delivered', 'cancelled']),
  delivered: Object.freeze(['sent', 'cancelled']),
  sent: Object.freeze(['finalizing', 'completed', 'failed', 'cancelled']),
  finalizing: Object.freeze(['completed', 'failed', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export function isForegroundDispatchStatus(status) {
  return Object.hasOwn(FOREGROUND_DISPATCH_TRANSITIONS, status);
}

export function canAdvanceForegroundDispatch(from, to) {
  if (!isForegroundDispatchStatus(from) || !isForegroundDispatchStatus(to)) return false;
  if (from === to) return true;
  const visited = new Set([from]);
  const pending = [...FOREGROUND_DISPATCH_TRANSITIONS[from]];
  while (pending.length > 0) {
    const status = pending.shift();
    if (status === to) return true;
    if (visited.has(status)) continue;
    visited.add(status);
    pending.push(...FOREGROUND_DISPATCH_TRANSITIONS[status]);
  }
  return false;
}
