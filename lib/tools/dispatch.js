/**
 * dsh-wait-subagent — dispatch_tasks tool definition (task-scheduler v3).
 *
 * `defineDispatchTool(ctx, config, dispatcher)` is called once per root agent
 * from lib/index.js. The tool is a thin schema/render layer over the shared
 * dispatcher (`createDispatcher(ctx, config)`): it validates the calling agent,
 * resolves the working-directory fallback, and hands the batch to the
 * dispatcher, which returns immediately with pre-allocated child ids.
 *
 * Results are harvested by the wait tools (wait_subagent /
 * wait_some_subagent / wait_every_subagent), never by this tool.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @param {object} config resolved plugin config (routing lives in the dispatcher)
 * @param {{dispatch: (input: object) => {tasks: object[]}}} dispatcher shared dispatcher
 * @returns the registered-ready dispatch_tasks tool definition
 */
function defineDispatchTool(ctx, config, dispatcher) {
  return defineTool({
    name: "dispatch_tasks",
    description:
      "Dispatch a batch of sub-agent tasks through the task-scheduler routing. kind \"explore\" runs an in-process fork child (inherits the parent context, keeps the parent's reasoning effort) — use it for parallel investigation and option analysis. kind \"execute\" runs an in-process spawn child under the zero-decision executor preset at the lowest reasoning effort — use it for file edits, creations and writes. Tasks that share a write scope are serialized FIFO; disjoint scopes run in parallel. Child ids are pre-allocated and returned immediately — harvest results with wait_subagent / wait_some_subagent / wait_every_subagent. Each prompt must be fully self-contained: a child never sees this conversation. Analysis and design stay in the calling session; never dispatch decisions.",
    parameters: {
      tasks: {
        type: "array",
        required: true,
        description:
          "Batch of tasks to dispatch; every entry routes to exactly one child sub-agent.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
              required: true,
              enum: ["explore", "execute"],
              description:
                "Routing kind: \"explore\" forks a context-inheriting child, \"execute\" spawns a zero-decision executor child.",
            },
            label: {
              type: "string",
              required: true,
              description: "Short display label for the child (3-5 words).",
            },
            prompt: {
              type: "string",
              required: true,
              description:
                "Fully self-contained task prompt — a child never sees this conversation.",
            },
            cwd: {
              type: "string",
              description:
                "Optional working directory override for the child; defaults to the caller's working directory.",
            },
            write_scope: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional list of path prefixes the child will modify; tasks that share a prefix are serialized FIFO.",
            },
          },
          // Required-ness is declared per property (`required: true`); the
          // host schema DSL collects those into the object's required array.
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tasks: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                task_id: { type: "string", required: true },
                child_id: { type: "string", required: true },
                kind: { type: "string", required: true },
                state: {
                  type: "string",
                  required: true,
                  enum: ["started", "queued", "failed"],
                },
                scope: { type: "array", items: { type: "string" } },
                error: { type: "string" },
              },
              // Required-ness is declared per property (`required: true`).
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderDispatch(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent)
        throw new Error(
          "dispatch_tasks requires a calling agent (exec.agent was undefined)",
        );
      const cwdFallback = ctx.get("workingDirectory")?.get?.(parent.session) ?? process.cwd();
      return dispatcher.dispatch({
        parent,
        tasks: args.tasks,
        signal: exec.signal,
        cwdFallback,
      });
    },
  });
}

/**
 * Human-readable summary for dispatch_tasks results: one line per task
 * (`task_id child_id kind state`, plus the error on failure) and a final
 * started/queued/failed tally.
 */
function renderDispatch(value) {
  const lines = [];
  let started = 0;
  let queued = 0;
  let failed = 0;

  for (const task of value.tasks ?? []) {
    let line = `${task.task_id} ${task.child_id} ${task.kind} ${task.state}`;
    if (task.state === "failed") line += ` error: ${task.error ?? ""}`;
    lines.push(line);

    if (task.state === "started") started += 1;
    else if (task.state === "queued") queued += 1;
    else failed += 1;
  }

  lines.push(`Started ${started} / queued ${queued} / failed ${failed}.`);
  return lines.join("\n");
}

export { defineDispatchTool };
