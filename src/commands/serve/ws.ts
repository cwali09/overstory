/**
 * WebSocket broadcaster for ov serve.
 *
 * Subscribes to EventStore writes and MailStore inserts, broadcasting
 * to per-run and per-agent rooms. Installs itself via registerWsHandler().
 */

import { Database } from "bun:sqlite";
import type { MailMessage, StoredEvent } from "../../types.ts";
import { registerWsHandler } from "../serve.ts";

type BunWs<T> = import("bun").ServerWebSocket<T>;

/** Per-socket data injected on upgrade. */
interface RoomData {
	rooms: string[];
}

// === Room registry ===

const rooms = new Map<string, Set<BunWs<RoomData>>>();

function joinRoom(key: string, ws: BunWs<RoomData>): void {
	let room = rooms.get(key);
	if (room === undefined) {
		room = new Set();
		rooms.set(key, room);
	}
	room.add(ws);
}

function leaveAllRooms(ws: BunWs<RoomData>): void {
	for (const key of ws.data.rooms) {
		const room = rooms.get(key);
		if (room !== undefined) {
			room.delete(ws);
			if (room.size === 0) {
				rooms.delete(key);
			}
		}
	}
}

function broadcast(key: string, frame: string): void {
	const room = rooms.get(key);
	if (room === undefined) return;
	for (const ws of room) {
		ws.send(frame);
	}
}

// === Outbound envelope ===

type OutboundFrame =
	| { type: "event"; ts: string; payload: StoredEvent | { batched: true; events: StoredEvent[] } }
	| { type: "mail"; ts: string; payload: { message: MailMessage } }
	| { type: "agent_state"; ts: string; payload: { agentName: string; state: string } };

// === Text batching ===

const BATCH_WINDOW_MS = 250;

interface BatchEntry {
	events: StoredEvent[];
	timer: ReturnType<typeof setTimeout>;
}

const batches = new Map<string, BatchEntry>();

function isTextEvent(event: StoredEvent): boolean {
	if ((event.eventType as string) === "text") return true;
	if (event.data !== null) {
		try {
			const parsed = JSON.parse(event.data) as unknown;
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"delta" in (parsed as Record<string, unknown>)
			) {
				return true;
			}
		} catch {
			// ignore parse error
		}
	}
	return false;
}

function fanOutEvent(event: StoredEvent, roomKey: string): void {
	if (isTextEvent(event)) {
		const batchKey = `${roomKey}:${event.agentName}:${event.sessionId ?? ""}`;
		let entry = batches.get(batchKey);
		if (entry === undefined) {
			const timer = setTimeout(() => {
				const e = batches.get(batchKey);
				if (e !== undefined) {
					batches.delete(batchKey);
					const frame: OutboundFrame = {
						type: "event",
						ts: new Date().toISOString(),
						payload: { batched: true, events: e.events },
					};
					broadcast(roomKey, JSON.stringify(frame));
				}
			}, BATCH_WINDOW_MS);
			entry = { events: [], timer };
			batches.set(batchKey, entry);
		}
		entry.events.push(event);
	} else {
		const frame: OutboundFrame = {
			type: "event",
			ts: new Date().toISOString(),
			payload: event,
		};
		broadcast(roomKey, JSON.stringify(frame));
	}
}

// === DB row shapes ===

interface EventRow {
	id: number;
	run_id: string | null;
	agent_name: string;
	session_id: string | null;
	event_type: string;
	tool_name: string | null;
	tool_args: string | null;
	tool_duration_ms: number | null;
	level: string;
	data: string | null;
	created_at: string;
}

interface MessageRow {
	id: string;
	from_agent: string;
	to_agent: string;
	subject: string;
	body: string;
	type: string;
	priority: string;
	thread_id: string | null;
	payload: string | null;
	read: number;
	created_at: string;
}

function rowToStoredEvent(row: EventRow): StoredEvent {
	return {
		id: row.id,
		runId: row.run_id,
		agentName: row.agent_name,
		sessionId: row.session_id,
		eventType: row.event_type as StoredEvent["eventType"],
		toolName: row.tool_name,
		toolArgs: row.tool_args,
		toolDurationMs: row.tool_duration_ms,
		level: row.level as StoredEvent["level"],
		data: row.data,
		createdAt: row.created_at,
	};
}

function rowToMailMessage(row: MessageRow): MailMessage {
	return {
		id: row.id,
		from: row.from_agent,
		to: row.to_agent,
		subject: row.subject,
		body: row.body,
		type: row.type as MailMessage["type"],
		priority: row.priority as MailMessage["priority"],
		threadId: row.thread_id,
		payload: row.payload,
		read: row.read === 1,
		createdAt: row.created_at,
	};
}

