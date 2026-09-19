/**
 * dsh-wait-subagent — register a `wait_subagent` model-facing tool that
 * blocks until a background continuable subagent settles, then returns
 * its stop reason and closing message.
 *
 * DSH's subagent system provides:
 *   - `subagent` with run_in_background:true → returns a subagentId, work
 *     continues asynchronously; the runtime sends a settlement notice later.
 *   - `subagent` with run_in_background:false → blocks at START time only.
 *   - `send_message` → fire-and-return (never waits for the answer).
 *   - `list_agents` → snapshot, not a wait (and explicitly "not to poll").
 *
 * What's missing: after starting a subagent in the background, there is no
 * tool to BLOCK and wait for it to finish. This plugin fills that gap.
 *
 * Registration pattern: same as dsh-proactive — listen for `agent/created`,
 * register the tool on every root agent's scoped context via `agentCtx.tools`.
 *
 * Wait mechanism: the `subagent/end` lifecycle event fires when a child
 * settles (after its activation is disposed). The plugin context is an
 * ancestor of all agent contexts, so a listener on `ctx` receives the event
 * for any child. Settlement removes the child from the live registry and
 * dispatches the event in the same synchronous block (finishDisposal), so
 * the race-free order is: attach listener, then re-check the registry.
 *
 * Membership gate: ctx.subagents.listChildren(parent.id) — the same
 * projection list_agents reads — covers live AND storage-only children,
 * so unknown ids are rejected with an error instead of being reported as
 * settled; a known child absent from the live registry has already settled.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "dsh-wait-subagent";
const inject = ["agents", "tools", "subagents"];

/** Extract readable text from a content-block array (subagent/end payload). */
function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** Human-readable summary for the model. */
function summary(value) {
  if (value.status === "settled") {
    if (value.stop_reason === "unknown")
      return `Subagent ${value.subagent_id} had already settled before this call; its closing message was delivered separately as a settlement notice.`;
    const parts = [`Subagent ${value.subagent_id} settled: ${value.stop_reason}`];
    if (value.closing_message) parts.push(value.closing_message);
    else parts.push("(no closing message)");
    return parts.join("\n");
  }
  if (value.status === "timeout")
    return `Timed out waiting for subagent ${value.subagent_id}; it may still be running.`;
  if (value.status === "cancelled")
    return `Wait for subagent ${value.subagent_id} was cancelled.`;
  return JSON.stringify(value);
}

function apply(ctx) {
  const registered = new WeakSet();

  function registerOne(agent) {
    if (registered.has(agent)) return;
    // Only root agents get the tool (same gate as dsh-proactive).
    if (!ctx.agents.roots().includes(agent)) return;
    registered.add(agent);

    agent.ctx.effect(
      () => {
        const disposer = agent.ctx.tools.register(
          defineTool({
            name: "wait_subagent",
            description:
              "Block until a background continuable subagent settles (finishes its current turn and all owned children), then return its stop reason and closing message. " +
              "Use this when you started a subagent in the background and your next action depends on its result — instead of guessing or polling with list_agents. " +
              "Prefer omitting timeout_ms and waiting as long as the subagent needs; if you set one, use a generous value — do not poll with repeated short waits. " +
              "The subagent must be one of your own background children; unknown ids are rejected with an error. " +
              "If the subagent already settled before this call, returns immediately with status 'settled'.",
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
                  "Maximum milliseconds to wait before returning status 'timeout'. Omit to wait indefinitely — usually the best choice. If set, use a generous value (minutes, not seconds); polling a subagent with repeated short waits is an anti-pattern — you are notified the moment it settles.",
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
                      closing_message: extractText(info.lastAssistantMessage),
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

                // Optional timeout.
                if (timeoutMs && timeoutMs > 0) {
                  timer = setTimeout(() => {
                    finish({ status: "timeout", subagent_id: childId });
                  }, timeoutMs);
                }
              });
            },
          }),
        );
        return () => disposer();
      },
      "dsh-wait-subagent:tool",
    );
  }

  // Register on existing root agents and listen for new ones.
  // Plugin-scoped ctx.on registrations auto-dispose with the plugin fiber,
  // so no manual cleanup is needed here.
  ctx.on("agent/created", ({ agent }) => registerOne(agent));
  for (const existing of ctx.agents.roots()) registerOne(existing);
}

export { apply, inject, name };
