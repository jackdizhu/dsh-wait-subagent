/**
 * dsh-wait-subagent — routing and the dispatch engine (task-scheduler v3).
 *
 * `planRoute(kind, config)` maps a task kind onto the activation backend:
 *   - "explore" → in-process fork child (inherits the parent context, keeps
 *     the parent's reasoning effort);
 *   - "execute" → in-process spawn child under the zero-decision executor
 *     preset at the configured (lowest) reasoning effort.
 *
 * `createDispatcher(ctx, config)` owns the two arbitration resources shared
 * by every dispatch call:
 *   - one `createScopeQueue()` singleton, so tasks that share a path prefix
 *     serialize FIFO even when they arrive in different batches;
 *   - one concurrency semaphore capped at `config.dispatch.concurrency`
 *     (validated to 1..10 by resolveConfig).
 *
 * `dispatch({ parent, tasks, signal, cwdFallback })` validates the batch,
 * pre-allocates `child_id`/`task_id`, and either starts each child now
 * (`state: "started"`) or queues it behind a scope/concurrency slot
 * (`state: "queued"`). It never waits for a child result: the launch runs
 * as a background promise and the caller harvests children with
 * wait_subagent / wait_some_subagent / wait_every_subagent.
 *
 * Both arbitration resources are released twice over: on launch failure and
 * when `activation.result` settles — success and failure alike — so a
 * failed start can never leak a slot and deadlock the queue.
 *
 * Validation errors throw `Error` with the `dispatch_tasks: ` prefix. Background
 * launch errors are recorded on the returned task entry (`state: "failed"`,
 * `error`) and reported through `ctx.logger.warn`; nothing is swallowed.
 */

import { randomUUID } from "node:crypto";
import { createScopeQueue, normalizeScope } from "./write-scope.js";

/** Fixed prefix for every validation error raised by this module. */
const ERROR_PREFIX = "dispatch_tasks: ";

/** Build one validation error with the module's fixed prefix. */
function dispatchError(message) {
  return new Error(ERROR_PREFIX + message);
}

/**
 * Map a task kind onto its activation backend.
 *
 * @param {"explore"|"execute"} kind routing kind
 * @param {object} config resolved plugin config (see lib/config.js)
 * @returns {{provider: string, agentPreset: string|undefined, agentOptions: object|undefined}}
 * @throws {Error} `dispatch_tasks: kind must be "explore" or "execute", got "..."` for other kinds
 */
export function planRoute(kind, config) {
  if (kind === "explore") {
    return {
      provider: config.explore.provider,
      agentPreset: undefined,
      agentOptions: undefined,
    };
  }
  if (kind === "execute") {
    return {
      provider: config.execute.provider,
      agentPreset: config.execute.agentPreset,
      agentOptions:
        config.execute.reasoningEffort === undefined
          ? undefined
          : { reasoningEffort: config.execute.reasoningEffort },
    };
  }
  throw new Error('dispatch_tasks: kind must be "explore" or "execute", got "' + kind + '"');
}

/**
 * Validate and normalize the incoming batch. Normalization happens once, here,
 * so every downstream comparison works on canonical scope strings.
 *
 * @param {unknown} tasks raw `tasks` argument
 * @returns {{index: number, task: object, scope: string[]}[]} validated entries
 * @throws {Error} `dispatch_tasks: ...` on the first invalid entry
 */
function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw dispatchError("tasks must be a non-empty array");
  }

  const items = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const at = `tasks[${index}]`;

    if (task === null || typeof task !== "object" || Array.isArray(task)) {
      throw dispatchError(`${at} must be an object`);
    }
    if (task.kind !== "explore" && task.kind !== "execute") {
      throw dispatchError(`${at}.kind must be "explore" or "execute"`);
    }
    if (typeof task.label !== "string" || task.label.length === 0) {
      throw dispatchError(`${at}.label must be a non-empty string`);
    }
    if (typeof task.prompt !== "string" || task.prompt.length === 0) {
      throw dispatchError(`${at}.prompt must be a non-empty string`);
    }
    if (task.cwd !== undefined && typeof task.cwd !== "string") {
      throw dispatchError(`${at}.cwd must be a string or undefined`);
    }

    let scope;
    try {
      scope = normalizeScope(task.write_scope);
    } catch (err) {
      throw dispatchError(`${at}.write_scope ${err?.message ?? String(err)}`);
    }

    items.push({ index, task, scope });
  }
  return items;
}

/**
 * Create a FIFO counting semaphore for launched-but-unsettled children.
 *
 * @param {number} limit maximum simultaneous activations (1..10)
 * @returns {{
 *   tryAcquire: () => (() => void) | null,
 *   acquire: () => Promise<() => void>,
 *   size: () => { active: number, waiting: number },
 * }}
 */