// === Public API ===

export interface BroadcasterOptions {
	eventsDbPath: string;
	mailDbPath: string;
	pollIntervalMs?: number;
}

/**
 * Install the WebSocket broadcaster and start pollers.
 * Registers a WsHandler that joins/leaves rooms on open/close.
 * Returns a stop function for cleanup on SIGINT/SIGTERM.
 */
export function installBroadcaster(opts: BroadcasterOptions): () => void {
	const interval = opts.pollIntervalMs ?? 250;

	registerWsHandler({
		getUpgradeData(req: Request): unknown | null {
			const url = new URL(req.url);
			const mailParam = url.searchParams.get("mail");
			if (mailParam === "true") {
				const data: RoomData = { rooms: ["mail"] };
				return data;
			}
			const run = url.searchParams.get("run");
			const agent = url.searchParams.get("agent");
			if (run !== null) {
				const data: RoomData = { rooms: [`run:${run}`] };
				return data;
			}
			if (agent !== null) {
				const data: RoomData = { rooms: [`agent:${agent}`] };
				return data;
			}
			return null;
		},
		open(ws: BunWs<unknown>): void {
			const data = ws.data as RoomData;
			for (const key of data.rooms) {
				joinRoom(key, ws as BunWs<RoomData>);
			}
		},
		close(ws: BunWs<unknown>): void {
			leaveAllRooms(ws as BunWs<RoomData>);
		},
	});

	const eventsDb = new Database(opts.eventsDbPath);
	eventsDb.exec("PRAGMA journal_mode=WAL");
	eventsDb.exec("PRAGMA busy_timeout=5000");

	const mailDb = new Database(opts.mailDbPath);
	mailDb.exec("PRAGMA journal_mode=WAL");
	mailDb.exec("PRAGMA busy_timeout=5000");

	// Seed event cursor at the current MAX(id) so we only tail new rows
	let lastEventId = 0;
	try {
		const r = eventsDb
			.prepare<{ max_id: number | null }, []>("SELECT MAX(id) AS max_id FROM events")
			.get();
		lastEventId = r?.max_id ?? 0;
	} catch {
		// events table not yet created
	}

	// Seed mail cursor at current MAX(created_at)
	let lastMailTs = "";
	try {
		const r = mailDb
			.prepare<{ max_ts: string | null }, []>("SELECT MAX(created_at) AS max_ts FROM messages")
			.get();
		lastMailTs = r?.max_ts ?? "";
	} catch {
		// messages table not yet created
	}

	// Event poller
	const eventTimer = setInterval(() => {
		try {
			const rows = eventsDb
				.prepare<EventRow, { $lastId: number }>(
					"SELECT * FROM events WHERE id > $lastId ORDER BY id ASC",
				)
				.all({ $lastId: lastEventId });
			for (const row of rows) {
				if (row.id > lastEventId) lastEventId = row.id;
				const event = rowToStoredEvent(row);
				fanOutEvent(event, `agent:${event.agentName}`);
				if (event.runId !== null) {
					fanOutEvent(event, `run:${event.runId}`);
				}
			}
		} catch {
			// DB not ready yet; retry next tick
		}
	}, interval);

	// Mail poller
	const mailTimer = setInterval(() => {
		try {
			const rows = mailDb
				.prepare<MessageRow, { $lastTs: string }>(
					"SELECT * FROM messages WHERE created_at > $lastTs ORDER BY created_at ASC",
				)
				.all({ $lastTs: lastMailTs });
			for (const row of rows) {
				if (row.created_at > lastMailTs) lastMailTs = row.created_at;
				const message = rowToMailMessage(row);
				const frame: OutboundFrame = {
					type: "mail",
					ts: new Date().toISOString(),
					payload: { message },
				};
				const frameStr = JSON.stringify(frame);
				broadcast(`agent:${message.to}`, frameStr);
				broadcast(`agent:${message.from}`, frameStr);
				broadcast("mail", frameStr);
			}
		} catch {
			// DB not ready yet; retry next tick
		}
	}, interval);

	return function stopBroadcaster(): void {
		clearInterval(eventTimer);
		clearInterval(mailTimer);
		for (const [, entry] of batches) {
			clearTimeout(entry.timer);
		}
		batches.clear();
		eventsDb.close();
		mailDb.close();
	};
}

// === Test helpers ===

/** Returns the current number of active rooms (for disconnect verification). */
export function _getRoomCount(): number {
	return rooms.size;
}

/** Clears room and batch state between tests. */
export function _resetRooms(): void {
	rooms.clear();
	for (const [, entry] of batches) {
		clearTimeout(entry.timer);
	}
	batches.clear();
}
