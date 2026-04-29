import { useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { useScrollFade } from "@/lib/use-scroll-fade";
import type { MailMessage, MailMessageType } from "./types.ts";

function typeVariant(type: MailMessageType): "default" | "secondary" | "destructive" | "outline" {
	switch (type) {
		case "error":
		case "merge_failed":
			return "destructive";
		case "worker_done":
		case "merged":
		case "merge_ready":
			return "default";
		case "status":
			return "outline";
		default:
			return "secondary";
	}
}

interface ThreadListProps {
	items: MailMessage[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}

export function ThreadList({ items, selectedId, onSelect }: ThreadListProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	useScrollFade(viewportRef);

	if (items.length === 0) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground text-center">
				<p>No messages.</p>
				<p>
					Send one with{" "}
					<code className="font-mono">
						{`ov mail send --to coordinator --subject "..." --body "..." --type status`}
					</code>
					.
				</p>
			</div>
		);
	}

	return (
		<div ref={viewportRef} className="flex-1 min-h-0 overflow-auto">
			<div className="flex flex-col">
				{items.map((msg) => (
					<button
						key={msg.id}
						type="button"
						onClick={() => onSelect(msg.id)}
						className={[
							"flex flex-col gap-1 px-3 py-2 text-left border-b hover:bg-accent/50 transition-colors",
							selectedId === msg.id ? "bg-accent text-accent-foreground" : "",
						].join(" ")}
					>
						<div className="flex items-center justify-between gap-2">
							<span className="text-sm font-medium truncate flex-1">{msg.subject}</span>
							<div className="flex items-center gap-1 shrink-0">
								<Badge variant={typeVariant(msg.type)}>{msg.type}</Badge>
								{!msg.read && <div className="size-2 rounded-full bg-primary" />}
							</div>
						</div>
						<span className="text-xs text-muted-foreground">
							{msg.from} → {msg.to}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
