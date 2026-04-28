import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetHandlers, createServeServer } from "../serve.ts";
import { _getRoomCount, _resetRooms, installBroadcaster } from "./ws.ts";

/**
 * Tests use createServeServer() directly (no process signals).
 * Each test binds to port: 0 for conflict-free execution.
 * installBroadcaster() is called explicitly in tests that need it.
 */

const POLL_MS = 50; // fast polls for tests

describe("WebSocket broadcaster", () => {
	let tempDir: string;
	let eventsDbPath: string;
	let mailDbPath: string;
	let eventsDb: Database;
	let mailDb: Database;
	let servers: ReturnType<typeof Bun.serve>[] = [];
	let stopBroadcasters: (() => void)[] = [];
	let wsConnections: WebSocket[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-ws-test-"));
		eventsDbPath = join(tempDir, "events.db");
		mailDbPath = join(tempDir, "mail.db");

		// Create .overstory/config.yaml so loadConfig resolves
		mkdirSync(join(tempDir, ".overstory"), { recursive: true });
		writeFileSync(
			join(tempDir, ".overstory", "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		// Pre-create DBs with required schemas
		eventsDb = new Database(eventsDbPath);
		eventsDb.exec("PRAGMA journal_mode=WAL");
		eventsDb.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT,
				agent_name TEXT NOT NULL,
				session_id TEXT,
				event_type TEXT NOT NULL,
				tool_name TEXT,
				tool_args TEXT,
				tool_duration_ms INTEGER,
				level TEXT NOT NULL DEFAULT 'info',
				data TEXT,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
			)
		`);

		mailDb = new Database(mailDbPath);
		mailDb.exec("PRAGMA journal_mode=WAL");
		mailDb.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				from_agent TEXT NOT NULL,
				to_agent TEXT NOT NULL,
				subject TEXT NOT NULL,
				body TEXT NOT NULL,
				type TEXT NOT NULL DEFAULT 'status',
				priority TEXT NOT NULL DEFAULT 'normal',
				thread_id TEXT,
				payload TEXT,
				read INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
			)
		`);
	});

	afterEach(async () => {
		// Close WS connections
		for (const ws of wsConnections) {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				ws.close();
			}
		}
		wsConnections = [];
		// Stop broadcasters
		for (const stop of stopBroadcasters) {
			stop();
		}
		stopBroadcasters = [];
		// Stop servers
		for (const srv of servers) {
			srv.stop(true);
		}
		servers = [];
		// Reset handler and room state
		_resetHandlers();
		_resetRooms();
		// Close test DBs
		eventsDb.close();
		mailDb.close();
		// Remove temp dir
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function startWithBroadcaster(): Promise<ReturnType<typeof Bun.serve>> {
		const stop = installBroadcaster({ eventsDbPath, mailDbPath, pollIntervalMs: POLL_MS });
		stopBroadcasters.push(stop);
		const origCwd = process.cwd;
		process.cwd = () => tempDir;
		const server = await createServeServer({ port: 0, host: "127.0.0.1" });
		process.cwd = origCwd;
		servers.push(server);
		return server;
	}

	function waitForOpen(ws: WebSocket): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (ws.readyState === WebSocket.OPEN) {
				resolve();
				return;
			}
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("WebSocket error")));
		});
	}

	function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<unknown[]> {
		return new Promise<unknown[]>((resolve) => {
			const messages: unknown[] = [];
			const timer = setTimeout(() => resolve(messages), timeoutMs);
			ws.addEventListener("message", (e: MessageEvent) => {
				messages.push(JSON.parse(e.data as string));
				if (messages.length >= count) {
					clearTimeout(timer);
					resolve(messages);
				}
			});
		});
	}

	function insertEvent(
		db: Database,
		agentName: string,
		runId: string | null,
		eventType: string,
		sessionId?: string | null,
		data?: string | null,
	): void {
		db.prepare(
			"INSERT INTO events (agent_name, run_id, session_id, event_type, data, level) VALUES (?, ?, ?, ?, ?, 'info')",
		).run(agentName, runId, sessionId ?? null, eventType, data ?? null);
	}

	function insertMail(db: Database, id: string, fromAgent: string, toAgent: string): void {
		const ts = new Date().toISOString();
		db.prepare(
			"INSERT INTO messages (id, from_agent, to_agent, subject, body, type, priority, read, created_at) VALUES (?, ?, ?, 'Subject', 'Body', 'status', 'normal', 0, ?)",
		).run(id, fromAgent, toAgent, ts);
	}

	// Test 1: ?run=<id> upgrades; event for matching run id arrives
	test("?run=<id> upgrades and event for matching run arrives", async () => {
		const server = await startWithBroadcaster();
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?run=run-123`);
		wsConnections.push(ws);
		await waitForOpen(ws);

		const pending = collectMessages(ws, 1, 1000);
		insertEvent(eventsDb, "agent-x", "run-123", "tool_start");

		const msgs = await pending;
		expect(msgs.length).toBe(1);
		const frame = msgs[0] as Record<string, unknown>;
		expect(frame.type).toBe("event");
		const payload = frame.payload as Record<string, unknown>;
		expect(payload.runId).toBe("run-123");
	});

	// Test 2: ?agent=<name> upgrades; event for that agent arrives
	test("?agent=<name> upgrades and event for matching agent arrives", async () => {
		const server = await startWithBroadcaster();
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?agent=agent-x`);
		wsConnections.push(ws);
		await waitForOpen(ws);

		const pending = collectMessages(ws, 1, 1000);
		insertEvent(eventsDb, "agent-x", null, "tool_start");

		const msgs = await pending;
		expect(msgs.length).toBe(1);
		const frame = msgs[0] as Record<string, unknown>;
		expect(frame.type).toBe("event");
		const payload = frame.payload as Record<string, unknown>;
		expect(payload.agentName).toBe("agent-x");
	});

	// Test 3: Event rooms are independent
	test("event for run-A is not delivered to run-B subscriber", async () => {
		const server = await startWithBroadcaster();

		const wsA = new WebSocket(`ws://127.0.0.1:${server.port}/ws?run=run-A`);
		const wsB = new WebSocket(`ws://127.0.0.1:${server.port}/ws?run=run-B`);
		wsConnections.push(wsA, wsB);
		await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

		const msgsB: unknown[] = [];
		wsB.addEventListener("message", (e: MessageEvent) => {
			msgsB.push(JSON.parse(e.data as string));
		});

		const pendingA = collectMessages(wsA, 1, 1000);
		insertEvent(eventsDb, "agent-x", "run-A", "tool_start");

		await pendingA;
		// Give run-B subscriber extra time to (not) receive anything
		await new Promise((r) => setTimeout(r, 200));
		expect(msgsB.length).toBe(0);
	});

	// Test 4: Mail fans out to both agent:<from> and agent:<to>
	test("mail insert fans out to both agent:<from> and agent:<to>", async () => {
		const server = await startWithBroadcaster();

		const wsFrom = new WebSocket(`ws://127.0.0.1:${server.port}/ws?agent=sender`);
		const wsTo = new WebSocket(`ws://127.0.0.1:${server.port}/ws?agent=recipient`);
		wsConnections.push(wsFrom, wsTo);
		await Promise.all([waitForOpen(wsFrom), waitForOpen(wsTo)]);

		const pendingFrom = collectMessages(wsFrom, 1, 1000);
		const pendingTo = collectMessages(wsTo, 1, 1000);

		insertMail(mailDb, "msg-test-1", "sender", "recipient");

		const [msgsFrom, msgsTo] = await Promise.all([pendingFrom, pendingTo]);

		expect(msgsFrom.length).toBe(1);
		const frameFrom = msgsFrom[0] as Record<string, unknown>;
		expect(frameFrom.type).toBe("mail");

		expect(msgsTo.length).toBe(1);
		const frameTo = msgsTo[0] as Record<string, unknown>;
		expect(frameTo.type).toBe("mail");
		const payload = frameTo.payload as Record<string, unknown>;
		const message = payload.message as Record<string, unknown>;
		expect(message.from).toBe("sender");
		expect(message.to).toBe("recipient");
	});

	// Test 5: Text events batch; non-text events don't
	test("text events in rapid succession arrive batched; non-text arrive un-batched", async () => {
		const server = await startWithBroadcaster();
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?agent=batch-agent`);
		wsConnections.push(ws);
		await waitForOpen(ws);

		// Collect messages over a window large enough for batch flush
		const received: unknown[] = [];
		ws.addEventListener("message", (e: MessageEvent) => {
			received.push(JSON.parse(e.data as string));
		});

		// Insert 3 text events before any poll fires
		for (let i = 0; i < 3; i++) {
			insertEvent(eventsDb, "batch-agent", null, "text", null, null);
		}
		// Wait for poll + batch window
		await new Promise((r) => setTimeout(r, POLL_MS + 300));

		// Should have received exactly 1 batched message
		const textFrames = received.filter((m) => {
			const f = m as Record<string, unknown>;
			const p = f.payload as Record<string, unknown>;
			return f.type === "event" && "batched" in p;
		});
		expect(textFrames.length).toBe(1);
		const batched = (textFrames[0] as Record<string, unknown>).payload as Record<string, unknown>;
		expect(batched.batched).toBe(true);
		expect(Array.isArray(batched.events)).toBe(true);
		expect((batched.events as unknown[]).length).toBe(3);

		// Now test non-text: reset and insert a tool_start
		received.length = 0;
		insertEvent(eventsDb, "batch-agent", null, "tool_start");
		await new Promise((r) => setTimeout(r, POLL_MS + 50));

		const nonTextFrames = received.filter((m) => {
			const f = m as Record<string, unknown>;
			const p = f.payload as Record<string, unknown>;
			return f.type === "event" && !("batched" in p);
		});
		expect(nonTextFrames.length).toBe(1);
	});

	// Test 6: Disconnect removes socket from registry
	test("disconnecting removes socket from all rooms (registry empty after close)", async () => {
		const server = await startWithBroadcaster();
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?run=cleanup-run`);
		wsConnections.push(ws);
		await waitForOpen(ws);

		// Room should now contain the socket
		expect(_getRoomCount()).toBe(1);

		// Disconnect
		const closed = new Promise<void>((resolve) => {
			ws.addEventListener("close", () => resolve());
		});
		ws.close();
		await closed;
		// Give server-side close callback time to fire
		await new Promise((r) => setTimeout(r, 100));

		expect(_getRoomCount()).toBe(0);
	});

	// Test 7: /ws with no run/agent → 400 JSON
	test("/ws with no run or agent query param returns 400 JSON envelope", async () => {
		const server = await startWithBroadcaster();
		const res = await fetch(`http://127.0.0.1:${server.port}/ws`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.success).toBe(false);
		expect(typeof body.error).toBe("string");
	});

	// Test 8: /ws with no handler → 404 JSON
	test("/ws with no handler installed returns 404 JSON envelope", async () => {
		// No installBroadcaster called — no WsHandler registered
		const origCwd = process.cwd;
		process.cwd = () => tempDir;
		const server = await createServeServer({ port: 0, host: "127.0.0.1" });
		process.cwd = origCwd;
		servers.push(server);

		const res = await fetch(`http://127.0.0.1:${server.port}/ws`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.success).toBe(false);
		expect(typeof body.error).toBe("string");
	});
});
