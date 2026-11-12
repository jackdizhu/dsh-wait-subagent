/**
 * dsh-wait-subagent — plugin configuration resolution (task-scheduler mode).
 *
 * `resolveConfig(raw)` deep-merges the user-supplied plugin config over the
 * built-in defaults, validates every field, and returns a fresh normalized
 * object. The input object is never mutated, and every nested section is a
 * new object (so callers can freely hold or patch the result).
 *
 * Shape:
 *   gate      — optional agent-preset id. When set, only root agents whose
 *               composed preset id matches receive this plugin's tools.
 *   dispatch  — the dispatch_tasks surface: { tool, concurrency }.
 *   execute   — routing for kind "execute": in-process spawn under the
 *               zero-decision executor preset at the lowest reasoning effort.
 *   explore   — routing for kind "explore": in-process fork (context-inheriting,
 *               so the parent's reasoning effort is kept).
 *   guard     — turn-close guard: { enabled, minSteps, requireGoal }.
 *
 * Validation messages use the fixed prefix `dsh-wait-subagent config:` so a
 * bad cordis.patch.yml section is reported against the plugin, not the host.
 */

const DEFAULTS = {
  gate: undefined,
  dispatch: { tool: true, concurrency: 3 },
  execute: { provider: "spawn", agentPreset: "executor", reasoningEffort: "minimal" },
  explore: { provider: "fork" },
  guard: { enabled: true, minSteps: 2, requireGoal: true },
};

/** Activation backends accepted for both routed kinds. */
const PROVIDERS = ["spawn", "fork"];
/** Reasoning-effort literals accepted by ctx.subagents.startActivation. */
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Build the one canonical validation error for a field. */
function configError(field, expected) {
  return new Error(`dsh-wait-subagent config: ${field} must be ${expected}`);
}

/** Plain-object check (arrays and null are not config sections). */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge one config section over its defaults: known keys only, own keys only,
 * and an explicitly supplied `undefined` clears the default (so
 * `execute: { agentPreset: undefined }` really means "no preset").
 */
function mergeSection(sectionName, rawSection, defaultsSection) {
  const merged = { ...defaultsSection };
  if (rawSection === undefined) return merged;
  if (!isPlainObject(rawSection)) throw configError(sectionName, "an object");
  for (const key of Object.keys(defaultsSection)) {
    if (Object.prototype.hasOwnProperty.call(rawSection, key)) merged[key] = rawSection[key];
  }
  return merged;
}

/** Throw unless value is an integer inside the inclusive range. */
function assertIntegerInRange(field, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(field, `an integer between ${min} and ${max}`);
  }
}

/** Throw unless value is a boolean. */
function assertBoolean(field, value) {
  if (typeof value !== "boolean") throw configError(field, "a boolean");
}

/** Throw unless value is `undefined` or a non-empty string. */
function assertOptionalNonEmptyString(field, value) {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw configError(field, "a non-empty string or undefined");
  }
}

/** Validate one normalized config object in field order; throws on the first bad field. */
function validateConfig(config) {
  const { gate, dispatch, execute, explore, guard } = config;

  assertOptionalNonEmptyString("gate", gate);
  assertBoolean("dispatch.tool", dispatch.tool);
  assertIntegerInRange("dispatch.concurrency", dispatch.concurrency, 1, 10);

  if (!PROVIDERS.includes(execute.provider)) {
    throw configError("execute.provider", '"spawn" or "fork"');
  }
  assertOptionalNonEmptyString("execute.agentPreset", execute.agentPreset);
  if (execute.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(execute.reasoningEffort)) {
    throw configError("execute.reasoningEffort", `one of ${REASONING_EFFORTS.join("|")}, or undefined`);
  }

  if (!PROVIDERS.includes(explore.provider)) {
    throw configError("explore.provider", '"spawn" or "fork"');
  }

  assertBoolean("guard.enabled", guard.enabled);
  assertIntegerInRange("guard.minSteps", guard.minSteps, 0, 50);
  assertBoolean("guard.requireGoal", guard.requireGoal);
}

/**
 * Deep-merge, validate, and normalize the plugin config.
 *
 * @param {unknown} raw plugin config as supplied by cordis.patch.yml (may be undefined)
 * @returns {{gate: string|undefined, dispatch: {tool: boolean, concurrency: number},
 *   execute: {provider: string, agentPreset: string|undefined, reasoningEffort: string|undefined},
 *   explore: {provider: string}, guard: {enabled: boolean, minSteps: number, requireGoal: boolean}}}
 * @throws {Error} `dsh-wait-subagent config: <field> must be ...` on invalid input
 */
function resolveConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(input)) throw configError("config", "an object");

  const resolved = {
    gate: input.gate,
    dispatch: mergeSection("dispatch", input.dispatch, DEFAULTS.dispatch),
    execute: mergeSection("execute", input.execute, DEFAULTS.execute),
    explore: mergeSection("explore", input.explore, DEFAULTS.explore),
    guard: mergeSection("guard", input.guard, DEFAULTS.guard),
  };

  validateConfig(resolved);
  return resolved;
}

/**
 * Read the composed agent-preset id of one agent, or `undefined` when the host
 * cannot tell us (older DSH without the `agentPresets` service, or a preset
 * object without an id/name).
 *
 * The gate is advisory: an unreadable preset id never silently disables a
 * feature — callers decide what to do with `undefined` (this plugin keeps the
 * wait tools alive and skips the preset-scoped extras).
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @param {object} agent the agent whose preset id is wanted
 * @returns {string|undefined} composed preset id
 */
function composedPresetId(ctx, agent) {
  try {
    const composed = ctx.get("agentPresets")?.composedPreset?.(agent.ctx);
    if (composed === undefined || composed === null) return undefined;
    if (typeof composed === "string") return composed;
    const id = composed.id ?? composed.name;
    return id === undefined || id === null ? undefined : String(id);
  } catch {
    return undefined;
  }
}

export { composedPresetId, resolveConfig };
