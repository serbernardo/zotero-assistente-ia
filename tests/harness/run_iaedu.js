// Testa o motor IAEdu contra um servidor simulado no formato real observado:
// pedido multipart (channel_id, thread_id, user_info, message) com o cabeçalho x-api-key,
// resposta em blocos JSON separados por linhas em branco (start, token, message, done).
const assert = require("assert/strict");
const { createEnv } = require("./mockzotero");

const ENDPOINT = "https://api.iaedu.pt/agent-chat//api/v1/agent/AGENTE123/stream";
const CHANNEL = "canal-de-teste-01";
const KEY = "sk-usr-TESTE-0123456789abcdef";

const block = o => JSON.stringify(o) + "\n\n";
const RUN = "run-1";
const OK = [
	block({ run_id: RUN, type: "start", content: "Processing" }),
	block({ run_id: RUN, type: "token", content: "" }),
	block({ run_id: RUN, type: "token", content: "Resumo [D1:p2]" }),
	block({ run_id: RUN, type: "token", content: " concluído." }),
	block({ run_id: RUN, type: "message", content: { type: "ai", content: "Resumo [D1:p2] concluído.", tool_calls: [], response_metadata: { model_provider: "openai", model_name: "gpt-5.5" } } }),
	block({ run_id: RUN, type: "done", content: RUN, messageId: "m1" }),
];

function stream(chunks, status = 200, split = false) {
	const enc = new TextEncoder();
	let data = chunks.join("");
	const parts = split ? data.match(/[\s\S]{1,17}/g) : chunks;
	const body = new ReadableStream({
		start(ctrl) {
			for (const c of parts) ctrl.enqueue(enc.encode(c));
			ctrl.close();
		},
	});
	return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}
const json = (status, o) => new Response(JSON.stringify(o), { status });