function createSemaphore(limit) {
  let active = 0;
  const waiting = [];

  /** Take one slot and return its idempotent release. */
  function takeSlot() {
    active += 1;
    let released = false;

    return function releaseSlot() {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiting.shift();
      if (next !== undefined) next.resolve(takeSlot());
    };
  }

  function tryAcquire() {
    if (active < limit) return takeSlot();
    return null;
  }

  function acquire() {
    if (active < limit && waiting.length === 0) return Promise.resolve(takeSlot());
    return new Promise((resolve) => {
      waiting.push({ resolve });
    });
  }

  function size() {
    return { active, waiting: waiting.length };
  }

  return { tryAcquire, acquire, size };
}

/**
 * Build the dispatcher shared by every dispatch_tasks call of one plugin
 * instance. The scope queue and the concurrency semaphore live here, so
 * arbitration spans batches.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @param {object} config resolved plugin config
 * @returns {{dispatch: (input: {
 *   parent: object, tasks: unknown, signal: AbortSignal|undefined, cwdFallback: string,
 * }) => {tasks: object[]}}}
 */
export function createDispatcher(ctx, config) {
  const scopeQueue = createScopeQueue();
  const semaphore = createSemaphore(config.dispatch.concurrency);

  /** Report a problem without ever letting the logger break the pipeline. */
  function logWarning(message) {
    try {
      ctx?.logger?.warn?.(message);
    } catch {
      // A throwing logger must not break dispatch; the caller still gets state "failed".
    }
  }

  /** Wrap two releases into one idempotent release; a release never throws outward. */
  function combineReleases(...releases) {
    let released = false;
    return function releaseAll() {
      if (released) return;
      released = true;
      for (const release of releases) {
        try {
          release();
        } catch (err) {
          logWarning("dispatch_tasks: release failed: " + (err?.message ?? String(err)));
        }
      }
    };
  }

  /**
   * Start one activation in the background. `entry` carries everything the
   * asynchronous launch needs; `releaseAll` frees the concurrency slot and
   * the scope slot exactly once — on start failure and on settlement.
   */
  function startEntry(entry) {
    Promise.resolve()
      .then(() =>
        ctx.subagents.startActivation({
          provider: entry.plan.provider,
          label: entry.task.label,
          childId: entry.childId,
          signal: entry.signal,
          delivery: "caller",
          request: {
            parent: entry.parent,
            cwd: entry.task.cwd ?? entry.cwdFallback,
            prompt: [{ type: "text", text: entry.task.prompt }],
            ...(entry.plan.agentPreset !== undefined
              ? { agentPreset: entry.plan.agentPreset }
              : {}),
            ...(entry.plan.agentOptions !== undefined
              ? { agentOptions: entry.plan.agentOptions }
              : {}),
          },
        }),
      )
      .then((activation) => {
        // Release on success AND on failure, or the queues deadlock.
        activation.result.then(entry.releaseAll, entry.releaseAll);
      })
      .catch((err) => {
        entry.releaseAll();
        const message = err?.message ?? String(err);
        entry.ref.state = "failed";
        entry.ref.error = message;
        logWarning("dispatch_tasks: " + message);
      });
  }

  /**
   * Validate, pre-allocate ids, and start or queue every task.
   * Returns immediately; children run as background activations.
   */
  function dispatch({ parent, tasks, signal, cwdFallback }) {
    const items = validateTasks(tasks);
    const results = [];

    for (const item of items) {
      const plan = planRoute(item.task.kind, config);
      const childId = "subagent-" + randomUUID();
      const ref = {
        task_id: `task-${item.index + 1}`,
        child_id: childId,
        kind: item.task.kind,
        state: "queued",
        scope: item.scope,
      };
      results.push(ref);

      const entry = { parent, signal, task: item.task, plan, childId, cwdFallback, ref };

      // Scope first: a granted slot is held while waiting for a concurrency
      // slot, which is the only "hold one, wait for the other" direction and
      // is deadlock-free (scope holders are always launched or launch-bound
      // tasks whose slot frees on settlement).
      const scopeRelease = scopeQueue.tryAcquire(item.scope);
      if (scopeRelease === null) {
        // Someone holds a conflicting scope (or the scope queue is occupied):
        // queue FIFO behind that prefix, then take a concurrency slot.
        void (async () => {
          const scopeSlot = await scopeQueue.acquire(item.scope);
          const semaphoreSlot = await semaphore.acquire();
          startEntry({ ...entry, releaseAll: combineReleases(semaphoreSlot, scopeSlot) });
        })();
        continue;
      }

      const semaphoreRelease = semaphore.tryAcquire();
      if (semaphoreRelease === null) {
        // Scope is ours; wait for a free concurrency slot before launching.
        void (async () => {
          const semaphoreSlot = await semaphore.acquire();
          startEntry({ ...entry, releaseAll: combineReleases(semaphoreSlot, scopeRelease) });
        })();
        continue;
      }

      ref.state = "started";
      startEntry({ ...entry, releaseAll: combineReleases(semaphoreRelease, scopeRelease) });
    }

    return { tasks: results };
  }

  return { dispatch };
}
