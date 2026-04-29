import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { fetchAgents } from "./api.ts";

export interface MailFilters {
	unread: boolean;
	from: string;
	to: string;
}

interface FilterChipsProps {
	filters: MailFilters;
	onChange: (filters: MailFilters) => void;
}

export function FilterChips({ filters, onChange }: FilterChipsProps) {
	const { data: agents = [] } = useQuery({ queryKey: ["agents-list"], queryFn: fetchAgents });

	return (
		<div className="flex items-center gap-2 px-3 py-2 border-b">
			<Button
				variant={filters.unread ? "default" : "outline"}
				size="sm"
				onClick={() => onChange({ ...filters, unread: !filters.unread })}
			>
				Unread
			</Button>
			<select
				className="rounded-md border bg-background text-sm px-2 py-1"
				value={filters.from}
				onChange={(e) => onChange({ ...filters, from: e.target.value })}
			>
				<option value="">All from</option>
				{agents.map((name) => (
					<option key={name} value={name}>
						{name}
					</option>
				))}
			</select>
			<select
				className="rounded-md border bg-background text-sm px-2 py-1"
				value={filters.to}
				onChange={(e) => onChange({ ...filters, to: e.target.value })}
			>
				<option value="">All to</option>
				{agents.map((name) => (
					<option key={name} value={name}>
						{name}
					</option>
				))}
			</select>
		</div>
	);
}
