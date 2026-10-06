// Testa todos os botões das definições: abre o preferences.xhtml (convertido para HTML) num Chromium
// com o núcleo real do addon e um Zotero e uma Google simulados. Cada botão tem de fazer alguma
// coisa visível e nenhum pode dar erro. Capturas em out/.
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const OUT = path.join(__dirname, "out");
const ADDON = path.join(__dirname, "..", "..", "addon", "content");

function buildPage() {
	let x = fs.readFileSync(path.join(ADDON, "preferences.xhtml"), "utf8");
	x = x.replace(/<(\/?)html:/g, "<$1");
	x = x.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"]|"[^"]*")*?)\/>/g, "<$1$2></$1>");
	x = x.replace(/ onload="[^"]*"/, "");
	const src = f => pathToFileURL(path.join(ADDON, f)).href;
	const html = `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8">
<link rel="stylesheet" href="${src("zoteroia.css")}">
<style>
	body { font-family: system-ui, sans-serif; font-size: 13px; margin: 12px; background: #fff; }
	button[label]::after { content: attr(label); }
	checkbox { display: block; } checkbox::after { content: "☐ " attr(label); }
	label[label]::after { content: attr(label); margin-right: 6px; }
	groupbox { display: block; border: 1px solid #ddd; padding: 8px; margin: 8px 0; }
	vbox { display: block; }
</style></head><body>
${x}
<script>
	window.opened = []; window.calls = []; window.copied = null;
	window.Services = { prompt: { confirm: () => true } };
	const prefs = { engine: "gemini", "gemini.key": "", "gemini.model": "gemini-3.5-flash-lite", "gemini.modelStrong": "auto",
		"gemini.defaultApplied": true, "ui.lang": "pt-PT", "claude.model": "sonnet", "history.save": true };
	window.PREFS = prefs;
	window.Zotero = {
		debug: () => {}, logError: e => console.error(e), locale: "pt-PT",
		launchURL: u => window.opened.push(u), getMainWindow: () => window,
		File: { getContentsFromURLAsync: async () => JSON.stringify({ date: "2026-10-02T10:00:00+00:00" }) },
		Utilities: { Internal: { copyTextToClipboard: t => { window.copied = t; } } },
	};
	// Google simulada: lista de modelos, teste rápido e respostas em fluxo
	const models = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.7-flash-lite", "gemini-3.8-flash-preview", "gemini-3.7-pro"];
	const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200 });
	window.fetch = async (url, opts) => {
		window.calls.push(String(url));
		if (/generativelanguage.*\\/models\\?/.test(url)) return json({ models: models.map(m => ({ name: "models/" + m, supportedGenerationMethods: ["generateContent"] })) });
		if (/3\\.7-flash:generateContent/.test(url)) return json({ error: { code: 503, message: "high demand", status: "UNAVAILABLE" } }, 503);
		if (/:generateContent/.test(url)) return json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
		if (/:streamGenerateContent/.test(url)) return new Response('data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}\\n\\n', { status: 200 });
		if (/anthropic\\.com\\/v1\\/models/.test(url)) return json({ data: [{ id: "claude-sonnet-5-5" }] });
		if (/iaedu\\.pt/.test(url)) {
			window.iaeduCall = { url: String(url), key: opts.headers["x-api-key"], channel: opts.body.get("channel_id") };
			const b = o => JSON.stringify(o) + "\\n\\n";
			return new Response(b({ type: "start", content: "Processing" }) + b({ type: "token", content: "OK" }) + b({ type: "message", content: { content: "OK", response_metadata: { model_name: "gpt-5.5" } } }) + b({ type: "done", content: "x" }), { status: 200 });
		}
		if (/openai\\.com\\/v1\\/models/.test(url)) return json({ data: [{ id: "gpt-5" }] });
		return json({ error: { message: "não simulado" } }, 500);
	};
</script>
<script src="${src("i18n.js")}"></script>
<script src="${src("lib.js")}"></script>
<script src="${src("chatview.js")}"></script>
<script src="${src("zoteroia.js")}"></script>
<script src="${src("preferences.js")}"></script>
<script>
	const core = ZoteroIA;
	core.init({ id: "t", version: "0.5.0", rootURI: "" });
	core.pref = k => prefs[k];
	core.setPref = (k, v) => { prefs[k] = v; };
	core.applyLanguage();
	const vault = {};
	core.setSecret = async (n, v) => { vault[n] = v; prefs[n + ".key"] = v ? "oskv1:x" : ""; };
	core.getSecret = async n => vault[n] || "";
	core.testClaude = async () => ({ model: "claude-sonnet-5-5", reply: "OK" });
	core.testCodex = async () => ({ model: "gpt-5", reply: "OK" });
	core.findToolExecutable = async n => "/usr/local/bin/" + n;
	core.openClaudeSetup = async () => { window.calls.push("openClaudeSetup"); return { opened: true }; };
	core.checkForUpdates = async () => ({ status: "none" });
	core.clearAllConversations = async () => { window.calls.push("clearAllConversations"); };
	if (new URLSearchParams(location.search).get("key")) core.setSecret("gemini", "AIza-teste");
	Zotero.ZoteroIA = core;
	window.ZIAPrefs.init();
</script></body></html>`;
	const file = path.join(OUT, "prefs_teste.html");
	fs.writeFileSync(file, html);
	return pathToFileURL(file).href;
}

