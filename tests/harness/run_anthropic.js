// Testa o motor Claude API (Messages API da Anthropic, SSE) com um servidor simulado,
// e o cofre de chaves (OSKeyStore, gestor de credenciais, migração da versão 0.1).
const assert = require("assert/strict");
const { createEnv } = require("./mockzotero");

function sse(events, status = 200) {
	const enc = new TextEncoder();
	const body = new ReadableStream({
		start(ctrl) {
			for (const e of events) ctrl.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
			ctrl.close();
		},
	});
	return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

const OK_EVENTS = [
	{ type: "message_start", message: { id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 120, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "raciocínio escondido" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Resumo [D1:p2]" } },
	{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " concluído." } },
	{ type: "content_block_stop", index: 1 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
	{ type: "message_stop" },
];

const errBody = (type, message) => JSON.stringify({ type: "error", error: { type, message } });

(async () => {
	// ---------- Cofre de chaves ----------
	{
		const env = createEnv({ prefs: { "gemini.key": "plain:AIza-ANTIGA-0123456789" } });
		const { core, prefStore } = env;
		await core.migrateSecrets();
		const stored = prefStore.get("extensions.zoteroia.gemini.key");
		assert.match(stored, /^oskv1:/, "chave antiga migrada para o cofre");
		assert.ok(!stored.includes("AIza-ANTIGA"), "sem texto simples nas preferências");
		assert.equal(await core.getSecret("gemini"), "AIza-ANTIGA-0123456789");
		assert.equal(await core.setSecret("anthropic", "  sk-ant-api03-TESTE-0123456789  "), "encrypted");
		assert.ok(!prefStore.get("extensions.zoteroia.anthropic.key").includes("sk-ant"), "chave encriptada");
		assert.equal(await core.getSecret("anthropic"), "sk-ant-api03-TESTE-0123456789");
		assert.equal(core.secretState("anthropic"), "encrypted");
		assert.deepEqual([...core.readyEngines()], ["anthropic", "gemini"]);
		await core.clearAllSecrets();
		assert.equal(core.hasSecret("anthropic") || core.hasSecret("gemini"), false);
		console.log("OK cofre: migração da 0.1, encriptação, leitura e apagar tudo");
	}
	{
		const env = createEnv({ noOSKeyStore: true });
		const { core, prefStore, logins } = env;
		assert.equal(await core.setSecret("anthropic", "sk-ant-api03-RESERVA-0123456789"), "login");
		assert.equal(prefStore.get("extensions.zoteroia.anthropic.key"), "login:");
		assert.equal(logins.store.length, 1);
		assert.equal(await core.getSecret("anthropic"), "sk-ant-api03-RESERVA-0123456789");
		await core.setSecret("anthropic", "sk-ant-api03-NOVA-0123456789");
		assert.equal(logins.store.length, 1, "substitui, não duplica");
		await core.setSecret("anthropic", "");
		assert.equal(logins.store.length, 0);
		assert.equal(core.secretState("anthropic"), "none");
		console.log("OK cofre: sem cofre do sistema, usa o gestor de credenciais do Zotero (nunca texto simples)");
	}

	// ---------- Motor Claude API ----------
	const env = createEnv({});
	const { core } = env;
	const L = core.lib;
	await core.setSecret("anthropic", "sk-ant-api03-TESTE-0123456789");
	const calls = [];
	const mkWin = handler => ({ fetch: async (url, opts) => { calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null }); return handler(calls.length, url, opts); } });

	const parts = { docs: "<documentos>\nTEXTO\n</documentos>", rest: "<pedido>\nResume\n</pedido>" };
	const deltas = [];
	let r = await core.runAnthropic({ system: "SIS", prompt: "x", promptParts: parts, model: "claude-opus-5", onDelta: d => deltas.push(d), win: mkWin(() => sse(OK_EVENTS)) });
	assert.equal(r.text, "Resumo [D1:p2] concluído.");
	assert.deepEqual(deltas, ["Resumo [D1:p2]", " concluído."], "raciocínio não aparece");
	const c = calls[0];
	assert.equal(c.url, "https://api.anthropic.com/v1/messages");
	assert.equal(c.opts.method, "POST");
	assert.equal(c.opts.headers["x-api-key"], "sk-ant-api03-TESTE-0123456789");
	assert.equal(c.opts.headers["anthropic-version"], "2023-06-01");
	assert.equal(c.opts.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
	assert.ok(!c.url.includes("sk-ant"), "a chave não vai no URL");
	assert.equal(c.body.model, "claude-opus-5");
	assert.equal(c.body.stream, true);
	assert.equal(c.body.system, "SIS");
	assert.equal(c.body.fallbacks, "default");
	assert.ok(!("thinking" in c.body), "thinking omitido (adaptativo por omissão)");
	assert.ok(!("temperature" in c.body), "sem temperature (rejeitada nos modelos atuais)");
	assert.equal(c.body.messages[0].role, "user");
	assert.deepEqual(c.body.messages[0].content[0], { type: "text", text: parts.docs, cache_control: { type: "ephemeral" } });
	assert.deepEqual(c.body.messages[0].content[1], { type: "text", text: parts.rest });
	assert.equal(L.formatUsage(r.usage, "anthropic"), "Tokens: 9120 de entrada (9000 da cache), 42 de saída");
	console.log("OK Claude API: pedido oficial, chave no cabeçalho, documentos em cache, raciocínio escondido, consumo de tokens");

	// Sonnet: sem o parâmetro de reserva
	calls.length = 0;
	await core.runAnthropic({ system: "s", prompt: "p", model: "claude-sonnet-5", win: mkWin(() => sse(OK_EVENTS)) });
	assert.ok(!("fallbacks" in calls[0].body) && !calls[0].opts.headers["anthropic-beta"]);
	assert.deepEqual(calls[0].body.messages[0].content, [{ type: "text", text: "p" }]);

	// Reserva não aceite: repete sem ela
	calls.length = 0;
	r = await core.runAnthropic({ system: "s", prompt: "p", model: "claude-opus-5", win: mkWin(n => n === 1
		? new Response(errBody("invalid_request_error", "fallbacks: Extra inputs are not permitted"), { status: 400 })
		: sse(OK_EVENTS)) });
	assert.equal(calls.length, 2);
	assert.ok(!("fallbacks" in calls[1].body));
	assert.equal(r.text, "Resumo [D1:p2] concluído.");
	console.log("OK Claude API: modelo sem reserva e repetição automática quando a reserva não é aceite");

	// Erros com mensagens claras
	const errWin = (status, type, msg) => mkWin(() => new Response(errBody(type, msg), { status }));
	const expectKind = async (win, kind) => assert.rejects(core.runAnthropic({ system: "s", prompt: "p", model: "claude-sonnet-5", win }), e => {
		assert.equal(e.kind, kind, e.message);
		return true;
	});
	await expectKind(errWin(401, "authentication_error", "invalid x-api-key"), "auth");
	await expectKind(errWin(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."), "billing");
	await expectKind(errWin(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), "limit");
	await expectKind(errWin(529, "overloaded_error", "Overloaded"), "overloaded");
	await expectKind(errWin(404, "not_found_error", "model: claude-x"), "model");
	await expectKind(errWin(400, "invalid_request_error", "prompt is too long: 1200000 tokens > 1000000 maximum"), "size");
	await expectKind(mkWin(() => sse([OK_EVENTS[0], { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])), "overloaded");
	await expectKind(mkWin(() => sse([OK_EVENTS[0], { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } }])), "blocked");
	console.log("OK Claude API: chave inválida, sem crédito, limite, sobrecarga, modelo, tamanho, erro a meio e recusa");

	// Resposta cortada
	r = await core.runAnthropic({ system: "s", prompt: "p", model: "claude-sonnet-5", win: mkWin(() => sse([
		OK_EVENTS[0], OK_EVENTS[5], { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 32000 } },
	])) });
	assert.match(r.text, /Resposta cortada/);

	// Cancelamento
	const ac = new AbortController();
	const slowWin = { fetch: async (url, opts) => new Promise((res, rej) => {
		opts.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
	}) };
	const pending = core.runAnthropic({ system: "s", prompt: "p", model: "claude-sonnet-5", win: slowWin, signal: ac.signal });
	setTimeout(() => ac.abort(), 30);
	await assert.rejects(pending, e => e.kind === "aborted");

	// Sem chave
	await core.setSecret("anthropic", "");
	await assert.rejects(core.runAnthropic({ system: "s", prompt: "p", win: mkWin(() => sse(OK_EVENTS)) }), e => e.kind === "auth");
	console.log("OK Claude API: resposta cortada assinalada, cancelamento e falta de chave");

	// Lista de modelos (teste da chave sem gastar tokens)
	await core.setSecret("anthropic", "sk-ant-api03-TESTE-0123456789");
	calls.length = 0;
	const models = await core.listAnthropicModels(mkWin(() => new Response(JSON.stringify({ data: [
		{ id: "claude-opus-5", display_name: "Claude Opus 5" }, { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
	] }), { status: 200 })));
	assert.equal(calls[0].url, "https://api.anthropic.com/v1/models?limit=100");
	assert.equal(calls[0].opts.headers["x-api-key"], "sk-ant-api03-TESTE-0123456789");
	assert.deepEqual([...models.map(m => m.id)], ["claude-opus-5", "claude-sonnet-5"]);
	await assert.rejects(core.listAnthropicModels(errWin(401, "authentication_error", "invalid")), e => e.kind === "auth");
	console.log("OK Claude API: teste da chave pela lista de modelos");

	// Motor não configurado
	await assert.rejects(core.runEngine("", { system: "s", prompt: "p" }), e => e.kind === "notconfigured");

	// Claude Code descarregado pela aplicação Claude para computador (macOS)
	{
		const fs = require("fs"), os = require("os"), path = require("path");
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "zia-home-"));
		const base = path.join(home, "Library", "Application Support", "Claude", "claude-code");
		for (const v of ["2.1.9", "2.1.10", "2.0.99"]) {
			fs.mkdirSync(path.join(base, v), { recursive: true });
			fs.writeFileSync(path.join(base, v, "claude"), "");
		}
		env.Zotero.isWin = false;
		env.Zotero.isMac = true;
		core.homeDir = () => home;
		core.toolCandidates = () => [];
		core._subprocess = { pathSearch: async () => { throw new Error("não está no PATH"); } };
		core._toolCache.claude = null;
		core.setPref("claude.path", "");
		assert.equal(await core.findClaudeExecutable(), path.join(base, "2.1.10", "claude"), "usa a versão mais recente");
		core._toolCache.claude = null;
		fs.rmSync(base, { recursive: true, force: true });
		core.setPref("claude.enabled", true);
		await assert.rejects(core.findClaudeExecutable(), e => e.kind === "notfound");
		assert.equal(core.pref("claude.enabled"), false, "deixa de aparecer como ativo quando o programa desaparece");
		console.log("OK Claude Code: encontra a cópia da aplicação Claude e desativa o motor quando o programa desaparece");
	}
	console.log("\nTodos os testes do Claude API e do cofre de chaves passaram.");
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });
