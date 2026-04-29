import { afterEach, describe, expect, test } from "bun:test";
import {
	addHeadlessConnectionListener,
	getConnection,
	registerHeadlessConnection,
	removeConnection,
	setConnection,
} from "./connections.ts";
import type { ConnectionState, RuntimeConnection } from "./types.ts";

/** Minimal RuntimeConnection stub for testing the registry. */
function makeConn(onClose?: () => void): RuntimeConnection {
	return {
		sendPrompt: async (_text: string) => {},
		followUp: async (_text: string) => {},
		abort: async () => {},
		getState: async (): Promise<ConnectionState> => ({ status: "idle" }),
		close: () => {
			if (onClose) onClose();
		},
	};
}

describe("connection registry", () => {
	// Reset registry between tests by removing any entries set during each test.
	// We track names used so we can clean up without affecting other entries.
	const usedNames: string[] = [];

	afterEach(() => {
		for (const name of usedNames.splice(0)) {
			const conn = getConnection(name);
			if (conn) {
				removeConnection(name);
			}
		}
	});

	test("set and get returns the registered connection", () => {
		const conn = makeConn();
		usedNames.push("agent-alpha");
		setConnection("agent-alpha", conn);
		expect(getConnection("agent-alpha")).toBe(conn);
	});

	test("get unknown returns undefined", () => {
		expect(getConnection("does-not-exist-xyz")).toBeUndefined();
	});

	test("removeConnection calls close() on the connection", () => {
		let closed = false;
		const conn = makeConn(() => {
			closed = true;
		});
		usedNames.push("agent-beta");
		setConnection("agent-beta", conn);
		removeConnection("agent-beta");
		expect(closed).toBe(true);
	});

	test("removeConnection deletes the entry (get returns undefined after)", () => {
		const conn = makeConn();
		usedNames.push("agent-gamma");
		setConnection("agent-gamma", conn);
		removeConnection("agent-gamma");
		expect(getConnection("agent-gamma")).toBeUndefined();
	});

	test("removeConnection on unknown name is a no-op (does not throw)", () => {
		expect(() => removeConnection("never-registered-xyz")).not.toThrow();
	});

	test("setConnection overwrites an existing entry", () => {
		const conn1 = makeConn();
		const conn2 = makeConn();
		usedNames.push("agent-delta");
		setConnection("agent-delta", conn1);
		setConnection("agent-delta", conn2);
		expect(getConnection("agent-delta")).toBe(conn2);
	});
});

describe("headless connection listener API", () => {
	const usedNames: string[] = [];
	const unsubscribers: Array<() => void> = [];

	afterEach(() => {
		for (const unsub of unsubscribers.splice(0)) unsub();
		for (const name of usedNames.splice(0)) {
			if (getConnection(name)) {
				removeConnection(name);
			}
		}
	});

	function makeStdin(): { write(): Promise<number> } {
		return { write: () => Promise.resolve(0) };
	}

	test("onRegister fires when registerHeadlessConnection runs", () => {
		const seen: Array<{ name: string }> = [];
		unsubscribers.push(
			addHeadlessConnectionListener({
				onRegister(agentName) {
					seen.push({ name: agentName });
				},
			}),
		);

		usedNames.push("listener-agent-1");
		registerHeadlessConnection("listener-agent-1", { pid: 99999, stdin: makeStdin() });

		expect(seen).toEqual([{ name: "listener-agent-1" }]);
	});

	test("onRemove fires when a headless connection is removed", () => {
		const removed: string[] = [];
		unsubscribers.push(
			addHeadlessConnectionListener({
				onRegister: () => {},
				onRemove(agentName) {
					removed.push(agentName);
				},
			}),
		);

		usedNames.push("listener-agent-2");
		registerHeadlessConnection("listener-agent-2", { pid: 99999, stdin: makeStdin() });
		removeConnection("listener-agent-2");

		expect(removed).toEqual(["listener-agent-2"]);
	});

	test("onRemove does NOT fire for non-headless connections", () => {
		const removed: string[] = [];
		unsubscribers.push(
			addHeadlessConnectionListener({
				onRegister: () => {},
				onRemove(agentName) {
					removed.push(agentName);
				},
			}),
		);

		const conn: RuntimeConnection = {
			sendPrompt: async () => {},
			followUp: async () => {},
			abort: async () => {},
			getState: async (): Promise<ConnectionState> => ({ status: "idle" }),
			close: () => {},
		};
		usedNames.push("non-headless-agent");
		setConnection("non-headless-agent", conn);
		removeConnection("non-headless-agent");

		expect(removed).toEqual([]);
	});

	test("listener added after registration sees existing agents via catch-up", () => {
		usedNames.push("preexisting-agent");
		registerHeadlessConnection("preexisting-agent", { pid: 99999, stdin: makeStdin() });

		const seen: string[] = [];
		unsubscribers.push(
			addHeadlessConnectionListener({
				onRegister(agentName) {
					seen.push(agentName);
				},
			}),
		);

		expect(seen).toContain("preexisting-agent");
	});

	test("unsubscribe stops further notifications", () => {
		const seen: string[] = [];
		const unsub = addHeadlessConnectionListener({
			onRegister(agentName) {
				seen.push(agentName);
			},
		});
		unsub();

		usedNames.push("after-unsub-agent");
		registerHeadlessConnection("after-unsub-agent", { pid: 99999, stdin: makeStdin() });

		expect(seen).toEqual([]);
	});

	test("onRegister receives the stdin handle from the spawned process", async () => {
		const writes: string[] = [];
		const stdin = {
			write(data: string | Uint8Array) {
				writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
				return Promise.resolve(0);
			},
		};

		const observed: Array<{ write(data: string | Uint8Array): number | Promise<number> }> = [];
		unsubscribers.push(
			addHeadlessConnectionListener({
				onRegister(_agentName, s) {
					observed.push(s);
				},
			}),
		);

		usedNames.push("stdin-pass-agent");
		registerHeadlessConnection("stdin-pass-agent", { pid: 99999, stdin });
		expect(observed.length).toBe(1);
		expect(observed[0]).toBe(stdin);
		await observed[0]?.write("hello");
		expect(writes).toEqual(["hello"]);
	});
});
