/**
 * subagent-sync-only - extensions/sync-only.js
 *
 * PURPOSE
 * No pi session may delegate work asynchronously. Every 'subagent' launch is
 * rewritten to async:false, so the child runs synchronously in front of the
 * parent session and its result comes back inside the same tool call. Calls
 * that are deferred by construction (scheduled runs) are refused instead of
 * rewritten, because no synchronous form of them exists.
 *
 * WHY THIS EXISTS (measured against pi-subagents 0.88.0 installed here)
 * There is no upstream kill switch for background execution:
 *  - asyncByDefault:false (~/.pi/agent/extensions/subagent/config.json) only
 *    changes the default. An explicit async:true still backgrounds, and
 *    workflow-script calls background whenever 'async' is omitted.
 *  - maxActiveAsyncRunsPerSession:0 means UNLIMITED, not zero
 *    (docs/configuration.md: "Unset or 0 keeps the existing unlimited behavior").
 * So config alone cannot satisfy "never async". This closes the gap at pi's own
 * interception point: tool_call handlers may mutate event.input in place, and
 * "Mutations of event.input affect actual tool execution"
 * (pi docs/extensions.md, Tool Events).
 *
 * SCOPE
 * Model-initiated 'subagent' tool calls, in any session. Top-level launches and
 * fan-out children share the tool name "subagent", so both are covered.
 * Management/control actions (status, stop, steer, logs, guide, ...) launch
 * nothing and are left untouched.
 *
 * FAIL CLOSED
 * An agent whose definition is background-only rejects async:false itself, so
 * such a launch surfaces as a tool error naming that agent rather than quietly
 * running in the background. That is the intended outcome under this policy.
 *
 * KILL SWITCH
 * SUBAGENT_SYNC_ONLY=0 loads nothing (still documented, still inert).
 */

const DISABLED = process.env.SUBAGENT_SYNC_ONLY === "0";

/** Actions that launch deferred/background work: no synchronous form exists. */
export const BLOCKED_ACTIONS = new Set(["schedule.create"]);

export const BLOCK_REASON =
  "subagent-sync-only: async delegation is disabled for all pi sessions. A scheduled run is a background launch by construction, so it is refused; delegate with a synchronous subagent call instead.";

/**
 * Rewrite one subagent tool input into the synchronous form.
 * Mutates input in place (pi's documented tool_call contract) and reports what
 * happened so the caller can count events. Pure: no pi, no fs, unit-testable.
 */
export function coerceSubagentCall(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { changed: false, block: null };
  }

  const action = typeof input.action === "string" ? input.action : "";
  if (action) {
    // Control/management actions launch nothing; only deferred-launch actions are refused.
    return { changed: false, block: BLOCKED_ACTIONS.has(action) ? BLOCK_REASON : null };
  }

  // No action => a launch: single child {agent,task}, tasks[], chain[], count,
  // or a workflow script (workflow:true / workflow:"<name>"). Force foreground.
  if (input.async === false) return { changed: false, block: null };
  input.async = false;
  return { changed: true, block: null };
}

export default function subagentSyncOnly(pi) {
  if (DISABLED) return;

  let coerced = 0;
  let refused = 0;

  pi.on("tool_call", (event) => {
    if (!event || event.toolName !== "subagent") return undefined;
    const verdict = coerceSubagentCall(event.input);
    if (verdict.block) {
      refused += 1;
      return { block: true, reason: verdict.block };
    }
    if (verdict.changed) coerced += 1;
    return undefined;
  });

  pi.registerCommand("subagent-sync", {
    description: "Show subagent sync-only policy state (async delegation disabled)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "subagent-sync-only active: every subagent launch is forced async:false. " +
          "This session: " + coerced + " coerced, " + refused + " deferred launch(es) refused. " +
          "Expected config: asyncByDefault=false in ~/.pi/agent/extensions/subagent/config.json",
        "info"
      );
    },
  });
}
