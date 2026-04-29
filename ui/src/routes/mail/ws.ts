// TODO consolidate with ui/src/lib/ws.ts when overstory-fc04 merges
import { useEffect, useRef } from "react";
import type { MailMessage } from "./types.ts";

export function useMailSocket(onMessage: (m: MailMessage) => void): void {
	const cb = useRef(onMessage);
	cb.current = onMessage;
	useEffect(() => {
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${proto}//${location.host}/ws?mail=true`);
		ws.onmessage = (e) => {
			try {
				const frame = JSON.parse(typeof e.data === "string" ? e.data : "") as unknown;
				if (
					frame !== null &&
					typeof frame === "object" &&
					"type" in (frame as Record<string, unknown>) &&
					(frame as Record<string, unknown>).type === "mail" &&
					"payload" in (frame as Record<string, unknown>)
				) {
					const payload = (frame as Record<string, unknown>).payload as Record<
						string,
						unknown
					> | null;
					if (payload !== null && payload !== undefined && "message" in payload) {
						cb.current(payload.message as MailMessage);
					}
				}
			} catch {
				// ignore malformed frames
			}
		};
		return () => ws.close();
	}, []);
}
