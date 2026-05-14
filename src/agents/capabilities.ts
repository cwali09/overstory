/**
 * Shared capability classification for the runtime layer.
 *
 * Three orthogonal classifications:
 *
 * - `TASK_SCOPED_CAPABILITIES` — worker capabilities that operate under the
 *   spawn-per-turn model. Each user turn (mail, nudge, initial dispatch)
 *   spawns a fresh claude with `--resume <session-id>`, processes the turn,
 *   and exits on stdin EOF. There is no persistent process between turns.
 *
 * - `PERSISTENT_CAPABILITIES` — capabilities that run as long-lived sessions
 *   for the lifetime of a run/operator interaction (coordinator, orchestrator,
 *   monitor). Used by the watchdog to exempt them from time-based stale/zombie
 *   detection and exclude them from run-completion accounting.
 *
 * - `STOP_HOOK_PERSISTENT_CAPABILITIES` — capabilities whose Claude Code Stop
 *   hook fires per model turn rather than once at process exit. The same as
 *   `PERSISTENT_CAPABILITIES` plus `lead`, because tmux-mode leads still span
 *   many model turns within a single dispatch (overstory-49a7).
 *
 * Phase 4 (overstory-2724) consolidated these definitions here as the single
 * source of truth — previously they were duplicated across log.ts, health.ts,
 * and daemon.ts with a load-bearing `lead` mismatch.
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
 * Capabilities that run as long-lived sessions for the duration of a run /
 * operator interaction.
 *
 * `coordinator` and `orchestrator` are operator-driven persistent agents (one
 * tmux session per run / multi-run); `monitor` is a continuous fleet patrol
 * with its own long-lived session. They are expected to have long idle
 * periods (waiting for worker mail, operator input) and must NOT be flagged
 * stale/zombie based on `lastActivity` — only tmux/pid liveness applies.
 *
 * Consumers:
 *   - `src/watchdog/health.ts` — exempt from time-based stale/zombie detection
 *   - `src/watchdog/daemon.ts` — excluded from run-completion accounting
 *
 * Note: `lead` is NOT in this set. Under spawn-per-turn (the default), each
 * lead turn is its own short-lived process; under tmux mode the lead still
 * runs to a terminal `worker_done` and exits, so it counts toward
 * run-completion accounting. The per-model-turn nuance for tmux-mode leads
 * is captured separately by `STOP_HOOK_PERSISTENT_CAPABILITIES`.
 */
export const PERSISTENT_CAPABILITIES = new Set<Capability>([
	"coordinator",
	"orchestrator",
	"monitor",
]);

/** True iff `capability` is a long-lived persistent session. */
export function isPersistentCapability(capability: string): boolean {
	return PERSISTENT_CAPABILITIES.has(capability as Capability);
}

/**
 * Capabilities whose Claude Code Stop hook fires per **model turn** rather
 * than once at process exit. Under tmux mode these agents have many model
 * turns within a single dispatch, so a `session-end` event is NOT a reliable
 * "agent done" signal — the hook fires every time the model finishes
 * generating a response and waits for the next user turn.
 *
 * Equals `PERSISTENT_CAPABILITIES` plus `lead`. Tmux-mode leads delegate to
 * sub-workers and process mail injection over many turns (overstory-49a7);
 * marking the lead `completed` on the first Stop hook fire makes it vanish
 * from `getActive()` while its tmux process is still working.
 *
 * The tmux-mode-only nuance does not apply to spawn-per-turn (headless) leads:
 * (a) they run one model turn per process; (b) `hooks-deployer.ts` drops the
 * Stop hook entirely under `headlessOnly=true`, so this gate is a no-op for
 * them. Including `lead` here is therefore safe in both modes.
 *
 * Consumer:
 *   - `src/commands/log.ts` — guards `transitionToCompleted`,
 *     `autoRecordExpertise`, and `appendOutcomeToAppliedRecords` so they do
 *     not fire on every turn boundary.
 */
export const STOP_HOOK_PERSISTENT_CAPABILITIES = new Set<Capability>([
	...PERSISTENT_CAPABILITIES,
	"lead" as Capability,
]);

/** True iff `capability`'s Stop hook is per-model-turn (not per-session-exit). */
export function isStopHookPersistentCapability(capability: string): boolean {
	return STOP_HOOK_PERSISTENT_CAPABILITIES.has(capability as Capability);
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
