// Testa os motores ChatGPT:
// 1. API da OpenAI (Chat Completions em fluxo) contra um servidor simulado no formato oficial;
// 2. conta ChatGPT através do Codex, com um programa Codex falso (fake_codex/), incluindo
//    o bloqueio quando o Codex tenta usar uma ferramenta.
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert/strict");
const { createEnv } = require("./mockzotero");

function sse(chunks, status = 200) {
	const enc = new TextEncoder();
	const body = new ReadableStream({
		start(ctrl) {
			for (const c of chunks) ctrl.enqueue(enc.encode(typeof c === "string" ? c : `data: ${JSON.stringify(c)}\n\n`));
			ctrl.close();
		},
	});
	return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

const OK = [
	{ id: "c1", model: "gpt-6-sol", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
	{ id: "c1", model: "gpt-6-sol", choices: [{ index: 0, delta: { content: "Resumo [D1:p2]" } }] },
	{ id: "c1", model: "gpt-6-sol", choices: [{ index: 0, delta: { content: " concluído." }, finish_reason: "stop" }] },
	{ id: "c1", model: "gpt-6-sol", choices: [], usage: { prompt_tokens: 9000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 8000 } } },
	"data: [DONE]\n\n",
];
const errBody = (status, code, message, type) => new Response(JSON.stringify({ error: { message, type: type || "invalid_request_error", code } }), { status });

(async () => {
	// ---------- API da OpenAI ----------
	const env = createEnv({});
	const { core } = env;
	const L = core.lib;
	assert.equal(await core.setSecret("openai", "sk-proj-TESTE-0123456789abcdef"), "encrypted");
	assert.ok(core.isEngineReady("openai"));
	const calls = [];
	const mkWin = handler => ({ fetch: async (url, opts) => { calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null }); return handler(calls.length); } });
	const deltas = [];
	let r = await core.runOpenAI({ system: "SIS", prompt: "PEDIDO", model: "gpt-6-sol", onDelta: d => deltas.push(d), win: mkWin(() => sse(OK)) });
	assert.equal(r.text, "Resumo [D1:p2] concluído.");
	assert.deepEqual(deltas, ["Resumo [D1:p2]", " concluído."]);
	const c = calls[0];
	assert.equal(c.url, "https://api.openai.com/v1/chat/completions");
	assert.equal(c.opts.headers.Authorization, "Bearer sk-proj-TESTE-0123456789abcdef");
	assert.ok(!c.url.includes("sk-"), "a chave não vai no URL");
	assert.equal(c.body.model, "gpt-6-sol");
	assert.equal(c.body.stream, true);
	assert.deepEqual(c.body.stream_options, { include_usage: true });
	assert.ok(!("temperature" in c.body), "sem temperature");
	assert.deepEqual(c.body.messages, [{ role: "developer", content: "SIS" }, { role: "user", content: "PEDIDO" }]);
	assert.equal(L.formatUsage(r.usage, "openai"), "Tokens: 9000 de entrada (8000 da cache), 40 de saída");
	console.log("OK ChatGPT API: pedido oficial, chave no cabeçalho, fluxo lido, consumo de tokens");

	const expectKind = async (win, kind) => assert.rejects(core.runOpenAI({ system: "s", prompt: "p", win }), e => {
		assert.equal(e.kind, kind, e.message);
		return true;
	});
	await expectKind(mkWin(() => errBody(401, "invalid_api_key", "Incorrect API key provided")), "auth");
	await expectKind(mkWin(() => errBody(429, "insufficient_quota", "You exceeded your current quota", "insufficient_quota")), "billing");
	await expectKind(mkWin(() => errBody(429, "rate_limit_exceeded", "Rate limit reached")), "limit");
	await expectKind(mkWin(() => errBody(404, "model_not_found", "The model does not exist")), "model");
	await expectKind(mkWin(() => errBody(400, "context_length_exceeded", "maximum context length")), "size");
	await expectKind(mkWin(() => errBody(503, null, "overloaded", "server_error")), "overloaded");
	await expectKind(mkWin(() => sse([{ choices: [{ delta: { refusal: "I can't help" }, finish_reason: "stop" }] }, "data: [DONE]\n\n"])), "blocked");
	r = await core.runOpenAI({ system: "s", prompt: "p", win: mkWin(() => sse([OK[1], { choices: [{ delta: {}, finish_reason: "length" }] }])) });
	assert.match(r.text, /Resposta cortada/);
	const models = await core.listOpenAIModels(mkWin(() => new Response(JSON.stringify({ data: [
		{ id: "gpt-6-sol" }, { id: "gpt-6-luna" }, { id: "text-embedding-3-large" }, { id: "gpt-6-realtime" }, { id: "whisper-1" },
	] }), { status: 200 })));
	assert.deepEqual([...models.map(m => m.id)], ["gpt-6-luna", "gpt-6-sol"]);
	console.log("OK ChatGPT API: chave inválida, sem crédito, limite, modelo, tamanho, sobrecarga, recusa, resposta cortada, lista de modelos");

	// ---------- Codex (conta ChatGPT) ----------
	const fake = path.join(__dirname, "fake_codex", process.platform === "win32" ? "codex.cmd" : "codex");
	const log = path.join(os.tmpdir(), "zia-fake-codex.json");
	process.env.FAKE_CODEX_LOG = log;
	process.env.OPENAI_API_KEY = "sk-NAO-DEVE-PASSAR";
	const cenv = createEnv({ prefs: { "codex.path": fake } });
	const cc = cenv.core;
	assert.equal(cc.isEngineReady("codex"), false, "Codex só fica pronto depois de ativado");

	process.env.FAKE_CODEX_MODE = "ok";
	const cdeltas = [];
	r = await cc.runEngine("codex", { system: "INSTRUCOES", prompt: "<documentos>X</documentos>\n\n<pedido>Resume</pedido>", onDelta: d => cdeltas.push(d) });
	assert.equal(r.text, "Resumo [D1:p2] concluído.");
	assert.deepEqual(cdeltas, ["Resumo [D1:p2] concluído."], "o raciocínio não aparece");
	let seen = JSON.parse(fs.readFileSync(log, "utf8"));
	assert.deepEqual(seen.args, ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never"]);
	assert.match(seen.input, /^<instrucoes_de_sistema>\nINSTRUCOES\n[\s\S]*Não executes comandos[\s\S]*<\/instrucoes_de_sistema>\n\n<documentos>X<\/documentos>/);
	assert.equal(seen.apiKey, null, "a chave de API do sistema não passa ao Codex");
	assert.ok(/codex-\d+-/.test(seen.cwd), "corre numa pasta temporária própria");
	assert.ok(!fs.existsSync(seen.cwd), "a pasta temporária é apagada no fim");
	assert.equal(L.formatUsage(r.usage, "codex"), "Tokens: 5000 de entrada (4000 da cache), 120 de saída");
	console.log("OK Codex: " + (process.platform === "win32" ? "atalho .cmd do npm resolvido sem cmd.exe, " : "") + "sandbox só de leitura, pasta temporária apagada, sem chave de API, resposta lida");

	// Tentativa de usar uma ferramenta: o pedido é interrompido de imediato
	process.env.FAKE_CODEX_MODE = "tool";
	const t0 = Date.now();
	await assert.rejects(cc.runCodex({ system: "s", prompt: "p" }), e => e.kind === "blocked" && /command_execution/.test(e.message));
	assert.ok(Date.now() - t0 < 4000, "processo terminado antes de acabar (" + (Date.now() - t0) + " ms)");
	console.log("OK Codex: tentativa de executar um comando bloqueada e processo terminado");

	// Opção que uma versão antiga não conhece: repete sem ela
	process.env.FAKE_CODEX_MODE = "noephemeral";
	r = await cc.runCodex({ system: "s", prompt: "p", model: "gpt-6-sol" });
	seen = JSON.parse(fs.readFileSync(log, "utf8"));
	assert.ok(!seen.args.includes("--ephemeral"));
	assert.deepEqual(seen.args.slice(-2), ["--model", "gpt-6-sol"]);
	assert.equal(r.text, "Resumo [D1:p2] concluído.");

	process.env.FAKE_CODEX_MODE = "auth";
	await assert.rejects(cc.runCodex({ system: "s", prompt: "p" }), e => e.kind === "auth" && /codex login/.test(e.message));
	process.env.FAKE_CODEX_MODE = "limit";
	await assert.rejects(cc.runCodex({ system: "s", prompt: "p" }), e => e.kind === "limit");
	console.log("OK Codex: versão antiga, sessão não iniciada e limite da conta");

	// Teste de ligação ativa o motor
	process.env.FAKE_CODEX_MODE = "ok";
	const test = await cc.testCodex();
	assert.match(test.version, /codex-cli/);
	assert.equal(cc.isEngineReady("codex"), true);

	// Cancelamento
	process.env.FAKE_CODEX_MODE = "tool";
	const ac = new AbortController();
	const pending = cc.runCodex({ system: "s", prompt: "p", signal: ac.signal });
	ac.abort();
	await assert.rejects(pending, e => e.kind === "aborted" || e.kind === "blocked");
	console.log("OK Codex: teste de ligação ativa o motor, cancelamento");

	// ---------- Textos em inglês ----------
	L.I18N.setLang("en");
	cc.lib.I18N.setLang("en");
	await assert.rejects(core.runOpenAI({ system: "s", prompt: "p", win: mkWin(() => errBody(401, "invalid_api_key", "x")) }), e => /The OpenAI API key is invalid/.test(e.message));
	process.env.FAKE_CODEX_MODE = "auth";
	await assert.rejects(cc.runCodex({ system: "s", prompt: "p" }), e => /Codex is not signed in/.test(e.message));
	assert.equal(core.engineLabel("codex"), "ChatGPT (Codex)");
	L.I18N.setLang("pt-PT");
	cc.lib.I18N.setLang("pt-PT");
	console.log("OK mensagens de erro em inglês");

	console.log("\nTodos os testes do ChatGPT (API e Codex) passaram.");
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });
