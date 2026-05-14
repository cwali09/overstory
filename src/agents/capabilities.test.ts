import { describe, expect, test } from "bun:test";
import {
	isPersistentCapability,
	isStopHookPersistentCapability,
	isTaskScopedCapability,
	PERSISTENT_CAPABILITIES,
	STOP_HOOK_PERSISTENT_CAPABILITIES,
	TASK_SCOPED_CAPABILITIES,
	terminalMailTypesFor,
} from "./capabilities.ts";

describe("TASK_SCOPED_CAPABILITIES", () => {
	test("contains the five worker capabilities", () => {
		expect([...TASK_SCOPED_CAPABILITIES].sort()).toEqual([
			"builder",
			"lead",
			"merger",
			"reviewer",
			"scout",
		]);
	});

	test("excludes persistent capabilities", () => {
		for (const c of ["coordinator", "orchestrator", "monitor", "supervisor"]) {
			expect(isTaskScopedCapability(c)).toBe(false);
		}
	});
});

describe("terminalMailTypesFor", () => {
	test("merger uses merged + merge_failed", () => {
		expect(terminalMailTypesFor("merger")).toEqual(["merged", "merge_failed"]);
	});

	test("builder/scout/reviewer/lead accept worker_done and result", () => {
		// `result` is a legacy/drift fallback (overstory-1a4c): models often pick
		// `--type result` for their terminal summary because the prompts also use
		// `result` for non-terminal updates elsewhere. Accepting both keeps the
		// lifecycle unstuck without losing the canonical `worker_done` contract.
		for (const c of ["builder", "scout", "reviewer", "lead"]) {
			expect(terminalMailTypesFor(c)).toEqual(["worker_done", "result"]);
		}
	});

	test("unknown capability falls back to worker_done set", () => {
		expect(terminalMailTypesFor("unknown")).toEqual(["worker_done", "result"]);
	});
});

describe("PERSISTENT_CAPABILITIES", () => {
	test("contains coordinator, orchestrator, monitor only", () => {
		expect([...PERSISTENT_CAPABILITIES].sort()).toEqual(["coordinator", "monitor", "orchestrator"]);
	});

	test("excludes lead and other workers", () => {
		for (const c of ["lead", "builder", "scout", "reviewer", "merger", "supervisor"]) {
			expect(isPersistentCapability(c)).toBe(false);
		}
	});
});

describe("STOP_HOOK_PERSISTENT_CAPABILITIES", () => {
	test("equals PERSISTENT_CAPABILITIES plus lead", () => {
		// Tmux-mode leads span many model turns within a single dispatch
		// (overstory-49a7), so the per-turn Stop hook is NOT a "done" signal.
		expect([...STOP_HOOK_PERSISTENT_CAPABILITIES].sort()).toEqual([
			"coordinator",
			"lead",
			"monitor",
			"orchestrator",
		]);
	});

	test("isStopHookPersistentCapability is true for lead and the persistent set", () => {
		for (const c of ["coordinator", "orchestrator", "monitor", "lead"]) {
			expect(isStopHookPersistentCapability(c)).toBe(true);
		}
	});

	test("excludes non-lead workers", () => {
		for (const c of ["builder", "scout", "reviewer", "merger", "supervisor"]) {
			expect(isStopHookPersistentCapability(c)).toBe(false);
		}
	});
});
