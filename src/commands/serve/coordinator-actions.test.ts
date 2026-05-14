/**
 * Tests for the coordinator action wrappers consumed by the REST API.
 *
 * Uses real SQLite stores (file-backed temp dirs) and the live module-level
 * connection registry. The live registry is reset between tests via
 * removeConnection() in afterEach to avoid cross-test leakage.
 *
 * mock.module() is intentionally avoided per mulch record mx-56558b.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../../errors.ts";
import type { MailStore } from "../../mail/store.ts";
import { createMailStore } from "../../mail/store.ts";
import { getConnection, removeConnection, setConnection } from "../../runtimes/connections.ts";
import { HeadlessClaudeConnection } from "../../runtimes/headless-connection.ts";
import type { SessionStore } from "../../sessions/store.ts";
import { createSessionStore } from "../../sessions/store.ts";
import type { AgentSession } from "../../types.ts";
import {
	askCoordinatorAction,
	ConflictError,
	type CoordinatorActionDeps,
	getCoordinatorState,
	sendToCoordinator,
	startCoordinatorHeadless,
	stopCoordinator,
} from "./coordinator-actions.ts";

const COORDINATOR = "coordinator";

interface Ctx {
	tempDir: string;
	sessionStore: SessionStore;
	mailStore: MailStore;
	deps: CoordinatorActionDeps;
}

function makeCoordinatorSession(overrides: Partial<AgentSession> = {}): AgentSession {
	const now = new Date().toISOString();
	return {
		id: `session-${Date.now()}-${COORDINATOR}`,
		agentName: COORDINATOR,
		capability: "coordinator",
		worktreePath: "/tmp/wt",
		branchName: "main",
		taskId: "",
		tmuxSession: "overstory-test-coordinator",
		state: "working",
		pid: 99999,
		parentAgent: null,
		depth: 0,
		runId: `run-${Date.now()}`,
		startedAt: now,
		lastActivity: now,
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

function makeCtx(): Ctx {
	const tempDir = mkdtempSync(join(tmpdir(), "ovs-coord-actions-"));
	const sessionStore = createSessionStore(join(tempDir, "sessions.db"));
	const mailStore = createMailStore(join(tempDir, "mail.db"));
	return {
		tempDir,
		sessionStore,
		mailStore,
		deps: {
			projectRoot: tempDir,
			_sessionStore: sessionStore,
			_mailStore: mailStore,
		},
	};
}

describe("coordinator-actions", () => {
	let ctx: Ctx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		// Always clean up the live connection registry for "coordinator".
		if (getConnection(COORDINATOR) !== undefined) {
			removeConnection(COORDINATOR);
		}
		ctx.sessionStore.close();
		ctx.mailStore.close();
		rmSync(ctx.tempDir, { recursive: true, force: true });
	});

	// ─── getCoordinatorState ──────────────────────────────────────────────────

	describe("getCoordinatorState", () => {
		test("returns running: false when no session exists", () => {
			const state = getCoordinatorState(ctx.deps);
			expect(state.running).toBe(false);
			expect(state.agentName).toBe(COORDINATOR);
			expect(state.pid).toBeNull();
			expect(state.tmuxSession).toBeNull();
			expect(state.runId).toBeNull();
			expect(state.headless).toBe(false);
		});

		test("returns running: false for completed sessions", () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ state: "completed" }));
			expect(getCoordinatorState(ctx.deps).running).toBe(false);
		});

		test("returns running: true with live session fields", () => {
			const session = makeCoordinatorSession({ state: "working" });
			ctx.sessionStore.upsert(session);
			const state = getCoordinatorState(ctx.deps);
			expect(state.running).toBe(true);
			expect(state.pid).toBe(session.pid);
			expect(state.tmuxSession).toBe(session.tmuxSession);
			expect(state.runId).toBe(session.runId);
			expect(state.startedAt).toBe(session.startedAt);
			expect(state.headless).toBe(false);
		});

		test("normalizes empty tmuxSession to null", () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "" }));
			expect(getCoordinatorState(ctx.deps).tmuxSession).toBeNull();
		});

		test("headless: true when a HeadlessClaudeConnection is registered", () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "" }));
			// Use a stub stdin — no real subprocess required for state inspection
			const conn = new HeadlessClaudeConnection(99999, {
				write: () => 0,
			});
			setConnection(COORDINATOR, conn);
			expect(getCoordinatorState(ctx.deps).headless).toBe(true);
		});
	});

	// ─── sendToCoordinator ────────────────────────────────────────────────────

	describe("sendToCoordinator", () => {
		test("throws AgentError when no active session", async () => {
			await expect(sendToCoordinator(ctx.deps, "hi", { subject: "test" })).rejects.toBeInstanceOf(
				AgentError,
			);
		});

		test("throws ConflictError for tmux session without registered connection", async () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "tmux-pane" }));
			await expect(sendToCoordinator(ctx.deps, "hi", { subject: "test" })).rejects.toBeInstanceOf(
				ConflictError,
			);
		});

		test("writes mail row and returns messageId for headless session", async () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "" }));
			const result = await sendToCoordinator(ctx.deps, "hello body", {
				subject: "operator dispatch",
				from: "operator",
			});
			expect(result.messageId).toMatch(/^msg-/);

			const rows = ctx.mailStore.getAll({ to: COORDINATOR });
			expect(rows.length).toBe(1);
			const m = rows[0];
			expect(m).toBeDefined();
			expect(m?.subject).toBe("operator dispatch");
			expect(m?.body).toBe("hello body");
			expect(m?.type).toBe("dispatch");
			expect(m?.from).toBe("operator");
		});

		test("defaults from to 'operator' when not provided", async () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "" }));
			await sendToCoordinator(ctx.deps, "x", { subject: "y" });
			const rows = ctx.mailStore.getAll({ to: COORDINATOR });
			expect(rows[0]?.from).toBe("operator");
		});

		test("succeeds for tmux session WITH a registered connection", async () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "tmux-pane" }));
			const conn = new HeadlessClaudeConnection(99999, { write: () => 0 });
			setConnection(COORDINATOR, conn);
			const result = await sendToCoordinator(ctx.deps, "hi", { subject: "s" });
			expect(result.messageId).toMatch(/^msg-/);
		});
	});

	// ─── askCoordinatorAction ─────────────────────────────────────────────────

	describe("askCoordinatorAction", () => {
		test("throws AgentError when no active session", async () => {
			await expect(
				askCoordinatorAction(ctx.deps, "x", { subject: "y", timeoutSec: 1 }),
			).rejects.toBeInstanceOf(AgentError);
		});

		test("returns reply when one is inserted into mail.db before deadline", async () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "" }));
			const fastDeps: CoordinatorActionDeps = { ...ctx.deps, _askPollIntervalMs: 20 };

			// Schedule a reply via setTimeout so the polling loop can observe it.
			const askPromise = askCoordinatorAction(fastDeps, "question?", {
				subject: "Q",
				from: "operator",
				timeoutSec: 5,
			});

			// Wait briefly for the request mail to land, then write a reply in the
			// same thread from coordinator -> operator.
			setTimeout(() => {
				const sent = ctx.mailStore.getAll({ to: COORDINATOR });
				const original = sent[0];
				if (!original) return;
				ctx.mailStore.insert({
					id: "",
					from: COORDINATOR,
					to: "operator",
					subject: "Re: Q",
					body: "the answer",
					type: "dispatch" as const,
					priority: "normal" as const,
					threadId: original.id,
					payload: null,
				});
			}, 50);

			const result = await askPromise;
			expect(result.timedOut).toBe(false);
			expect(result.reply?.body).toBe("the answer");
			expect(result.messageId).toMatch(/^msg-/);
		});

		test("returns timedOut: true when no reply arrives", async () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "" }));
			const fastDeps: CoordinatorActionDeps = { ...ctx.deps, _askPollIntervalMs: 30 };

			const result = await askCoordinatorAction(fastDeps, "?", {
				subject: "Q",
				from: "operator",
				timeoutSec: 1,
			});
			expect(result.timedOut).toBe(true);
			expect(result.reply).toBeNull();
			expect(result.messageId).toMatch(/^msg-/);
		});

		test("throws ConflictError for tmux session without connection", async () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "tmux-pane" }));
			await expect(
				askCoordinatorAction(ctx.deps, "?", { subject: "Q", timeoutSec: 1 }),
			).rejects.toBeInstanceOf(ConflictError);
		});
	});

	// ─── startCoordinatorHeadless ─────────────────────────────────────────────

	describe("startCoordinatorHeadless", () => {
		test("returns alreadyRunning: true when session already exists", async () => {
			const existing = makeCoordinatorSession({ state: "working", tmuxSession: "" });
			ctx.sessionStore.upsert(existing);
			const result = await startCoordinatorHeadless(ctx.deps);
			expect(result.alreadyRunning).toBe(true);
			expect(result.started).toBe(false);
			expect(result.pid).toBe(existing.pid);
			expect(result.runId).toBe(existing.runId);
		});

		test("calls injected start function and reports started: true", async () => {
			let calledWithHeadless: boolean | undefined;
			const fakeStart = (async (opts: { headless?: boolean }) => {
				calledWithHeadless = opts.headless;
				ctx.sessionStore.upsert(
					makeCoordinatorSession({ tmuxSession: "", state: "booting", pid: 12345 }),
				);
			}) as unknown as CoordinatorActionDeps["_startCoordinatorSession"];

			const result = await startCoordinatorHeadless({
				...ctx.deps,
				_startCoordinatorSession: fakeStart,
			});
			expect(calledWithHeadless).toBe(true);
			expect(result.started).toBe(true);
			expect(result.alreadyRunning).toBe(false);
			expect(result.pid).toBe(12345);
		});

		test("translates 'already running' AgentError race into alreadyRunning result", async () => {
			const fakeStart = (async () => {
				// Simulate another caller racing in
				ctx.sessionStore.upsert(
					makeCoordinatorSession({ tmuxSession: "", state: "working", pid: 7777 }),
				);
				throw new AgentError("Coordinator is already running (tmux: x, since: y)", {
					agentName: COORDINATOR,
				});
			}) as unknown as CoordinatorActionDeps["_startCoordinatorSession"];

			const result = await startCoordinatorHeadless({
				...ctx.deps,
				_startCoordinatorSession: fakeStart,
			});
			expect(result.alreadyRunning).toBe(true);
			expect(result.started).toBe(false);
			expect(result.pid).toBe(7777);
		});
	});

	// ─── stopCoordinator ──────────────────────────────────────────────────────

	describe("stopCoordinator", () => {
		test("returns stopped: false when no active session", async () => {
			const result = await stopCoordinator(ctx.deps);
			expect(result.stopped).toBe(false);
		});

		test("calls injected stop function and reports stopped: true", async () => {
			ctx.sessionStore.upsert(makeCoordinatorSession({ tmuxSession: "" }));
			let stopCalled = false;
			const fakeStop = (async () => {
				stopCalled = true;
				ctx.sessionStore.updateState(COORDINATOR, "completed");
			}) as unknown as CoordinatorActionDeps["_stopCoordinatorSession"];

			const result = await stopCoordinator({
				...ctx.deps,
				_stopCoordinatorSession: fakeStop,
			});
			expect(stopCalled).toBe(true);
			expect(result.stopped).toBe(true);
		});
	});
});