function launchOptions() {
	if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
	if (process.platform === "win32") return { channel: "msedge" };
	return {};
}

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	const URL = buildPage();
	const browser = await chromium.launch(launchOptions());
	const errors = [];
	const open = async () => {
		const page = await browser.newPage({ viewport: { width: 820, height: 1400 } });
		page.on("pageerror", e => errors.push(e.message));
		page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
		await page.goto(URL + "?key=1");
		// os botões XUL disparam "command": no HTML, um clique passa a "command"
		await page.evaluate(() => document.addEventListener("click", ev => {
			const b = ev.target.closest("button[id]");
			if (b && !b.disabled) b.dispatchEvent(new Event("command", { bubbles: true }));
		}));
		// abre as opções avançadas, para testar também os botões lá dentro
		await page.evaluate(() => document.querySelectorAll(".zia-pfold").forEach(f => window.ZIAPrefs.openFold(f)));
		await page.waitForTimeout(150);
		return page;
	};
	const snapshot = page => page.evaluate(() => JSON.stringify([
		document.getElementById("zoteroia-prefs-root").innerHTML, window.opened, window.calls, window.copied, window.PREFS,
	]));
	const visibleButtons = page => page.evaluate(() => {
		const els = [...document.querySelectorAll("button, .zia-etab, a.zia-link")]
			.filter(b => b.checkVisibility() && !b.disabled && !b.classList.contains("selected"));
		return els.map((b, i) => { b.dataset.t = String(i); return (b.id || b.dataset.engine || b.getAttribute("data-url") || b.textContent).trim().slice(0, 50); });
	});

	// 1. Cada separador de motor mostra a sua configuração
	const tabs = ["gemini", "claude", "codex", "anthropic", "openai", "iaedu"];
	const tested = new Set();
	const dead = [];
	for (const tab of tabs) {
		const go = async page => {
			await page.click(`.zia-etab[data-engine="${tab}"]`);
		};
		const p0 = await open();
		await go(p0);
		if (tab === "gemini") await p0.screenshot({ path: path.join(OUT, "ui_definicoes_gemini.png"), fullPage: false });
		const labels = await visibleButtons(p0);
		await p0.close();
		for (let i = 0; i < labels.length; i++) {
			if (tested.has(labels[i])) continue;
			tested.add(labels[i]);
			const page = await open();
			await go(page);
			await visibleButtons(page);
			const before = errors.length;
			const s0 = await snapshot(page);
			await page.click(`[data-t="${i}"]`);
			let changed = false;
			for (let t = 0; t < 20 && !changed; t++) {
				await page.waitForTimeout(100);
				changed = (await snapshot(page)) !== s0;
			}
			if (!changed) dead.push(`${tab}: ${labels[i]}`);
			if (errors.length > before) dead.push(`${tab}: ${labels[i]} (erro: ${errors.slice(before).join(" | ")})`);
			await page.close();
		}
	}
	assert.equal(dead.length, 0, "botões das definições sem efeito ou com erro: " + dead.join(", "));
	console.log(`OK definições: ${tested.size} botões, separadores e ligações respondem sem erros`);
	console.log("   " + [...tested].join(", "));

	// 1b. Instruções de cada motor: custo, passos com ligações e comandos, texto que se seleciona (sem botões de copiar)
	for (const [tab, seg, engine, must] of [
		["claude", null, "claude", ["irm https://claude.ai/install.ps1 | iex", "curl -fsSL https://claude.ai/install.sh | bash", "claude.ai/upgrade", "Claude account with subscription"]],
		["codex", null, "codex", ["npm install -g @openai/codex", "codex login", "nodejs.org"]],
		["anthropic", null, "anthropic", ["console.anthropic.com/settings/keys", "console.anthropic.com/settings/billing", "custo mínimo de 5 $"]],
		["openai", null, "openai", ["platform.openai.com/api-keys", "5 $"]],
		["iaedu", null, "iaedu", ["iaedu.pt", "roda dentada", "Informação da API", "Chave da API"]],
	]) {
		const pg = await open();
		await pg.click(`.zia-etab[data-engine="${tab}"]`);
		const box = pg.locator(`.zia-guide[data-guide="${engine}"]`);
		assert.ok(await box.isVisible(), "instruções visíveis: " + engine);
		const text = await box.textContent();
		assert.match(text, /Quanto custa:/);
		assert.doesNotMatch(text, /O que é:|Copiar instruções/, "sem repetir a linha do motor e sem Copiar instruções");
		for (const m of must) assert.ok(text.includes(m), `${engine}: as instruções têm «${m}»`);
		const cmds = await box.locator(".zia-command").count();
		assert.equal(await box.locator("button").count(), cmds, "só um botão Copiar por comando");
		if (cmds) {
			await box.locator(".zia-guide-copy").first().click();
			assert.ok(must.includes(await pg.evaluate(() => window.copied)), "o botão Copiar copia só o comando");
		}
		assert.equal(await box.locator("li").first().evaluate(e => getComputedStyle(e).userSelect), "text", "o texto seleciona-se para copiar com Ctrl+C");
		const links = await box.locator("a.zia-link").count();
		assert.ok(links >= 1, "as ligações são clicáveis");
		if (engine === "claude") await pg.screenshot({ path: path.join(OUT, "ui_definicoes_claude.png"), fullPage: true });
		if (engine === "codex") await pg.screenshot({ path: path.join(OUT, "ui_definicoes_codex.png"), fullPage: true });
		if (engine === "anthropic") await pg.screenshot({ path: path.join(OUT, "ui_definicoes_api.png"), fullPage: true });
		await pg.close();
	}
	{
		const pg = await open();
		const order = await pg.$$eval(".zia-etab", ts => ts.map(t => t.dataset.engine));
		assert.deepEqual(order, ["iaedu", "gemini", "anthropic", "openai", "claude", "codex"], "um separador por motor, IAEdu primeiro");
		assert.doesNotMatch(await pg.textContent("#zia-engines"), /Recomendado/);
		const weight = e => pg.$eval(`.zia-etab[data-engine="${e}"]`, t => getComputedStyle(t).fontWeight);
		assert.equal(await weight("gemini"), "700", "o separador escolhido fica a negrito");
		assert.equal(await weight("iaedu"), "400");
		for (const e of ["anthropic", "openai", "gemini", "iaedu"]) {
			assert.equal(await pg.getAttribute(`#zia-${e}-key`, "placeholder"), "Inserir API Key");
		}
		// arrastar o IAEdu para o início muda a ordem e fica guardada
		await pg.dragAndDrop('.zia-etab[data-engine="codex"]', '.zia-etab[data-engine="iaedu"]');
		assert.deepEqual(await pg.$$eval(".zia-etab", ts => ts.map(t => t.dataset.engine)), ["codex", "iaedu", "gemini", "anthropic", "openai", "claude"]);
		assert.equal(await pg.evaluate(() => window.PREFS["engines.tabOrder"]), "codex,iaedu,gemini,anthropic,openai,claude");
		await pg.close();
	}
	console.log("OK separadores: um por motor, escolhido a negrito, Inserir API Key, arrastar para mudar a ordem");

	// 1d. Blocos que abrem e fecham, com listas que funcionam lá dentro (antes, dentro de <details>, não abriam)
	{
		const pg = await browser.newPage({ viewport: { width: 820, height: 1400 } });
		pg.on("pageerror", e => errors.push(e.message));
		await pg.goto(URL + "?key=1");
		await pg.waitForTimeout(150);
		assert.ok(!(await pg.isVisible("#zia-gemini-model")), "Opções avançadas começam fechadas");
		assert.ok(!(await pg.isVisible("#zia-clear-all")), "Privacidade começa fechada");
		assert.ok(await pg.isVisible("#zia-cite-style"), "Respostas começa aberta");
		assert.equal(await pg.locator("#zia-custom-prompts").count(), 0, "sem Ações personalizadas nas definições");
		await pg.click('.zia-engine-panel[data-engine="gemini"] .zia-advanced > .zia-pfold-head');
		assert.ok(await pg.isVisible("#zia-gemini-model"));
		await pg.selectOption("#zia-gemini-model", "gemini-3.6-flash");
		assert.equal(await pg.evaluate(() => window.PREFS["gemini.model"]), "gemini-3.6-flash", "a lista funciona dentro do bloco");
		await pg.click('.zia-section[data-section="prefs.answers.title"] > .zia-pfold-head');
		assert.ok(!(await pg.isVisible("#zia-cite-style")), "carregar no título minimiza a secção");
		const box = await pg.$eval('.zia-section[data-section="prefs.security.title"]', el => el.getBoundingClientRect().right);
		await pg.click('.zia-section[data-section="prefs.answers.title"] > .zia-pfold-head');
		const sel = await pg.$eval("#zia-cite-style", el => el.getBoundingClientRect().right);
		assert.ok(sel <= box + 1, "a lista não sai da caixa");
		await pg.close();
	}
	console.log("OK blocos: abrem e fecham, listas funcionam lá dentro e não saem da caixa");

	// 1e. Buy me a coffee nos créditos
	{
		let pg = await open();
		assert.equal(await pg.locator(".zia-coffee").count(), 0, "escondido por omissão");
		await pg.close();
		pg = await open();
		await pg.evaluate(() => { ZoteroIA.SUPPORT_ENABLED = true; window.ZIAPrefs.showBuildInfo(); });
		const btn = pg.locator(".zia-credits .zia-coffee");
		assert.equal(await btn.count(), 1);
		assert.ok(await btn.isVisible());
		await btn.click();
		assert.ok((await pg.evaluate(() => window.opened)).includes("https://github.com/serbernardo/zotero-assistente-ia/blob/main/APOIAR.md"));
		await pg.screenshot({ path: path.join(OUT, "ui_definicoes_creditos.png"), fullPage: true });
		await pg.close();
	}
	console.log("OK Buy me a coffee nos créditos: escondido por omissão; ligado, abre a página de apoio");
	console.log("OK instruções dos motores: custo, passos com ligações e comandos, texto selecionável, Copiar só nos comandos");

	// 1c. IAEdu: só a chave chega (agente por omissão), os campos de outro agente são opcionais e validados
	{
		const pg = await open();
		await pg.click('.zia-etab[data-engine="iaedu"]');
		const KEY = "sk-usr-abcdefghijklmnopqrstuvwxyz0123";
		const state = () => pg.textContent("#zia-iaedu-keystate");
		const DEF = await pg.evaluate(() => ({ url: ZoteroIA.lib.IAEDU_DEFAULT_ENDPOINT, channel: ZoteroIA.lib.IAEDU_DEFAULT_CHANNEL }));
		await pg.fill("#zia-iaedu-key", KEY);
		await pg.click("#zia-iaedu-save");
		await pg.waitForSelector(".zia-test-result.ok");
		assert.match(await pg.textContent("#zia-test-result"), /gpt-5\.5/);
		assert.deepEqual(await pg.evaluate(() => window.iaeduCall), { url: DEF.url, key: KEY, channel: DEF.channel }, "só com a chave usa o agente por omissão");
		assert.deepEqual(await pg.evaluate(() => [window.PREFS["iaedu.endpoint"], window.PREFS["iaedu.channel"], window.PREFS["iaedu.lastTest"]]), ["", "", "ok"]);
		await pg.screenshot({ path: path.join(OUT, "ui_definicoes_iaedu.png"), fullPage: true });

		// outro agente: valida antes de enviar
		await pg.evaluate(() => { window.iaeduCall = null; });
		await pg.fill("#zia-iaedu-endpoint", "https://evil.example.com/agent");
		await pg.fill("#zia-iaedu-channel", "canal-de-teste-01");
		await pg.click("#zia-iaedu-save");
		assert.match(await state(), /iaedu\.pt/, "endereço de fora recusado");
		await pg.fill("#zia-iaedu-endpoint", "https://api.iaedu.pt/agent-chat//api/v1/agent/AGENTE123/stream");
		await pg.fill("#zia-iaedu-channel", "curto");
		await pg.click("#zia-iaedu-save");
		assert.match(await state(), /Canal/, "canal inválido recusado");
		await pg.fill("#zia-iaedu-channel", "");
		await pg.click("#zia-iaedu-save");
		assert.match(await state(), /Canal/, "endereço sem canal recusado");
		assert.equal(await pg.evaluate(() => window.iaeduCall || null), null, "nada saiu até estar tudo certo");
		await pg.fill("#zia-iaedu-channel", "canal-de-teste-01");
		await pg.click("#zia-iaedu-save");
		await pg.waitForFunction(() => !!window.iaeduCall);
		assert.deepEqual(await pg.evaluate(() => window.iaeduCall), { url: "https://api.iaedu.pt/agent-chat//api/v1/agent/AGENTE123/stream", key: KEY, channel: "canal-de-teste-01" });
		assert.ok(!(await pg.evaluate(() => window.calls)).some(u => /evil/.test(u)), "a chave nunca foi para fora");

		// campos em branco voltam ao agente por omissão
		await pg.evaluate(() => { window.iaeduCall = null; });
		await pg.fill("#zia-iaedu-endpoint", "");
		await pg.fill("#zia-iaedu-channel", "");
		await pg.click("#zia-iaedu-save");
		await pg.waitForFunction(() => !!window.iaeduCall);
		assert.equal((await pg.evaluate(() => window.iaeduCall)).url, DEF.url);
		await pg.close();
	}
	console.log("OK IAEdu nas definições: só a chave chega, outro agente é opcional e validado, em branco volta ao agente por omissão");

	// 2. Teste rápido dos modelos Gemini: mostra quem responde e quem está sobrecarregado
	const page = await open();
	await page.click("#zia-gemini-probe");
	await page.waitForSelector(".zia-probe-row");
	await page.waitForFunction(() => !document.getElementById("zia-gemini-probe").disabled);
	const rows = await page.$$eval(".zia-probe-row", rs => rs.map(r => r.className.replace("zia-probe-row zia-probe-", "") + ":" + r.querySelector(".zia-probe-name").textContent));
	assert.ok(rows.includes("busy:gemini-3.7-flash"), rows.join(" "));
	assert.ok(rows.includes("ok:gemini-3.5-flash-lite"));
	await page.click('.zia-probe-ok:has-text("gemini-3.6-flash") >> text=Usar para análises');
	assert.equal(await page.evaluate(() => window.PREFS["gemini.modelStrong"]), "gemini-3.6-flash");
	assert.equal(await page.inputValue("#zia-gemini-strong"), "gemini-3.6-flash");
	await page.screenshot({ path: path.join(OUT, "ui_definicoes_testar_modelos.png"), fullPage: false });
	console.log("OK testar modelos Gemini: " + rows.join(", ") + "; escolher para análises atualiza a lista");
	await page.close();

	await browser.close();
	if (errors.length) {
		console.error("Erros na página:", errors);
		process.exit(1);
	}
	console.log("\nTodos os testes das definições passaram.");
}

main().catch(e => { console.error("FALHOU:", e); process.exit(1); });
