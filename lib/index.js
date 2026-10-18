/**
 * dsh-wait-subagent v1.2 — active wait + liveness status for background
 * continuable subagents in DeepSeek Harness.
 *
 * v1.0 registered `wait_subagent`: blocks until a background continuable
 * subagent settles, then returns its stop reason and closing message.
 *
 * v1.1 added (all feature-detected, never throws on unknown payload shapes):
 *   - liveness tracking (see "Liveness mechanism" below) feeding the
 *     non-blocking status probe and the timeout diagnostics,
 *   - a first-of-N wait for parallel fan-out harvesting (see
 *     `wait_some_subagent` below),
 *   - `wait_subagent` timeout results now carry `diagnostics` (last activity
 *     age, turn count, recent output snippets) so a timeout is actionable,
 *   - closing_message fallback: when the settlement payload has no text,
 *     the most recent observed assistant output is used instead.
 *
 * v1.2 tool surface — four tools on every root agent (local plugin, so
 * superseded names are removed outright, no compatibility aliases):
 *   - `wait_subagent(subagent_id, timeout_ms?)` — unchanged: block until one
 *     background child settles and return its stop reason + closing message.
 *   - `get_subagent_status(subagent_id)` — non-blocking liveness probe
 *     (v1.2 rename; semantics, parameters, and output are unchanged).
 *   - `wait_some_subagent(subagent_ids[], timeout_ms?)` — block until the
 *     FIRST of the listed children settles (v1.2 rename of the v1.1
 *     first-of-N tool; implementation and semantics unchanged, description
 *     refreshed). For harvesting parallel fan-outs one result at a time.
 *   - `wait_every_subagent(subagent_ids[], timeout_ms?)` — NEW barrier: block
 *     until EVERY listed child has settled, then return per-child results in
 *     input order plus a `failed` list (ids whose stop_reason is not
 *     "completed"); on timeout the still-running ids are listed under
 *     `pending` with activity diagnostics.
 *   Across all three waits, settlement includes abnormal endings: error /
 *   aborted / max-tokens / refusal all fire `subagent/end` and count as
 *   settled; stop_reason distinguishes success from failure, so a failing
 *   child can never hang a wait.
 *
 * DSH's subagent system provides:
 *   - `subagent` with run_in_background:true → returns a subagentId, work
 *     continues asynchronously; the runtime sends a settlement notice later.
 *   - `subagent` with run_in_background:false → blocks at START time only.
 *   - `send_message` → fire-and-return (never waits for the answer).
 *   - `list_agents` → snapshot, not a wait (and explicitly "not to poll").
 *
 * Registration pattern: same as dsh-proactive — listen for `agent/created`,
 * register tools on every root agent's scoped context via `agentCtx.tools`.
 *
 * Wait mechanism: the `subagent/end` lifecycle event fires when a child
 * settles (after its activation is disposed). The plugin context is an
 * ancestor of all agent contexts, so a listener on `ctx` receives the event
 * for any child. Settlement removes the child from the live registry and
 * dispatches the event in the same synchronous block (finishDisposal), so
 * the race-free order is: attach listener, then re-check the registry.
 *
 * Liveness mechanism (v1.1, best-effort): subscribe to `subagent/
 * assistant-output` and `agent/status` on the plugin context. Payload shapes
 * are intentionally feature-detected (`id` / `subagentId` / `agentId` /
 * `agent.id`); unresolvable payloads are ignored. Observed activity feeds
 * `get_subagent_status` and the timeout diagnostics; absence of observations
 * is reported honestly ("not observed") rather than guessed about.
 *
 * Membership gate: ctx.subagents.listChildren(parent.id) — the same
 * projection list_agents reads — covers live AND storage-only children,
 * so unknown ids are rejected with an error instead of being
 * misreported as settled; a known child absent from the live registry has
 * already settled.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "dsh-wait-subagent";
const inject = ["agents", "tools", "subagents"];

// ---------------------------------------------------------------------------
// Activity tracking (v1.1)
// ---------------------------------------------------------------------------

const MAX_SNIPPETS = 5;
const SNIPPET_CHARS = 200;
const MAX_TRACKED = 256;

/**
 * Per-child activity record. Keyed by child id.
 * @type {Map<string, {lastActivity:number, turnCount:number, recentOutputs:string[]}>}
 */
