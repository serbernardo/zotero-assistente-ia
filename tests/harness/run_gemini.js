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
	console.log("\nTodos os testes do Gemini passaram.");
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });
