/** Mirror of MailMessage from src/types.ts — consolidate when overstory-6c4f merges. */

export type MailSemanticType = "status" | "question" | "result" | "error";

export type MailProtocolType =
	| "worker_done"
	| "merge_ready"
	| "merged"
	| "merge_failed"
	| "escalation"
	| "health_check"
	| "dispatch"
	| "assign"
	| "decision_gate";

export type MailMessageType = MailSemanticType | MailProtocolType;

export interface MailMessage {
	id: string;
	from: string;
	to: string;
	subject: string;
	body: string;
	priority: "low" | "normal" | "high" | "urgent";
	type: MailMessageType;
	threadId: string | null;
	payload: string | null;
	read: boolean;
	createdAt: string;
}