const activity = new Map();

/** Extract readable text from a content-block array or plain string. */
function extractText(blocksOrString) {
  if (typeof blocksOrString === "string") return blocksOrString;
  if (!Array.isArray(blocksOrString)) return "";
  return blocksOrString
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** Feature-detect a child id from an event payload of unknown shape. */
function extractId(info) {
  if (!info || typeof info !== "object") return undefined;
  if (typeof info.id === "string") return info.id;
  if (typeof info.subagentId === "string") return info.subagentId;
  if (typeof info.agentId === "string") return info.agentId;
  if (info.agent && typeof info.agent === "object" && typeof info.agent.id === "string") {
    return info.agent.id;
  }
  return undefined;
}

/** Feature-detect a short assistant-output snippet from an unknown payload. */
function extractSnippet(info) {
  const raw =
    info?.lastAssistantMessage ??
    info?.message ??
    info?.text ??
    info?.blocks ??
    info?.content;
  const text = extractText(raw);
  return text ? text.slice(0, SNIPPET_CHARS) : "";
}

/** Record an activity touch (and optional snippet) for a child id. */
function noteActivity(id, snippet) {
  if (typeof id !== "string" || id.length === 0) return;
  let entry = activity.get(id);
  if (!entry) {
    if (activity.size >= MAX_TRACKED) {
      const oldest = activity.keys().next().value;
      if (oldest !== undefined) activity.delete(oldest);
    }
    entry = { lastActivity: 0, turnCount: 0, recentOutputs: [] };
    activity.set(id, entry);
  }
  entry.lastActivity = Date.now();
  if (snippet) {
    entry.turnCount += 1;
    entry.recentOutputs.push(snippet);
    if (entry.recentOutputs.length > MAX_SNIPPETS) entry.recentOutputs.shift();
  }
}

/** Diagnostics for one id; honest about "never observed". */
function diagnosticsFor(id) {
  const entry = activity.get(id);
  if (!entry || entry.lastActivity === 0) return { observed: false };
  return {
    observed: true,
    lastActivityAgoMs: Date.now() - entry.lastActivity,
    turnCount: entry.turnCount,
    recentOutputs: [...entry.recentOutputs],
  };
}

function lastSnippet(id) {
  const entry = activity.get(id);
  if (!entry || entry.recentOutputs.length === 0) return "";
  return entry.recentOutputs[entry.recentOutputs.length - 1];
}

function describeDiagnostics(d) {
  if (!d || d.observed !== true) {
    return "no activity observed by this plugin since it started (the child may predate the plugin, or it has emitted nothing — likely stalled at startup)";
  }
  const agoSec = Math.max(1, Math.round((d.lastActivityAgoMs ?? 0) / 1000));
  const tail = d.recentOutputs?.length
    ? ` latest output: "${d.recentOutputs[d.recentOutputs.length - 1]}"`
    : "";
  return `last activity ${agoSec}s ago across ${d.turnCount} observed turn(s)${tail}`;
}

// ---------------------------------------------------------------------------
// Tool summaries
// ---------------------------------------------------------------------------

/** Human-readable summary for wait_subagent / wait_some_subagent results. */
function summary(value) {
  if (value.status === "settled") {
    if (value.stop_reason === "unknown")
      return `Subagent ${value.subagent_id} had already settled before this call; its closing message was delivered separately as a settlement notice.`;
    const parts = [`Subagent ${value.subagent_id} settled: ${value.stop_reason}`];
    if (value.closing_message) parts.push(value.closing_message);
    else parts.push("(no closing message)");
    return parts.join("\n");
  }
  if (value.status === "timeout") {
    const parts = [`Timed out waiting for subagent ${value.subagent_id}; it may still be running.`];
    if (value.diagnostics) parts.push(describeDiagnostics(value.diagnostics));
    return parts.join("\n");
  }
  if (value.status === "cancelled")
    return `Wait for subagent ${value.subagent_id} was cancelled.`;
  return JSON.stringify(value);
}

/** Human-readable summary for wait_every_subagent (barrier) results. */
function summaryEvery(args, value) {
  if (value.status === "settled") {
    const results = value.results ?? [];
    const lines = results.map((r) => {
      const parts = [`Subagent ${r.subagent_id} settled: ${r.stop_reason}`];
      if (r.closing_message) parts.push(r.closing_message);
      else parts.push("(no closing message)");
      return parts.join("\n");
    });
    if (value.failed && value.failed.length > 0) {
      lines.push(`Failed: ${value.failed.join(", ")}`);
    } else {
      lines.push(`All ${results.length} subagents settled successfully.`);
    }
    return lines.join("\n");
  }
  if (value.status === "timeout") {
    const distinctIds = [
      ...new Set(
        (Array.isArray(args?.subagent_ids) ? args.subagent_ids : []).filter(
          (id) => typeof id === "string" && id.length > 0,
        ),
      ),
    ];
    const total = distinctIds.length;
    const stillRunning = value.pending?.length ?? 0;
    const settledCount = Math.max(0, total - stillRunning);
    const lines = [`Timed out: ${settledCount}/${total} settled, ${stillRunning} still running.`];
    for (const p of value.pending ?? []) {
      lines.push(`Subagent ${p.subagent_id}: ${describeDiagnostics(p)}`);
    }
    return lines.join("\n");
  }
  if (value.status === "cancelled")
    return "Wait for the listed subagents was cancelled.";
  return JSON.stringify(value);
}

function statusSummary(value) {
  if (value.status === "settled") {
    return `Subagent ${value.subagent_id} has already settled (before this call); no live status available.`;
  }
  if (value.observed) {
    return [
      `Subagent ${value.subagent_id} is running — last activity ${Math.max(
        1,
        Math.round((value.lastActivityAgoMs ?? 0) / 1000),
      )}s ago across ${value.turnCount} observed turn(s).`,
      ...(value.recentOutputs?.length
        ? [`Recent output: "${value.recentOutputs[value.recentOutputs.length - 1]}"`]
        : []),
    ].join("\n");
  }
  return `Subagent ${value.subagent_id} is running, but this plugin has not observed any activity from it (spawned before plugin load, or silent so far).`;
}

// ---------------------------------------------------------------------------
// Plugin apply
// ---------------------------------------------------------------------------

function apply(ctx) {
  const registered = new WeakSet();

  // Best-effort liveness subscriptions at plugin scope (auto-disposed with
  // the plugin fiber). Unknown payload shapes are ignored silently.
  try {
    ctx.on("subagent/assistant-output", (info) => {
      const id = extractId(info);
      if (id) noteActivity(id, extractSnippet(info));
    });
  } catch {
    // Event not available on this DSH version — liveness features degrade.
  }
  try {
    ctx.on("agent/status", (info) => {
      const id = extractId(info);
      if (id) noteActivity(id, "");
    });
  } catch {
    // Event not available on this DSH version — liveness features degrade.
  }

  function registerOne(agent) {
    if (registered.has(agent)) return;
    // Only root agents get the tools (same gate as dsh-proactive).
    if (!ctx.agents.roots().includes(agent)) return;
    registered.add(agent);

    agent.ctx.effect(
      () => {
        // -----------------------------------------------------------------
        // Tool 1 (v1.0, kept): wait_subagent
        // -----------------------------------------------------------------
        const disposeWait = agent.ctx.tools.register(
          defineTool({
            name: "wait_subagent",
            description:
              "Block until a background continuable subagent settles (finishes its current turn and all owned children), then return its stop reason and closing message. " +
              "Use this when you started a subagent in the background and your next action depends on its result — instead of guessing or polling with list_agents. " +
              "Prefer omitting timeout_ms and waiting as long as the subagent needs; if you set one, use a generous value — do not poll with repeated short waits. " +
              "On timeout the result includes diagnostics (last observed activity, turn count, recent output) so you can tell stalled from still-working. " +
              "The subagent must be one of your own background children; unknown ids are rejected with an error. " +
              "If the subagent already settled before this call, returns immediately with status 'settled'. " +
              "Settlement includes abnormal endings: error, abort, max-tokens, and refusal all count as settled — tell success from failure via stop_reason. " +
              "Division of labor: wait on a single child with this tool; harvest parallel fan-out one at a time with wait_some_subagent; barrier across all children with wait_every_subagent; probe liveness mid-flight with get_subagent_status.",
            parameters: {
              subagent_id: {
                type: "string",
                required: true,
                description:
                  "The subagent id returned when the background subagent was started (the subagentId from the subagent tool's continuable result).",
              },
              timeout_ms: {
                type: "integer",
                description:
                  "Maximum milliseconds to wait before returning status 'timeout' (with activity diagnostics). Omit to wait indefinitely — usually the best choice. If set, use a generous value (minutes, not seconds).",
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  status: {
                    type: "string",
                    required: true,
                    enum: ["settled", "timeout", "cancelled"],
                  },
                  subagent_id: { type: "string", required: true },
                  // Present only for status 'settled'.
                  stop_reason: {
                    type: "string",
                    enum: ["completed", "aborted", "error", "max-tokens", "refusal", "unknown"],
                  },
                  closing_message: { type: "string" },
                  // Present only for status 'timeout'.
                  diagnostics: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      observed: { type: "boolean", required: true },
                      lastActivityAgoMs: { type: "integer" },
                      turnCount: { type: "integer" },
                      recentOutputs: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
              render: (_args, value) => [{ type: "text", text: summary(value) }],
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const parent = exec.agent;
              if (!parent)
                throw new Error("wait_subagent requires a calling agent (exec.agent was undefined)");

              const childId = args.subagent_id;
              // Omitted timeout_ms means wait indefinitely.
              const timeoutMs = args.timeout_ms;

              // Authoritative membership check (same API as list_agents):
              // the continuable projection covers live AND storage-only
              // children, so a bogus id is rejected instead of being
              // misreported as settled. A real child that is not in the live
              // registry already settled (before this call or before this
              // dsh process started).
              const children = await ctx.subagents.listChildren(parent.id, exec.signal);
              if (!children.some((entry) => entry.id === childId)) {
                throw new Error(
                  `wait_subagent: "${childId}" is not one of your subagents — pass the id a background dispatch returned (see list_agents)`,
                );
              }
              if (ctx.agents.get(childId) === undefined) {
                return { status: "settled", subagent_id: childId, stop_reason: "unknown" };
              }

              // Wait for the subagent/end lifecycle event (fires when the
              // child's activation is disposed), a timeout, or cancellation.
              // Cordis has no ctx.off(): ctx.on() returns the disposer.
              return new Promise((resolve) => {
                let done = false;
                let timer;
                let disposeEnd;

                function finish(result) {
                  if (done) return;
                  done = true;
                  try {
                    cleanup();
                  } catch {
                    // Cleanup must never crash the process or hang the tool.
                  }
                  resolve(result);
                }

                function cleanup() {
                  if (disposeEnd) disposeEnd();
                  exec.signal.removeEventListener("abort", onAbort);
                  if (timer) clearTimeout(timer);
                }

                const onEnd = (info) => {
                  if (info && info.id === childId) {
                    finish({
                      status: "settled",
                      subagent_id: childId,
                      stop_reason: info.stopReason ?? "unknown",
                      closing_message:
                        extractText(info.lastAssistantMessage) || lastSnippet(childId) || "",
                    });
                  }
                };

                const onAbort = () => {
                  finish({ status: "cancelled", subagent_id: childId });
                };

                // Register on the plugin context — it is an ancestor of all
                // agent contexts, so it receives every scoped subagent/end.
                disposeEnd = ctx.on("subagent/end", onEnd);
                exec.signal.addEventListener("abort", onAbort);

                // Double-check after registering: settlement removes the child
                // from the live registry and dispatches subagent/end in the
                // same synchronous block, so attaching the listener first
                // makes this check race-free.
                if (ctx.agents.get(childId) === undefined) {
                  finish({ status: "settled", subagent_id: childId, stop_reason: "unknown" });
                }

                // Optional timeout, now with diagnostics.
                if (timeoutMs && timeoutMs > 0) {
                  timer = setTimeout(() => {
                    finish({ status: "timeout", subagent_id: childId, diagnostics: diagnosticsFor(childId) });
                  }, timeoutMs);
                }
              });
            },
          }),
        );

        // -----------------------------------------------------------------
        // Tool 2 (v1.1, renamed in v1.2): get_subagent_status — non-blocking
        // liveness probe
        // -----------------------------------------------------------------
        const disposeStatus = agent.ctx.tools.register(
          defineTool({
            name: "get_subagent_status",
            description:
              "Non-blocking liveness probe for one of your background subagents: reports whether it is still running, how long ago it last emitted activity, how many observed turns it has produced, and its most recent output snippet. " +
              "Use this to tell 'still working' from 'silently stalled' mid-flight — e.g. before deciding to keep waiting, interrupt, or re-dispatch. " +
              "Does not block and does not wait. If the child already settled, reports that. Observations come from this plugin's event listeners; 'not observed' is reported honestly (the child may predate the plugin load or have emitted nothing yet).",
            parameters: {
              subagent_id: {
                type: "string",
                required: true,
                description: "The subagent id returned by the background subagent dispatch.",
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  status: { type: "string", required: true, enum: ["running", "settled"] },
                  subagent_id: { type: "string", required: true },
                  observed: { type: "boolean", required: true },
                  lastActivityAgoMs: { type: "integer" },
                  turnCount: { type: "integer" },
                  recentOutputs: { type: "array", items: { type: "string" } },
                },
              },
              render: (_args, value) => [{ type: "text", text: statusSummary(value) }],
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const parent = exec.agent;
              if (!parent)
                throw new Error("get_subagent_status requires a calling agent (exec.agent was undefined)");
              const childId = args.subagent_id;

              const children = await ctx.subagents.listChildren(parent.id, exec.signal);
              if (!children.some((entry) => entry.id === childId)) {
                throw new Error(
                  `get_subagent_status: "${childId}" is not one of your subagents — pass the id a background dispatch returned (see list_agents)`,
                );
              }
              if (ctx.agents.get(childId) === undefined) {
                return { status: "settled", subagent_id: childId, observed: false };
              }

              const d = diagnosticsFor(childId);
              if (!d.observed) {
                return { status: "running", subagent_id: childId, observed: false };
              }
              return {
                status: "running",
                subagent_id: childId,
                observed: true,
                lastActivityAgoMs: d.lastActivityAgoMs,
                turnCount: d.turnCount,
                recentOutputs: d.recentOutputs,
              };
            },
          }),
        );

        // -----------------------------------------------------------------
        // Tool 3 (v1.1 first-settler wait, renamed + described anew in
        // v1.2): wait_some_subagent — first-of-N settlement
        // -----------------------------------------------------------------
        const disposeSome = agent.ctx.tools.register(
          defineTool({
            name: "wait_some_subagent",
            description:
              "Block until the FIRST of the listed background subagents settles, then return that subagent's id, stop reason, and closing message. " +
              "Settlement includes abnormal endings: error, abort, max-tokens, and refusal all count as settled — tell success from failure via stop_reason. " +
              "Use this to harvest parallel fan-out dispatches one at a time without polling: call it repeatedly (re-listing the still-running ids) until all children are collected. " +
              "When you need a barrier instead — continue only after every child has finished — use wait_every_subagent; for a single child use wait_subagent; to probe liveness mid-flight without blocking use get_subagent_status. " +
              "Every listed id must be one of your own subagents; if any listed child has already settled, returns immediately with that id and stop_reason 'unknown'. " +
              "Prefer omitting timeout_ms; if you set one, use a generous value (minutes, not seconds).",
            parameters: {
              subagent_ids: {
                type: "array",
                items: { type: "string" },
                required: true,
                description: "Two or more subagent ids returned by background dispatches.",
              },
              timeout_ms: {
                type: "integer",
                description:
                  "Maximum milliseconds to wait before returning status 'timeout' (with per-id diagnostics). Omit to wait indefinitely — usually the best choice.",
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  status: {
                    type: "string",
                    required: true,
                    enum: ["settled", "timeout", "cancelled"],
                  },
                  subagent_id: { type: "string", required: true },
                  stop_reason: {
                    type: "string",
                    enum: ["completed", "aborted", "error", "max-tokens", "refusal", "unknown"],
                  },
                  closing_message: { type: "string" },
                  diagnostics: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      observed: { type: "boolean", required: true },
                      lastActivityAgoMs: { type: "integer" },
                      turnCount: { type: "integer" },
                      recentOutputs: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
              render: (_args, value) => [{ type: "text", text: summary(value) }],
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const parent = exec.agent;
              if (!parent)
                throw new Error("wait_some_subagent requires a calling agent (exec.agent was undefined)");

              // Dedupe, preserve order, require at least two distinct ids.
              const ids = [...new Set((args.subagent_ids ?? []).filter(
                (id) => typeof id === "string" && id.length > 0,
              ))];
              if (ids.length < 2) {
                throw new Error(
                  "wait_some_subagent: pass at least two distinct subagent ids (use wait_subagent for a single child)",
                );
              }
              const timeoutMs = args.timeout_ms;

              const children = await ctx.subagents.listChildren(parent.id, exec.signal);
              const known = new Set(children.map((entry) => entry.id));
              for (const id of ids) {
                if (!known.has(id)) {
                  throw new Error(
                    `wait_some_subagent: "${id}" is not one of your subagents — pass the ids background dispatches returned (see list_agents)`,
                  );
                }
              }
              // Any already-settled child returns immediately (same semantics
              // as wait_subagent's pre-settled path).
              for (const id of ids) {
                if (ctx.agents.get(id) === undefined) {
                  return { status: "settled", subagent_id: id, stop_reason: "unknown" };
                }
              }

              const idSet = new Set(ids);
              return new Promise((resolve) => {
                let done = false;
                let timer;
                let disposeEnd;

                function finish(result) {
                  if (done) return;
                  done = true;
                  try {
                    cleanup();
                  } catch {
                    // Cleanup must never crash the process or hang the tool.
                  }
                  resolve(result);
                }

                function cleanup() {
                  if (disposeEnd) disposeEnd();
                  exec.signal.removeEventListener("abort", onAbort);
                  if (timer) clearTimeout(timer);
                }

                const onEnd = (info) => {
                  if (info && typeof info.id === "string" && idSet.has(info.id)) {
                    finish({
                      status: "settled",
                      subagent_id: info.id,
                      stop_reason: info.stopReason ?? "unknown",
                      closing_message:
                        extractText(info.lastAssistantMessage) || lastSnippet(info.id) || "",
                    });
                  }
                };

                const onAbort = () => {
                  finish({ status: "cancelled", subagent_id: ids[0] });
                };

                disposeEnd = ctx.on("subagent/end", onEnd);
                exec.signal.addEventListener("abort", onAbort);

                // Race-free re-check (same synchronous-block argument as v1.0).
                for (const id of ids) {
                  if (ctx.agents.get(id) === undefined) {
                    finish({ status: "settled", subagent_id: id, stop_reason: "unknown" });
                    return;
                  }
                }

                if (timeoutMs && timeoutMs > 0) {
                  timer = setTimeout(() => {
                    // Report diagnostics for the least-recently-active child.
                    let pick = ids[0];
                    let oldest = Infinity;
                    for (const id of ids) {
                      const d = diagnosticsFor(id);
                      const ts = d.observed ? Date.now() - d.lastActivityAgoMs : -1;
                      if (ts < oldest) {
                        oldest = ts;
                        pick = id;
                      }
                    }
                    finish({ status: "timeout", subagent_id: pick, diagnostics: diagnosticsFor(pick) });
                  }, timeoutMs);
                }
              });
            },
          }),
        );

        // -----------------------------------------------------------------
        // Tool 4 (v1.2, new): wait_every_subagent — barrier until EVERY
        // listed child has settled
        // -----------------------------------------------------------------
        const disposeEvery = agent.ctx.tools.register(
          defineTool({
            name: "wait_every_subagent",
            description:
              "Block until EVERY listed background subagent has settled, then return each child's id, stop reason, and closing message, ordered as the input ids. " +
              "Settlement includes abnormal endings: error, abort, max-tokens, and refusal all count as settled, so a failing child can never hang this wait — tell success from failure via stop_reason; the failed list collects the ids whose stop_reason is not 'completed'. " +
              "Use this as a barrier/join when your next action needs all the fan-out results at once (e.g. merging parallel reports before continuing). " +
              "To harvest one result at a time as children finish instead, use wait_some_subagent; for a single child use wait_subagent; to probe liveness mid-flight without blocking use get_subagent_status. " +
              "Every listed id must be one of your own subagents; children that already settled before the call are reported with stop_reason 'unknown'. " +
              "Prefer omitting timeout_ms and waiting as long as the children need; if you set one, use a generous value (minutes, not seconds) — on timeout the still-running ids are listed under pending (no partial results).",
            parameters: {
              subagent_ids: {
                type: "array",
                items: { type: "string" },
                required: true,
                description: "Two or more subagent ids returned by background dispatches.",
              },
              timeout_ms: {
                type: "integer",
                description:
                  "Maximum milliseconds to wait before returning status 'timeout' (with the still-running ids listed under pending). Omit to wait indefinitely — usually the best choice.",
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  status: {
                    type: "string",
                    required: true,
                    enum: ["settled", "timeout", "cancelled"],
                  },
                  // Present only for status 'settled', in input-id order.
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        subagent_id: { type: "string", required: true },
                        stop_reason: {
                          type: "string",
                          required: true,
                          enum: ["completed", "aborted", "error", "max-tokens", "refusal", "unknown"],
                        },
                        closing_message: { type: "string", required: true },
                      },
                    },
                  },
                  // Present for status 'settled' when non-empty.
                  failed: { type: "array", items: { type: "string" } },
                  // Present only for status 'timeout'.
                  pending: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        subagent_id: { type: "string", required: true },
                        observed: { type: "boolean", required: true },
                        lastActivityAgoMs: { type: "integer" },
                        turnCount: { type: "integer" },
                        recentOutputs: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                },
              },
              render: (args, value) => [{ type: "text", text: summaryEvery(args, value) }],
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const parent = exec.agent;
              if (!parent)
                throw new Error("wait_every_subagent requires a calling agent (exec.agent was undefined)");

              // Dedupe, preserve order, require at least two distinct ids.
              const ids = [...new Set((args.subagent_ids ?? []).filter(
                (id) => typeof id === "string" && id.length > 0,
              ))];
              if (ids.length < 2) {
                throw new Error(
                  "wait_every_subagent: pass at least two distinct subagent ids (use wait_subagent for a single child)",
                );
              }
              const timeoutMs = args.timeout_ms;

              // Same membership gate as the other waits.
              const children = await ctx.subagents.listChildren(parent.id, exec.signal);
              const known = new Set(children.map((entry) => entry.id));
              for (const id of ids) {
                if (!known.has(id)) {
                  throw new Error(
                    `wait_every_subagent: "${id}" is not one of your subagents — pass the ids background dispatches returned (see list_agents)`,
                  );
                }
              }

              const idSet = new Set(ids);
              /** @type {Map<string, {subagent_id:string, stop_reason:string, closing_message:string}>} */
              const results = new Map();
              return new Promise((resolve) => {
                let done = false;
                let timer;
                let disposeEnd;

                function finish(result) {
                  if (done) return;
                  done = true;
                  try {
                    cleanup();
                  } catch {
                    // Cleanup must never crash the process or hang the tool.
                  }
                  resolve(result);
                }

                function cleanup() {
                  if (disposeEnd) disposeEnd();
                  exec.signal.removeEventListener("abort", onAbort);
                  if (timer) clearTimeout(timer);
                }

                // Record one settled child; resolve only when the barrier
                // completes (every listed id recorded, input order preserved).
                const recordEnd = (id, stopReason, closingMessage) => {
                  if (results.has(id)) return;
                  results.set(id, { subagent_id: id, stop_reason: stopReason, closing_message: closingMessage });
                  if (results.size === ids.length) {
                    const ordered = ids.map((id) => results.get(id));
                    const failed = ordered
                      .filter((r) => r.stop_reason !== "completed")
                      .map((r) => r.subagent_id);
                    finish({
                      status: "settled",
                      results: ordered,
                      ...(failed.length > 0 ? { failed } : {}),
                    });
                  }
                };

                const onEnd = (info) => {
                  if (info && typeof info.id === "string" && idSet.has(info.id)) {
                    recordEnd(
                      info.id,
                      info.stopReason ?? "unknown",
                      extractText(info.lastAssistantMessage) || lastSnippet(info.id) || "",
                    );
                  }
                };

                const onAbort = () => {
                  finish({ status: "cancelled" });
                };

                // Register on the plugin context — it is an ancestor of all
                // agent contexts, so it receives every scoped subagent/end.
                disposeEnd = ctx.on("subagent/end", onEnd);
                exec.signal.addEventListener("abort", onAbort);

                // Race-free re-check (same synchronous-block argument as the
                // other waits): children absent from the live registry have
                // already settled; record them as 'unknown'. The barrier
                // resolves only once every listed id is recorded.
                for (const id of ids) {
                  if (ctx.agents.get(id) === undefined) {
                    recordEnd(id, "unknown", "");
                  }
                }

                if (timeoutMs && timeoutMs > 0) {
                  timer = setTimeout(() => {
                    const pending = ids
                      .filter((id) => !results.has(id))
                      .map((id) => ({ subagent_id: id, ...diagnosticsFor(id) }));
                    finish({ status: "timeout", pending });
                  }, timeoutMs);
                }
              });
            },
          }),
        );

        return () => {
          disposeWait();
          disposeStatus();
          disposeSome();
          disposeEvery();
        };
      },
      "dsh-wait-subagent:tools",
    );
  }

  // Register on existing root agents and listen for new ones.
  // Plugin-scoped ctx.on registrations auto-dispose with the plugin fiber,
  // so no manual cleanup is needed here.
  ctx.on("agent/created", ({ agent }) => registerOne(agent));
  for (const existing of ctx.agents.roots()) registerOne(existing);
}

export { apply, inject, name };
