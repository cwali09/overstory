/**
 * Shared capability classification for the runtime layer.
 *
 * `TASK_SCOPED_CAPABILITIES` are the worker capabilities that operate under
 * the spawn-per-turn model: each user turn (mail, nudge, initial dispatch)
 * spawns a fresh claude with `--resume <session-id>`, processes the turn,
 * and exits on stdin EOF. There is no persistent process between turns.
 *
 * Persistent capabilities (coordinator, orchestrator, monitor) are tmux-based
 * long-lived sessions and are NOT in this set. Phase 4 (overstory-2724) will
 * hoist `PERSISTENT_CAPABILITIES` to this module too and unify the divergent
 * definitions currently scattered across log.ts / health.ts / daemon.ts.
 */

import type { Capability } from "../types.ts";

/** Worker capabilities driven by the spawn-per-turn engine. */
export const TASK_SCOPED_CAPABILITIES = new Set<Capability>([
	"builder",
	"scout",
	"reviewer",
	"merger",
	"lead",
]);

/** True iff `capability` is a task-scoped worker (drives spawn-per-turn). */
export function isTaskScopedCapability(capability: string): boolean {
	return TASK_SCOPED_CAPABILITIES.has(capability as Capability);
}

/**
 * Mail types that signal an agent's terminal action for its capability.
 *
 * The turn-runner watches for any of these from the agent during a turn; when
 * observed alongside a clean `result` event, the agent is transitioned to
 * `completed`. Capabilities not listed here use the worker_done set by default.
 *
 * - builder | scout | reviewer | lead → `worker_done` (canonical) or `result`
 *   (legacy/drift fallback). Agent prompts treat `worker_done` as the
 *   completion signal, but the model frequently picks `result` because it is
 *   also a valid mail type used for non-terminal summaries elsewhere in the
 *   protocol. Accepting `result` keeps the lifecycle from getting stuck on
 *   prompt drift (overstory-1a4c). Combined with `cleanResult` (claude exited
 *   cleanly at end-of-turn), this is safe: an interim `result` mid-turn does
 *   not transition the agent because the turn has not ended yet.
 * - merger → `merged` (success) or `merge_failed` (failure)
 */
export function terminalMailTypesFor(capability: string): readonly string[] {
	if (capability === "merger") return ["merged", "merge_failed"];
	return ["worker_done", "result"];
}