(async () => {
	const env = createEnv({});
	const { core } = env;
	const L = core.lib;

	// ---------- pronto só com chave, endereço do iaedu.pt e canal ----------
	assert.ok(!core.isEngineReady("iaedu"));
	assert.equal(await core.setSecret("iaedu", KEY), "encrypted");
	assert.ok(core.isEngineReady("iaedu"), "só com a chave: usa o agente por omissão");
	assert.equal(core.iaeduEndpoint(), L.IAEDU_DEFAULT_ENDPOINT);
	assert.equal(core.iaeduChannel(), L.IAEDU_DEFAULT_CHANNEL);
	assert.ok(L.isIAEduEndpoint(L.IAEDU_DEFAULT_ENDPOINT));
	core.setPref("iaedu.endpoint", ENDPOINT);
	core.setPref("iaedu.channel", CHANNEL);
	assert.equal(core.iaeduEndpoint(), ENDPOINT, "um agente próprio vale mais do que o de omissão");
	assert.ok(core.isEngineReady("iaedu"));
	assert.ok(core.readyEngines().includes("iaedu"));
	assert.equal(core.engineLabel("iaedu"), "IAEdu");
	assert.ok(L.isIAEduEndpoint(ENDPOINT));
	assert.ok(L.isIAEduEndpoint("https://api.iaedu.pt/x"));
	assert.ok(!L.isIAEduEndpoint("http://api.iaedu.pt/x"), "só https");
	assert.ok(!L.isIAEduEndpoint("https://iaedu.pt.evil.com/x"));
	assert.ok(!L.isIAEduEndpoint("https://evil.com/iaedu.pt"));
	assert.ok(!L.isIAEduEndpoint("https://xiaedu.pt/x"));
	assert.ok(!L.isIAEduEndpoint("https://user@api.iaedu.pt/x"));
	assert.ok(!L.isIAEduEndpoint(""));
	console.log("OK IAEdu: só com a chave usa o agente por omissão, um agente próprio vale mais, só https de iaedu.pt");

	// ---------- pedido e resposta ----------
	const calls = [];
	const mkWin = handler => ({
		FormData,
		fetch: async (url, opts) => { calls.push({ url, opts }); return handler(calls.length); },
	});
	const deltas = [];
	let r = await core.runIAEdu({ system: "SIS", prompt: "PEDIDO", onDelta: d => deltas.push(d), win: mkWin(() => stream(OK)) });
	assert.equal(r.text, "Resumo [D1:p2] concluído.");
	assert.deepEqual(deltas, ["Resumo [D1:p2]", " concluído."]);
	assert.equal(r.model, "gpt-5.5");
	const c = calls[0];
	assert.equal(c.url, ENDPOINT);
	assert.equal(c.opts.method, "POST");
	assert.equal(c.opts.headers["x-api-key"], KEY);
	assert.ok(!c.url.includes("sk-"), "a chave não vai no URL");
	const fd = c.opts.body;
	assert.ok(fd instanceof FormData);
	assert.equal(fd.get("channel_id"), CHANNEL);
	assert.equal(fd.get("user_info"), "{}");
	assert.equal(fd.get("message"), "SIS\n\nPEDIDO");
	assert.match(fd.get("thread_id"), /^zia-[a-z0-9]+-[a-z0-9]+$/);
	await core.runIAEdu({ system: "s", prompt: "p", win: mkWin(() => stream(OK)) });
	assert.notEqual(calls[1].opts.body.get("thread_id"), fd.get("thread_id"), "cada pedido é uma conversa nova");
	assert.equal(L.formatUsage(r.usage, "iaedu"), null);
	console.log("OK IAEdu: pedido multipart, chave no cabeçalho, texto a chegar, conversa nova em cada pedido");

	// blocos cortados a meio de uma linha
	r = await core.runIAEdu({ system: "s", prompt: "p", win: mkWin(() => stream(OK, 200, true)) });
	assert.equal(r.text, "Resumo [D1:p2] concluído.");
	// só tokens, com o bloco final em falta: avisa que pode estar cortada
	r = await core.runIAEdu({ system: "s", prompt: "p", win: mkWin(() => stream(OK.slice(0, 4))) });
	assert.match(r.text, /Resposta cortada/);
	// o texto completo da mensagem final vale mais do que os pedaços
	r = await core.runIAEdu({ system: "s", prompt: "p", win: mkWin(() => stream([OK[2], OK[3], block({ type: "message", content: { content: "Texto final.", response_metadata: {} } }), OK[5]])) });
	assert.equal(r.text, "Texto final.");
	console.log("OK IAEdu: blocos partidos, resposta sem fim, texto final da mensagem");

	// ---------- erros ----------
	const expectKind = async (win, kind, re) => assert.rejects(core.runIAEdu({ system: "s", prompt: "p", win }), e => {
		assert.equal(e.kind, kind, e.message);
		if (re) assert.match(e.message, re);
		return true;
	});
	await expectKind(mkWin(() => json(401, { detail: "Invalid API key" })), "auth", /chave do IAEdu/);
	await expectKind(mkWin(() => json(403, { detail: "Forbidden" })), "auth");
	await expectKind(mkWin(() => json(404, { detail: "Not Found" })), "other", /não encontrou o agente/);
	await expectKind(mkWin(() => json(422, { detail: [{ msg: "Field required", loc: ["body", "channel_id"] }] })), "other", /Field required/);
	await expectKind(mkWin(() => json(429, { detail: "Too many requests" })), "limit");
	await expectKind(mkWin(() => json(503, { detail: "unavailable" })), "overloaded");
	await expectKind(mkWin(() => json(413, { detail: "payload too large" })), "size");
	await expectKind(mkWin(() => stream([OK[0], block({ type: "error", content: "falhou o agente" })])), "other", /falhou o agente/);
	await expectKind(mkWin(() => stream([OK[0], OK[1], OK[5]])), "other", /não devolveu texto/);
	await expectKind({ FormData, fetch: async () => { throw new Error("rede em baixo"); } }, "network");
	console.log("OK IAEdu: chave inválida, sem permissão, agente inexistente, campo em falta, limite, sobrecarga, tamanho, erro no fluxo, resposta vazia, rede");

	// ---------- sem configuração completa nunca sai um pedido ----------
	const n = calls.length;
	core.setPref("iaedu.endpoint", "https://evil.example.com/agent");
	await assert.rejects(core.runIAEdu({ system: "s", prompt: "p", win: mkWin(() => stream(OK)) }), e => e.kind === "notconfigured" && /iaedu\.pt/.test(e.message));
	core.setPref("iaedu.endpoint", ENDPOINT);
	core.setPref("iaedu.channel", "curto");
	await assert.rejects(core.runIAEdu({ system: "s", prompt: "p", win: mkWin(() => stream(OK)) }), e => e.kind === "notconfigured");
	assert.equal(calls.length, n, "a chave não sai para um endereço de fora ou com canal inválido");
	core.setPref("iaedu.endpoint", "");
	core.setPref("iaedu.channel", "");
	await core.runIAEdu({ system: "s", prompt: "p", win: mkWin(() => stream(OK)) });
	assert.equal(calls[calls.length - 1].url, L.IAEDU_DEFAULT_ENDPOINT, "em branco: agente por omissão");
	assert.equal(calls[calls.length - 1].opts.body.get("channel_id"), L.IAEDU_DEFAULT_CHANNEL);
	core.setPref("iaedu.endpoint", ENDPOINT);
	core.setPref("iaedu.channel", CHANNEL);
	console.log("OK IAEdu: endereço fora do iaedu.pt ou canal inválido não envia nada, em branco usa o agente por omissão");

	// ---------- pelo caminho unificado, com teste ----------
	const t = await core.testEngine("iaedu", mkWin(() => stream(OK)));
	assert.equal(t.model, "gpt-5.5");
	r = await core.runEngine("iaedu", { system: "s", prompt: "p", win: mkWin(() => stream(OK)) });
	assert.equal(r.text, "Resumo [D1:p2] concluído.");
	assert.equal(core.maxCharsFor("iaedu"), 3000000);
	await core.clearAllSecrets();
	assert.ok(!core.hasSecret("iaedu"));
	console.log("OK IAEdu: teste, execução unificada, limite de caracteres e apagar chaves");

	console.log("\nTodos os testes do IAEdu passaram.");
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });
