import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { fetchMail } from "./mail/api.ts";
import { FilterChips, type MailFilters } from "./mail/FilterChips.tsx";
import { MessageDetail } from "./mail/MessageDetail.tsx";
import { ThreadList } from "./mail/ThreadList.tsx";
import type { MailMessage } from "./mail/types.ts";
import { useMailSocket } from "./mail/ws.ts";

function prependDedup(msg: MailMessage, prev: MailMessage[]): MailMessage[] {
	const idx = prev.findIndex((m) => m.id === msg.id);
	if (idx !== -1) {
		const next = [...prev];
		next[idx] = msg;
		return next;
	}
	return [msg, ...prev];
}

export function Mail() {
	const queryClient = useQueryClient();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filters, setFilters] = useState<MailFilters>({ unread: false, from: "", to: "" });

	const { data: list = [] } = useQuery({
		queryKey: ["mail", filters],
		queryFn: () => fetchMail(filters),
		refetchInterval: 5000,
	});

	useMailSocket((msg) => {
		queryClient.setQueryData<MailMessage[]>(["mail", filters], (prev) =>
			prependDedup(msg, prev ?? []),
		);
	});

	function handleSelect(id: string) {
		setSelectedId(id);
		// Optimistically flip read flag; fire-and-forget
		queryClient.setQueryData<MailMessage[]>(["mail", filters], (prev) =>
			prev !== undefined ? prev.map((m) => (m.id === id ? { ...m, read: true } : m)) : undefined,
		);
		void import("./mail/api.ts").then(({ markRead }) => markRead(id));
	}

	return (
		<ResizablePanelGroup direction="horizontal" className="h-full">
			<ResizablePanel defaultSize={35} minSize={25}>
				<div className="flex flex-col h-full">
					<FilterChips filters={filters} onChange={setFilters} />
					<ThreadList items={list} selectedId={selectedId} onSelect={handleSelect} />
				</div>
			</ResizablePanel>
			<ResizableHandle withHandle />
			<ResizablePanel defaultSize={65}>
				<MessageDetail messageId={selectedId} />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
