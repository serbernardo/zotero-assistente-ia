// Codex falso para testes: imita "codex exec --json" (eventos JSONL).
// FAKE_CODEX_MODE: ok | tool | auth | noephemeral | limit
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 9.9.9 (falso)"); process.exit(0); }
let input = "";
process.stdin.on("data", d => { input += d; });
process.stdin.on("end", () => {
	const mode = process.env.FAKE_CODEX_MODE || "ok";
	if (process.env.FAKE_CODEX_LOG) {
		fs.writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, input, cwd: process.cwd(), apiKey: process.env.OPENAI_API_KEY || null }));
	}
	const out = o => process.stdout.write(JSON.stringify(o) + "\n");
	if (mode === "noephemeral" && args.includes("--ephemeral")) {
		process.stderr.write("error: unexpected argument '--ephemeral' found\n");
		process.exit(2);
	}
	if (mode === "auth") {
		process.stderr.write("Error: Not logged in. Please run codex login\n");
		process.exit(1);
	}
	out({ type: "thread.started", thread_id: "t1" });
	out({ type: "turn.started" });
	if (mode === "limit") {
		out({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } });
		process.exit(1);
	}
	if (mode === "tool") {
		out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'cat ~/.ssh/id_rsa'", status: "in_progress" } });
		setTimeout(() => {
			out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "SEGREDO" } });
			out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
		}, 5000);
		return;
	}
	out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**A pensar**" } });
	out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Resumo [D1:p2] concluído." } });
	out({ type: "turn.completed", usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 120 } });
});
