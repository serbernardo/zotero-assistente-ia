// Testa o motor Gemini com um servidor simulado (formato SSE oficial do streamGenerateContent).
const assert = require("assert/strict");
const { createEnv } = require("./mockzotero");

function sseResponse(events, status = 200) {
	const enc = new TextEncoder();
	const body = new ReadableStream({
		start(ctrl) {
			for (const e of events) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\r\n\r\n`));
			ctrl.close();
		},
	});
	return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

(async () => {
	const env = createEnv({ prefs: { "gemini.model": "models/gemini-3.8-flash" } });
	const { core } = env;
	await core.setGeminiKey("AIza-TESTE");
	let captured;
	const win = {
		fetch: async (url, opts) => {
			captured = { url, opts };
			return sseResponse([
				{ candidates: [{ content: { parts: [{ text: "A pensar…", thought: true }] } }] },
				{ candidates: [{ content: { parts: [{ text: "Resumo [D1:p2]" }] } }] },
				{ candidates: [{ content: { parts: [{ text: " concluído." }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 42 } },
			]);
		},
	};
	const deltas = [];
	const r = await core.runGemini({ system: "SIS", prompt: "PEDIDO", onDelta: d => deltas.push(d), win });
	assert.equal(r.text, "Resumo [D1:p2] concluído.");
	assert.equal(JSON.stringify(deltas), JSON.stringify(["Resumo [D1:p2]", " concluído."]));
	assert.equal(captured.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
	assert.equal(captured.opts.headers["x-goog-api-key"], "AIza-TESTE");
	assert.ok(!captured.url.includes("AIza"), "a chave não vai no URL");
	const body = JSON.parse(captured.opts.body);
	assert.equal(body.systemInstruction.parts[0].text, "SIS");
	assert.equal(body.contents[0].role, "user");
	assert.equal(body.contents[0].parts[0].text, "PEDIDO");
	console.log("OK Gemini: pedido no formato oficial, chave no cabeçalho, fluxo lido, pensamentos ignorados");

	// Erros
	const errWin = status => ({ fetch: async () => new Response(JSON.stringify({ error: { code: status, message: "Resource has been exhausted" } }), { status }) });
	await assert.rejects(core.runGemini({ system: "s", prompt: "p", win: errWin(429) }), e => e.kind === "limit");
	await assert.rejects(core.runGemini({ system: "s", prompt: "p", win: errWin(404) }), e => e.kind === "model");
	console.log("OK Gemini: erros 429 (quota) e 404 (modelo) com mensagens claras");

	// Resposta cortada
	const cutWin = { fetch: async () => sseResponse([{ candidates: [{ content: { parts: [{ text: "Parcial" }] }, finishReason: "MAX_TOKENS" }] }]) };
	const r2 = await core.runGemini({ system: "s", prompt: "p", win: cutWin });
	assert.match(r2.text, /Resposta cortada/);
	// Bloqueio
	const blkWin = { fetch: async () => sseResponse([{ promptFeedback: { blockReason: "SAFETY" } }]) };
	await assert.rejects(core.runGemini({ system: "s", prompt: "p", win: blkWin }), e => e.kind === "blocked");
	// Sem chave
	await core.setGeminiKey("");
	await assert.rejects(core.runGemini({ system: "s", prompt: "p", win }), e => e.kind === "auth");
	console.log("OK Gemini: resposta cortada assinalada, bloqueio e falta de chave tratados");

	// Lista de modelos
	await core.setGeminiKey("AIza-TESTE");
	const listWin = { fetch: async () => new Response(JSON.stringify({ models: [
		{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
		{ name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent", "countTokens"] },
	] }), { status: 200 }) };
	assert.equal(JSON.stringify(await core.listGeminiModels(listWin)), JSON.stringify(["gemini-3.8-flash", "gemini-3.5-flash-lite"]));
	console.log("OK Gemini: lista só modelos de texto");

	// Sobrecarga (503): repete o pedido e depois tenta modelos alternativos
	core.GEMINI_RETRY_MS = [0, 0, 0];
	core.GEMINI_ALT_PAUSE_MS = 0;
	const busy = () => new Response(JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } }), { status: 503 });
	const modelList = () => new Response(JSON.stringify({ models: [
		{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.7-flash-lite", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.9-flash-preview", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.7-pro", supportedGenerationMethods: ["generateContent"] },
	] }), { status: 200 });
	let calls = [];
	const recoverWin = { fetch: async url => {
		calls.push(url);
		return calls.length < 3 ? busy() : sseResponse([{ candidates: [{ content: { parts: [{ text: "Recuperado" }] }, finishReason: "STOP" }] }]);
	} };
	const r3 = await core.runGemini({ system: "s", prompt: "p", win: recoverWin });
	assert.equal(r3.text, "Recuperado");
	assert.equal(calls.length, 3, "duas falhas e uma tentativa bem sucedida no mesmo modelo");
	calls = [];
	const fallbackWin = { fetch: async url => {
		calls.push(url);
		if (url.includes("/models?")) return modelList();
		if (url.includes("gemini-3.7-flash-lite")) return sseResponse([{ candidates: [{ content: { parts: [{ text: "Com outro modelo" }] }, finishReason: "STOP" }] }]);
		return busy();
	} };
	const notices = [];
	const r4 = await core.runGemini({ system: "s", prompt: "p", win: fallbackWin, onInfo: i => notices.push(i.notice) });
	assert.equal(r4.text, "Com outro modelo");
	assert.equal(r4.model, "gemini-3.7-flash-lite");
	assert.match(r4.notice, /gemini-3\.7-flash-lite.*gemini-3\.8-flash.*sobrecarregado/);
	assert.equal(calls.filter(u => u.includes("gemini-3.8-flash:")).length, 4, "quatro tentativas no modelo escolhido");
	assert.equal(notices.filter(n => /Nova tentativa/.test(n)).length, 3, "avisa cada nova tentativa");
	assert.ok(notices.some(n => /outro modelo Gemini: gemini-3\.7-flash-lite/.test(n)));
	// Um alternativo sem quota (429) não interrompe: passa ao seguinte
	calls = [];
	const quotaWin = { fetch: async url => {
		calls.push(url);
		if (url.includes("/models?")) return modelList();
		if (url.includes("gemini-3.7-flash-lite")) return errWin(429).fetch();
		return busy();
	} };
	await assert.rejects(core.runGemini({ system: "s", prompt: "p", win: quotaWin }), e => e.kind === "busy");
	// Cancelar durante a espera para de imediato
	core.GEMINI_RETRY_MS = [60000];
	const ctrl = new AbortController();
	const pending = core.runGemini({ system: "s", prompt: "p", signal: ctrl.signal, win: { fetch: async () => busy() } });
	setTimeout(() => ctrl.abort(), 20);
	await assert.rejects(pending, e => e.kind === "aborted");
	core.GEMINI_RETRY_MS = [0, 0, 0];
	assert.ok(!calls.some(u => u.includes("pro:") || u.includes("preview")), "só modelos flash estáveis como alternativa");
	calls = [];
	const deadWin = { fetch: async url => { calls.push(url); return url.includes("/models?") ? modelList() : busy(); } };
	await assert.rejects(core.runGemini({ system: "s", prompt: "p", win: deadWin }), e => e.kind === "busy" && /sobrecarregados/.test(e.message));
	// Quota esgotada: o mesmo modelo não se repete (só se procuram alternativas)
	calls = [];
	await assert.rejects(core.runGemini({ system: "s", prompt: "p", win: { fetch: async u => { calls.push(u); return errWin(429).fetch(); } } }), e => e.kind === "limit");
	assert.equal(calls.filter(u => u.includes(":streamGenerateContent")).length, 1);
	assert.equal(JSON.stringify(core.lib.geminiFallbacks("gemini-3.8-flash", ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.7-flash-lite", "gemini-3.7-flash", "gemini-3.9-flash-preview"])), JSON.stringify(["gemini-3.7-flash-lite", "gemini-3.7-flash", "gemini-3.5-flash"]));
	console.log("OK Gemini: sobrecarga (503) com novas tentativas, modelo alternativo e mensagem clara no fim");

	// Quota diária esgotada (429) num modelo: passa logo a outro e lembra-se disso no resto do dia
	const quota429 = (model, id, retry) => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
		message: `You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: ${model}\nPlease retry in 36.9s.`,
		details: [
			{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: id, quotaDimensions: { model, location: "global" }, quotaValue: "20" }] },
			{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: retry || "36s" },
		] } }), { status: 429 });
	const q = core.lib.parseGeminiQuota(await quota429("gemini-3.6-flash", "GenerateRequestsPerDayPerProjectPerModel-FreeTier").text());
	assert.equal(JSON.stringify(q), JSON.stringify({ model: "gemini-3.6-flash", limit: "20", period: "day", retrySec: 36 }));
	core.setPref("gemini.model", "gemini-3.8-flash");
	core._geminiSwap = null;
	calls = [];
	const dayWin = { fetch: async url => {
		calls.push(url);
		if (url.includes("/models?")) return modelList();
		if (url.includes("gemini-3.8-flash:")) return quota429("gemini-3.8-flash", "GenerateRequestsPerDayPerProjectPerModel-FreeTier");
		return sseResponse([{ candidates: [{ content: { parts: [{ text: "Com quota" }] }, finishReason: "STOP" }] }]);
	} };
	const r5 = await core.runGemini({ system: "s", prompt: "p", win: dayWin });
	assert.equal(r5.text, "Com quota");
	assert.equal(calls.filter(u => u.includes("gemini-3.8-flash:")).length, 1, "quota diária: não repete o mesmo modelo");
	assert.match(r5.notice, /quota gratuita do gemini-3\.8-flash acabou/);
	calls = [];
	const r6 = await core.runGemini({ system: "s", prompt: "p", win: dayWin });
	assert.equal(r6.text, "Com quota");
	assert.equal(calls.filter(u => u.includes("gemini-3.8-flash:")).length, 0, "no resto do dia vai direto ao modelo que respondeu");
	// Todos sem quota: mensagem clara, com os modelos tentados e os detalhes à parte
	core._geminiSwap = null;
	const allOut = { fetch: async url => url.includes("/models?") ? modelList() : quota429(/models\/([^:]+)/.exec(url)[1], "GenerateRequestsPerDayPerProjectPerModel-FreeTier") };
	await assert.rejects(core.runGemini({ system: "s", prompt: "p", win: allOut }), e => e.kind === "limit"
		&& /Acabou a quota gratuita diária do modelo gemini-3\.8-flash \(20 pedidos por dia\)/.test(e.message)
		&& /também tentou/.test(e.message) && !/googleapis/.test(e.message) && /googleapis/.test(e.detail));
	// Limite por minuto: espera o tempo indicado e repete o mesmo modelo
	calls = [];
	core._sleep = async () => {};
	const minuteWin = { fetch: async url => {
		calls.push(url);
		return calls.length === 1 ? quota429("gemini-3.8-flash", "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "20s")
			: sseResponse([{ candidates: [{ content: { parts: [{ text: "Depois de esperar" }] }, finishReason: "STOP" }] }]);
	} };
	const r7 = await core.runGemini({ system: "s", prompt: "p", win: minuteWin });
	assert.equal(r7.text, "Depois de esperar");
	assert.equal(calls.length, 2);
	console.log("OK Gemini: quota esgotada passa a outro modelo, lembra-se no resto do dia, limite por minuto espera, mensagem clara");

	// Teste único das definições
	const t = await core.testEngine("gemini", { fetch: async () => sseResponse([{ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }]) });
	assert.equal(t.reply, "OK");
	console.log("OK Gemini: botão Testar faz um pedido real curto");
	console.log("\nTodos os testes do Gemini passaram.");
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });
