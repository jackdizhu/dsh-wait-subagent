/**
 * dsh-wait-subagent — write-scope normalization and the FIFO arbitration queue.
 *
 * A task's `write_scope` is a list of path prefixes the child intends to
 * modify. Two scopes conflict when any pair is equal or one is a path-prefix
 * ancestor of the other, so tasks that touch the same directory (or nested
 * directories) are serialized while disjoint scopes run in parallel.
 *
 * Scope strings are normalized once on the way in (trim, backslashes to slashes,
 * lowercase, trailing slash stripped, empties dropped, duplicates collapsed),
 * so comparisons are exact string prefix tests on a canonical form.
 *
 * `createScopeQueue()` arbitrates holders:
 *   - tryAcquire() grants only when no conflict is held AND nobody is waiting
 *     (strict FIFO — a newcomer never jumps a queued task);
 *   - acquire() queues and resolves with a release function when granted;
 *   - release() is idempotent, frees the holder, and wakes queued tasks in
 *     order as capacity allows;
 *   - an empty scope never occupies a slot (nothing to serialize).
 */

/**
 * Normalize a write scope to its canonical comparable form.
 *
 * @param {string[]|undefined} scope raw scope entries (undefined means "none")
 * @returns {string[]} deduplicated canonical path prefixes
 * @throws {Error} `write_scope must be an array of strings` for non-arrays or
 *   non-string entries
 */
export function normalizeScope(scope) {
  if (scope === undefined) return [];
  if (!Array.isArray(scope)) throw new Error("write_scope must be an array of strings");

  const normalized = new Set();
  for (const entry of scope) {
    if (typeof entry !== "string") throw new Error("write_scope must be an array of strings");
    let item = entry.trim().replace(/\\/g, "/").toLowerCase();
    while (item.endsWith("/")) item = item.slice(0, -1);
    if (item.length > 0) normalized.add(item);
  }
  return Array.from(normalized);
}

/**
 * Decide whether two already-normalized scopes conflict.
 *
 * @param {string[]|undefined} a canonical scope
 * @param {string[]|undefined} b canonical scope
 * @returns {boolean} true when any pair is equal or one is a prefix ancestor
 */
export function scopesConflict(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/")) return true;
    }
  }
  return false;
}

/** No-op release handed back for empty scopes, which never take a slot. */
function noopRelease() {}

/**
 * Create the arbitration queue shared by every dispatch call, so tasks that
 * share a path prefix serialize even when they arrive in different batches.
 *
 * @returns {{
 *   tryAcquire: (scope: string[]) => (() => void) | null,
 *   acquire: (scope: string[]) => Promise<() => void>,
 *   size: () => { active: number, waiting: number },
 * }}
 */
export function createScopeQueue() {
  /** Held slots; each entry carries its canonical scope. */
  const active = [];
  /** FIFO waiters: { scope, resolve }. */
  const waiting = [];

  function conflictsHeld(scope) {
    for (const entry of active) {
      if (scopesConflict(scope, entry.scope)) return true;
    }
    return false;
  }

  /** Take a slot for a non-empty scope and return its idempotent release. */
  function takeSlot(scope) {
    const entry = { scope };
    let released = false;
    active.push(entry);

    return function release() {
      if (released) return;
      released = true;
      const index = active.indexOf(entry);
      if (index >= 0) active.splice(index, 1);
      drain();
    };
  }

  /**
   * Hand free capacity to waiters in FIFO order: scan from the head, grant the
   * first taskable waiter, then rescan (a later disjoint waiter may also fit
   * without ever overtaking a blocked earlier one).
   */
  function drain() {
    let granted = true;
    while (granted) {
      granted = false;
      for (let index = 0; index < waiting.length; index += 1) {
        const waiter = waiting[index];
        if (conflictsHeld(waiter.scope)) continue; // still blocked; later disjoint entries may fit
        waiting.splice(index, 1);
        granted = true;
        waiter.resolve(takeSlot(waiter.scope));
        break; // rescan from the head to preserve FIFO among the rest
      }
    }
  }

  function tryAcquire(scope) {
    const normalized = Array.isArray(scope) ? normalizeScope(scope) : [];
    // Strict FIFO: while anyone waits, a newcomer must queue behind them.
    if (waiting.length > 0) return null;
    if (normalized.length === 0) return noopRelease;
    if (conflictsHeld(normalized)) return null;
    return takeSlot(normalized);
  }

    function acquire(scope) {
    const normalized = Array.isArray(scope) ? normalizeScope(scope) : [];
    if (normalized.length === 0) return Promise.resolve(noopRelease);
    if (waiting.length === 0 && !conflictsHeld(normalized)) {
      return Promise.resolve(takeSlot(normalized));
    }
    return new Promise((resolve) => {
      waiting.push({ scope: normalized, resolve });
    });
  }

  function size() {
    return { active: active.length, waiting: waiting.length };
  }

  return { tryAcquire, acquire, size };
}
