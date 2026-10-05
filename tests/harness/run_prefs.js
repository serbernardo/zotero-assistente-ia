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
		await page.evaluate(() => document.querySelectorAll("details").forEach(d => { d.open = true; }));
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
	const tabs = ["gemini", "claude", "codex", "outros", "outros/openai"];
	const tested = new Set();
	const dead = [];
	for (const tab of tabs) {
		const go = async page => {
			const [t, seg] = tab.split("/");
			await page.click(`.zia-etab[data-engine="${t}"]`);
			if (seg) await page.click(`.zia-seg[data-engine="${seg}"]`);
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

	// 1b. Instruções de cada motor: passos com ligações, comandos para copiar e "Copiar instruções"
	for (const [tab, seg, engine, must] of [
		["claude", null, "claude", ["irm https://claude.ai/install.ps1 | iex", "curl -fsSL https://claude.ai/install.sh | bash", "claude.ai/upgrade", "Claude account with subscription"]],
		["codex", null, "codex", ["npm install -g @openai/codex", "codex login", "nodejs.org"]],
		["outros", "anthropic", "anthropic", ["console.anthropic.com/settings/keys", "console.anthropic.com/settings/billing"]],
		["outros", "openai", "openai", ["platform.openai.com/api-keys", "Plus ou Pro"]],
	]) {
		const pg = await open();
		await pg.click(`.zia-etab[data-engine="${tab}"]`);
		if (seg) await pg.click(`.zia-seg[data-engine="${seg}"]`);
		const box = pg.locator(`.zia-guide[data-guide="${engine}"]`);
		assert.ok(await box.isVisible(), "instruções visíveis: " + engine);
		assert.match(await box.textContent(), /O que é:/);
		assert.match(await box.textContent(), /Quanto custa:/);
		await box.locator("button:has-text(\"Copiar instruções\")").click();
		const text = await pg.evaluate(() => window.copied);
		for (const m of must) assert.ok(text.includes(m), `${engine}: o texto copiado tem «${m}»`);
		assert.match(text, /^1\. /m, "passos numerados");
		assert.match(text, /releases\/latest/, "termina com a ligação do assistente");
		assert.doesNotMatch(text, /AIza|sk-ant-api|sk-proj/, "nunca copia chaves");
		if (engine !== "anthropic" && engine !== "openai") {
			await box.locator(".zia-guide-copy").first().click();
			assert.ok(must.includes(await pg.evaluate(() => window.copied)), "o botão Copiar copia só o comando");
		}
		if (engine === "claude") await pg.screenshot({ path: path.join(OUT, "ui_definicoes_claude.png"), fullPage: true });
		if (engine === "codex") await pg.screenshot({ path: path.join(OUT, "ui_definicoes_codex.png"), fullPage: true });
		if (engine === "anthropic") await pg.screenshot({ path: path.join(OUT, "ui_definicoes_api.png"), fullPage: true });
		await pg.close();
	}
	console.log("OK instruções dos motores: o que é, quanto custa, passos com ligações, comandos e Copiar instruções");

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
