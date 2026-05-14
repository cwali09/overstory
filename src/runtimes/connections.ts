/**
 * Module-level connection registry for active RuntimeConnection instances.
 *
 * Tracks RPC connections to headless agent processes (e.g., Sapling, headless Claude).
 * Keyed by agent name — same namespace as AgentSession.agentName.
 *
 * Thread safety: single-threaded Bun runtime; no locking needed.
 */

import { HeadlessClaudeConnection } from "./headless-connection.ts";
import type { RuntimeConnection } from "./types.ts";

/** Writable handle exposed to headless connection listeners. */
export type HeadlessStdin = { write(data: string | Uint8Array): number | Promise<number> };

/**
 * Listener fired on headless Claude connection lifecycle events.
 * Fires only for connections created via registerHeadlessConnection() — Sapling
 * and other RuntimeConnection registrants via setConnection() are not surfaced
 * because their wire format differs from headless Claude's stream-json stdin.
 */
export interface HeadlessConnectionListener {
	onRegister(agentName: string, stdin: HeadlessStdin): void;
	onRemove?(agentName: string): void;
}

const connections = new Map<string, RuntimeConnection>();
const headlessAgents = new Map<string, HeadlessStdin>();
const listeners = new Set<HeadlessConnectionListener>();

/** Retrieve the active connection for a given agent, or undefined if none. */
export function getConnection(agentName: string): RuntimeConnection | undefined {
	return connections.get(agentName);
}

/** Register a connection for a given agent. Overwrites any existing entry. */
export function setConnection(agentName: string, conn: RuntimeConnection): void {
	connections.set(agentName, conn);
}

/**
 * Remove the connection for a given agent, calling close() first.
 * Safe to call if no connection exists (no-op).
 */
export function removeConnection(agentName: string): void {
	const conn = connections.get(agentName);
	if (!conn) return;
	if (headlessAgents.delete(agentName)) {
		for (const listener of listeners) {
			listener.onRemove?.(agentName);
		}
	}
	conn.close();
	connections.delete(agentName);
}

/**
 * Create a HeadlessClaudeConnection from a spawned process handle and register it.
 *
 * Called by spawnHeadlessAgent() (process.ts) when an agentName is provided.
 * The registered connection is retrievable via getConnection(agentName) for
 * follow-up delivery, state polling, and abort — all without tmux.
 *
 * This is the sibling registration path to Sapling's connect() flow. It does NOT
 * generalize RpcProcessHandle and does NOT touch other runtime adapters.
 *
 * @param agentName - Unique agent identifier (same namespace as AgentSession.agentName)
 * @param proc - Spawned headless process with pid and stdin
 * @returns The newly created and registered RuntimeConnection
 */
export function registerHeadlessConnection(
	agentName: string,
	proc: { pid: number; stdin: HeadlessStdin },
): RuntimeConnection {
	const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
	setConnection(agentName, conn);
	headlessAgents.set(agentName, proc.stdin);
	for (const listener of listeners) {
		listener.onRegister(agentName, proc.stdin);
	}
	return conn;
}

/**
 * Subscribe to headless Claude connection lifecycle events.
 *
 * onRegister fires synchronously after registerHeadlessConnection() inserts the
 * connection. onRemove fires synchronously before removeConnection() closes the
 * connection. Listeners observing already-registered agents at subscribe time
 * receive an immediate onRegister for each — this lets late subscribers (e.g.,
 * runServe started after agents already exist) catch up without rescanning.
 *
 * @returns Unsubscribe function that removes this listener.
 */
export function addHeadlessConnectionListener(listener: HeadlessConnectionListener): () => void {
	listeners.add(listener);
	for (const [agentName, stdin] of headlessAgents) {
		listener.onRegister(agentName, stdin);
	}
	return () => {
		listeners.delete(listener);
	};
}
