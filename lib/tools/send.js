/**
 * dsh-wait-subagent — send_to_subagent tool definition (v1.3, new).
 *
 * `defineSendTool(ctx)` is called once per root agent from lib/index.js;
 * `ctx` is the plugin-scoped context (listChildren / agents.get) that the
 * tool's execute closes over — the same pattern as the four wait tools.
 *
 * Semantics: deliver a durable message to one of the caller's own background
 * subagents. A running child consumes it at its nearest step boundary via
 * `steer`; an idle child gets it as a new follow-up turn via `followup`.
 * A settled child is no longer in the live registry and cannot be revived —
 * the tool reports that honestly (`delivered: false`, reason
 * `already_settled`) instead of pretending to deliver. The parent agent
 * should dispatch a new subagent (or subagent_fork) instead.
 *
 * Message construction uses the host's `createUserMessage` from
 * @deepseek-ai/dsh-llm (peer+dev dependency, same policy as dsh-tools):
 * source is a plugin/relay provenance identifying this plugin as the
 * relay on behalf of the calling parent agent; content is a single text
 * block carrying the caller's message.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @returns the registered-ready send_to_subagent tool definition
 */
function defineSendTool(ctx) {
  return defineTool({
    name: "send_to_subagent",
    description:
      "Send a durable message to one of your own background subagents (the subagentId a background dispatch returned). " +
      "Delivery is adaptive: a running subagent consumes the message at its nearest step boundary (steer); " +
      "an idle subagent opens a new turn with it (followup). " +
      "Settled subagents cannot be revived — returned with delivered:false, dispatch a new subagent or subagent_fork instead. " +
      "The message must be one of your own background children; unknown ids are rejected with an error. " +
      "This is the subagent-id counterpart of send_message; the two target namespaces do not overlap. " +
      "Division of labor: steer or follow up a child mid-flight with this tool; wait on it with wait_subagent; " +
      "probe liveness first with get_subagent_status when unsure whether it is still running.",
    parameters: {
      subagent_id: {
        type: "string",
        required: true,
        description:
          "The subagent id returned when the background subagent was started (the subagentId from the subagent tool's continuable result).",
      },
      message: {
        type: "string",
        required: true,
        description:
          "The message text to deliver. Non-empty; delivered verbatim as one text block.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          delivered: { type: "boolean", required: true },
          subagent_id: { type: "string", required: true },
          mode: {
            type: "string",
            enum: ["steer", "followup"],
          },
          reason: {
            type: "string",
            enum: ["already_settled"],
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderSend(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent)
        throw new Error("send_to_subagent requires a calling agent (exec.agent was undefined)");

      const childId = args.subagent_id;
      const text = args.message;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("send_to_subagent: message must be a non-empty string");
      }

      // Authoritative membership check (same API as list_agents): the
      // continuable projection covers live AND storage-only children, so a
      // bogus id is rejected instead of being misreported as delivered.
      const children = await ctx.subagents.listChildren(parent.id, exec.signal);
      if (!children.some((entry) => entry.id === childId)) {
        throw new Error(
          `send_to_subagent: "${childId}" is not one of your subagents — pass the id a background dispatch returned (see list_agents)`,
        );
      }

      // Settlement removed the child from the live registry; its outcome was
      // delivered separately as a settlement notice. Be honest: no delivery,
      // no revival — the caller should dispatch a new subagent instead.
      const child = ctx.agents.get(childId);
      if (child === undefined) {
        return { delivered: false, subagent_id: childId, reason: "already_settled" };
      }

      // Feature detection: older DSH hosts may not expose the delivery API
      // on their agent objects. Refuse loudly rather than silently no-op.
      if (typeof child.steer !== "function" || typeof child.followup !== "function") {
        throw new Error(
          "send_to_subagent: this DSH version does not expose the agent delivery API (steer/followup) — cannot deliver",
        );
      }

      const message = createUserMessage({
        content: [{ type: "text", text }],
        source: {
          kind: "plugin",
          plugin: "dsh-wait-subagent",
          form: "relay",
        },
      });

      // Adaptive delivery: a running driver consumes steering at its nearest
      // step boundary; an idle driver opens a new turn for the follow-up.
      // (An idle steer() would also open a turn, but followup() is the
      // canonical ordinary-follow-up-turn API — same effect, clearer intent.)
      if (child.status === "running") {
        child.steer(message);
        return { delivered: true, subagent_id: childId, mode: "steer" };
      }
      child.followup(message);
      return { delivered: true, subagent_id: childId, mode: "followup" };
    },
  });
}

/** Human-readable summary for send_to_subagent results (style of summaries.js). */
function renderSend(value) {
  if (value.delivered) {
    const modeText =
      value.mode === "steer"
        ? "is running — the message was submitted as steering and will be consumed at its nearest step boundary"
        : "is idle — the message was queued as a follow-up turn";
    return `Message delivered to subagent ${value.subagent_id}: it ${modeText}.`;
  }
  if (value.reason === "already_settled") {
    return `Subagent ${value.subagent_id} has already settled — the message was NOT delivered and a settled subagent cannot be revived. Dispatch a new subagent (or subagent_fork) if the work must continue.`;
  }
  return JSON.stringify(value);
}

export { defineSendTool };
