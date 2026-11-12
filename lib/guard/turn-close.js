/**
 * dsh-wait-subagent — turn-close guard.
 *
 * `registerTurnCloseGuard(ctx, config)` subscribes to the host's
 * `agent/pre-step` and `agent/turn-stopping` lifecycle events and refuses to
 * let a root agent close a turn that made no progress: a turn that ran at
 * least `guard.minSteps` steps (and, when `guard.requireGoal` is set, that
 * carries an active goal) may not end on pure prose. Ending such a turn is
 * one of the three illegal closes the host rules forbid, so the guard steers
 * the agent back with one corrective user message that restates the
 * three-way choice: continue with tool calls, name the files already written
 * plus the remaining objective and next action, or ask the user and stop.
 *
 * Rate limiting: at most one steer per (agent, turn) pair, recorded BEFORE
 * the steer so a steer that itself triggers another turn-stopping pass can
 * never loop. Only root agents are guarded — a child agent's turn boundary
 * belongs to its parent's dispatch, not to this guard.
 *
 * Every listener body is wrapped so a failure degrades the guard instead of
 * breaking the agent's step or turn machinery; failures are logged through
 * the optional logger rather than swallowed silently.
 */

import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { composedPresetId } from "../config.js";

/** Corrective text steered into the agent when it tries an illegal close. */
const GUARD_TEXT = `【回合收尾守卫】你违反了回合收尾硬规：本回合既没有待完成的工具调用，也没有 ask_user_question 停机，却准备结束回合。现在必须三选一：(A) 继续发起工具调用推进未完成的 objective；(B) 给出本回合已落盘文件的绝对路径，并明确剩余 objective 与下一步具体动作；(C) 调用 ask_user_question 请求用户决策并停机。禁止以纯文本承诺、总结或"下一步计划"收尾。`;

/**
 * Subscribe the turn-close guard on the plugin context.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @param {{guard?: {enabled?: boolean, minSteps?: number, requireGoal?: boolean}}} config resolved plugin config
 * @returns {() => void} dispose function that unbinds every subscription
 */
export function registerTurnCloseGuard(ctx, config) {
  if (config?.guard?.enabled !== true) return () => {};

  /** agent → highest step index observed in the current turn. */
  const stepped = new WeakMap();
  /** agent → turn number already steered (at most one steer per turn). */
  const steeredTurn = new WeakMap();
  const disposers = [];

  // Track how far each agent got in its turn. A step index that arrives as a
  // number wins; otherwise count observations so the guard still works on
  // hosts that omit the field.
  disposers.push(
    ctx.on("agent/pre-step", (payload, next) => {
      try {
        const agent = payload?.agent;
        const step = payload?.step;
        if (agent) {
          stepped.set(agent, typeof step === "number" ? step : (stepped.get(agent) ?? 0) + 1);
        }
      } catch {
        // never break the step
      }
      // agent/pre-step is a waterfall: a listener that does not own the
      // decision MUST return next(), or the chain resolves to undefined and
      // the loop's `decision.kind` read throws "reading 'kind'".
      return next();
    }),
  );

  disposers.push(
    ctx.on("agent/turn-stopping", async (payload) => {
      try {
        if (process.env.DSH_TURN_CLOSE_GUARD === "0") return;

        const agent = payload?.agent;
        if (!agent) return;
        if (!ctx.agents.roots().includes(agent)) return;

        // Preset gate: the guard is a task-scheduler-mode feature, so it only
        // fires for agents composed from the configured preset. An unreadable
        // preset id leaves the guard off for that agent (the gate is a scope
        // limiter, never a silent behaviour change for other presets).
        if (config.gate !== undefined && composedPresetId(ctx, agent) !== config.gate) return;

        if (payload.signal?.aborted === true) return;

        const steps = stepped.get(agent) ?? 0;
        if (steps < config.guard.minSteps) return;

        const turn = payload.turn;
        if (steeredTurn.get(agent) === turn) return;
        steeredTurn.set(agent, turn);

        if (config.guard.requireGoal === true) {
          const goal = ctx.get("goals")?.get?.(agent);
          if (goal?.phase !== "active") return;
        }

        if (typeof agent.steer !== "function") return;

        agent.steer(
          createUserMessage({
            content: [{ type: "text", text: GUARD_TEXT }],
            source: {
              kind: "plugin",
              plugin: "dsh-wait-subagent",
              form: "turn-close-guard",
            },
          }),
        );

        ctx.logger?.info?.(
          "turn-close-guard: steered agent " + agent.id + " at turn " + payload.turn,
        );
      } catch (err) {
        ctx.logger?.warn?.("turn-close-guard: " + (err?.message ?? String(err)));
      }
    }),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        // idempotent teardown
      }
    }
  };
}
