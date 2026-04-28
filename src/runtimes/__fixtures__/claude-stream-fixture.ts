// Fixture: emits a known sequence of Claude stream-json lines to stdout then exits.
// Used by the ClaudeRuntime.parseEvents() integration test.
const lines = [
	JSON.stringify({ type: "system", subtype: "init", session_id: "sess-123" }),
	JSON.stringify({
		type: "assistant",
		message: {
			model: "claude-sonnet-4-6",
			content: [{ type: "text", text: "hello" }],
			usage: { input_tokens: 10, output_tokens: 5 },
		},
	}),
	JSON.stringify({
		type: "result",
		session_id: "sess-123",
		result: "done",
		is_error: false,
		duration_ms: 1234,
		num_turns: 1,
	}),
];
for (const l of lines) process.stdout.write(`${l}\n`);
