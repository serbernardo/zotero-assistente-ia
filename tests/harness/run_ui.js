// Testa a interface num navegador Chromium com o Zotero simulado e tira capturas de ecrã.
// Navegador: PW_CHROMIUM=<caminho> ou, por omissão, o Edge (Windows) ou o Chromium do Playwright.
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const OUT = path.join(__dirname, "out");
const URL = pathToFileURL(path.join(__dirname, "ui.html")).href;
const comparar = fs.readFileSync(path.join(OUT, "comparar_D1_D2.md"), "utf8");
const pontos = fs.readFileSync(path.join(OUT, "pontos_D1.md"), "utf8");

function launchOptions() {
	if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
	if (process.platform === "win32") return { channel: "msedge" };
	return {};
}

async function main() {
	const browser = await chromium.launch(launchOptions());
	const errors = [];
	const open = async (query, viewport) => {
		const page = await browser.newPage({ viewport });
		page.on("pageerror", e => errors.push(e.message));
		page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
		await page.goto(URL + query);
		await page.evaluate(() => window.ready);
		return page;
	};
	const tab = (page, group) => page.click(`.zia-tab[data-group="${group}"]`);
	// Escolher uma ação e depois pedir (clicar numa ação já não envia logo)
	const act = async (page, id) => {
		await page.click(`button[data-action="${id}"]`);
		await page.click(".zia-send");
	};

	// ---------- Janela: comparar 2 PDFs ----------
	for (const dark of [false, true]) {
		const page = await open("?mode=window" + (dark ? "&dark=1" : ""), { width: 820, height: 900 });
		await page.evaluate(a => { window.MOCK.answer = a; }, comparar);
		await tab(page, "investigar");
		assert.equal(await page.isDisabled('button[data-action="comparar"]'), true, "comparar desativado sem PDFs");
		await page.click("button:has-text(\"Selecionados\")");
		await page.waitForSelector(".zia-chip >> nth=1");
		assert.equal(await page.isDisabled('button[data-action="comparar"]'), false);
		await act(page, "comparar");
		// durante o fluxo: botão Parar e indicador de progresso
		await page.waitForSelector(".zia-send.zia-stop");
		await page.waitForSelector(".zia-spinner");
		if (!dark) await page.screenshot({ path: path.join(OUT, "ui_janela_fluxo.png") });
		await page.waitForSelector("text=Exportar tabela (CSV)", { timeout: 30000 });
		const cites = await page.locator(".zia-cite").count();
		assert.ok(cites > 20, "citações clicáveis: " + cites);
		const label = await page.locator(".zia-cite").first().textContent();
		assert.match(label, /Silva et al\., 2021, p\. \d/);
		await page.locator(".zia-cite").first().click();
		const opened = await page.evaluate(() => window.opened);
		assert.match(opened[0], /SILVAPDF#\d/);
		assert.equal(await page.locator(".zia-table").count(), 1);
		assert.equal(await page.locator(".zia-action-tag").first().textContent(), "Comparar PDFs");
		await page.screenshot({ path: path.join(OUT, dark ? "ui_janela_comparar_escuro.png" : "ui_janela_comparar.png"), fullPage: false });
		// copiar converte citações
		await page.click("text=Copiar");
		const copied = await page.evaluate(() => window.copied);
		assert.ok(copied.includes("(Silva et al., 2021, p.") && !copied.includes("[D1:"));
		// guardar nota
		await page.click("text=Guardar como nota");
		await page.waitForSelector("text=Nota guardada");
		// pergunta de seguimento usa o histórico
		await page.evaluate(() => { window.MOCK.answer = "Resposta de seguimento [D2:p4]."; });
		await page.fill(".zia-textarea", "E quanto à confiança dos utilizadores?");
		await page.keyboard.press("Enter");
		await page.waitForSelector("text=Resposta de seguimento");
		assert.match(await page.evaluate(() => window.lastPrompt), /<historico>/);
		console.log(`OK janela ${dark ? "(escuro)" : ""}: comparação com ${cites} citações, abrir página, copiar, nota, seguimento`);
		await page.close();
	}

	// ---------- Painel lateral: sugestões, erro de limite e repetição com Gemini ----------
	{
		const page = await open("?mode=section", { width: 420, height: 900 });
		assert.equal(await page.locator(".zia-chip").count(), 1);
		assert.equal(JSON.stringify(await page.$$eval(".zia-engine option", os => os.map(o => o.value))), JSON.stringify(["gemini", "claude", "codex"]),
			"Gemini, Claude Code e Codex, nesta ordem; chaves de API só quando configuradas");
		assert.equal(await page.locator(".zia-tab-add").count(), 0, "sem botão +");
		assert.equal(await page.locator('.zia-tab[data-group="meus"]').count(), 1, "separador Os meus sempre visível");
		assert.equal(await page.locator(".zia-suggestion").count(), 4, "sugestões de perguntas");
		await page.screenshot({ path: path.join(OUT, "ui_painel_vazio.png") });
		await tab(page, "investigar");
		assert.equal(await page.isDisabled('button[data-action="comparar"]'), true);
		await tab(page, "compreender");
		await page.evaluate(() => { window.MOCK.error = { kind: "limit", message: "Atingiste o limite de utilização da subscrição do Claude. Podes repetir o pedido com o Gemini ou esperar que o limite reinicie." }; });
		await act(page, "pontos");
		await page.waitForSelector(".zia-error");
		await page.screenshot({ path: path.join(OUT, "ui_painel_erro_limite.png") });
		await page.evaluate(a => { window.MOCK.error = null; window.MOCK.answer = a; }, pontos);
		await page.click("text=Repetir com Gemini");
		await page.waitForSelector("text=Guardar como nota", { timeout: 30000 });
		assert.equal(await page.evaluate(() => window.lastEngine), "gemini");
		assert.equal(await page.locator(".zia-error").count(), 0, "erro retirado após repetição");
		await page.screenshot({ path: path.join(OUT, "ui_painel_pontos.png") });
		console.log("OK painel: sugestões, erro de limite, repetição com Gemini, resposta com citações");
		await page.close();
	}

	// ---------- Painel estreito: nada fica cortado e o painel não força largura ----------
	{
		const page = await open("?mode=section", { width: 700, height: 700 });
		for (const w of [240, 280, 320]) {
			await page.evaluate(w => { document.querySelector(".pane").style.width = w + "px"; }, w);
			const r = await page.evaluate(() => {
				const box = document.querySelector("collapsible-section").getBoundingClientRect();
				const inside = sel => { const b = document.querySelector(sel).getBoundingClientRect(); return b.left >= box.left && b.right <= box.right + 0.5 && b.width > 0; };
				return { gear: inside(".zia-bar-tools .zia-btn-icon"), engine: inside(".zia-engine"), send: inside(".zia-send") };
			});
			assert.ok(r.gear && r.engine && r.send, `largura ${w}: ⚙, motor e Enviar visíveis ${JSON.stringify(r)}`);
		}
		await page.evaluate(() => { document.querySelector(".pane").style.width = "min-content"; });
		const minW = await page.evaluate(() => document.querySelector(".pane").getBoundingClientRect().width);
		assert.ok(minW < 200, `o painel não pode exigir largura mínima grande (${minW}px)`);
		console.log("OK painel estreito: ⚙, motor e Enviar sempre visíveis, sem forçar a largura do Zotero");
		await page.close();
	}

	// ---------- Sugestão de pergunta e língua das respostas ----------
	{
		const page = await open("?mode=section&lang=en", { width: 420, height: 700 });
		await page.evaluate(() => { window.MOCK.answer = "The main finding is X [D1:p3]."; });
		await page.locator(".zia-suggestion").first().click();
		assert.equal(await page.evaluate(() => window.lastEngine), undefined, "a sugestão só preenche a caixa");
		await page.click(".zia-send");
		await page.waitForSelector("text=The main finding");
		assert.match(await page.evaluate(() => window.lastSystem), /inglês/);
		assert.match(await page.locator(".zia-msg-user").first().textContent(), /pergunta de investigação/);
		console.log("OK sugestão de pergunta enviada, respostas em inglês");
		await page.close();
	}

	// ---------- Interface em inglês ----------
	{
		const page = await open("?mode=section&ui=en", { width: 420, height: 800 });
		assert.equal(await page.textContent('button[data-action="resumo"]'), "Summarise");
		assert.equal(await page.textContent('.zia-tab[data-group="compreender"]'), "Understand");
		assert.equal(await page.textContent(".zia-send"), "Send ➤");
		assert.match(await page.locator(".zia-suggestion").first().textContent(), /research question/);
		await page.evaluate(() => { window.MOCK.answer = "The main finding is X [D1:p3]."; });
		await act(page, "resumo");
		await page.waitForSelector("text=Save as note");
		assert.match(await page.evaluate(() => window.lastSystem), /inglês/, "respostas em inglês por omissão");
		await page.screenshot({ path: path.join(OUT, "ui_painel_ingles.png") });
		console.log("OK interface em inglês: botões, separadores, sugestões e respostas em inglês");
		await page.close();
	}

	// ---------- Configuração inicial ----------
	{
		const page = await open("?mode=section&setup=1", { width: 420, height: 800 });
		await page.waitForSelector("text=Liga o assistente a uma IA");
		assert.equal(await page.locator(".zia-option").count(), 3, "Claude, ChatGPT e Gemini");
		assert.equal(await page.locator(".zia-setup button[data-engine]").count(), 5, "5 formas de ligação");
		await page.screenshot({ path: path.join(OUT, "ui_configuracao.png") });
		// uma ação sem motor mostra o cartão e não envia nada
		await act(page, "resumo");
		assert.equal(await page.evaluate(() => window.lastEngine), undefined);
		await page.click('.zia-setup button[data-engine="anthropic"]');
		assert.deepEqual(await page.evaluate(() => window.opened), ["prefs"]);
		await page.click('.zia-setup button[data-engine="codex"]');
		await page.waitForSelector(".zia-suggestion");
		assert.equal(await page.inputValue(".zia-engine"), "codex");
		console.log("OK configuração inicial: Claude, ChatGPT e Gemini, nada é enviado sem motor, conta ChatGPT (Codex) ativada com um clique");
		await page.close();
	}

	// ---------- Aviso de privacidade no primeiro pedido ----------
	{
		const page = await open("?mode=section&noack=1", { width: 420, height: 800 });
		await page.evaluate(a => { window.MOCK.answer = a; }, pontos);
		await act(page, "resumo");
		await page.waitForSelector(".zia-privacy");
		await page.screenshot({ path: path.join(OUT, "ui_privacidade.png") });
		await page.click(".zia-privacy >> text=Cancelar");
		await page.waitForSelector(".zia-privacy", { state: "detached" });
		assert.equal(await page.evaluate(() => window.lastEngine), undefined, "cancelar não envia nada");
		await act(page, "resumo");
		await page.click("text=Aceitar e continuar");
		await page.waitForSelector("text=Guardar como nota", { timeout: 30000 });
		assert.equal(await page.evaluate(() => window.lastEngine), "claude");
		// segundo pedido: já não pergunta
		await page.evaluate(() => { window.MOCK.answer = "Outra resposta [D1:p1]."; });
		await act(page, "pontos");
		await page.waitForSelector("text=Outra resposta");
		assert.equal(await page.locator(".zia-privacy").count(), 0);
		console.log("OK privacidade: aviso antes do primeiro envio, cancelar não envia, aceitar fica memorizado");
		await page.close();
	}

	// ---------- Etiquetas ----------
	{
		const page = await open("?mode=section", { width: 420, height: 800 });
		await tab(page, "escrever");
		await page.evaluate(() => { window.MOCK.answer = "- **bibliotecas universitárias**: contexto do estudo [D1:p1]\n- **chatbots**: tema central [D1:p2]\n\nETIQUETAS: bibliotecas universitárias | chatbots | inquérito"; });
		await act(page, "etiquetas");
		await page.waitForSelector(".zia-tag >> nth=2", { timeout: 30000 });
		await page.screenshot({ path: path.join(OUT, "ui_etiquetas.png") });
		await page.click("text=Adicionar ao item");
		await page.waitForSelector("text=Etiquetas adicionadas");
		const tagged = await page.evaluate(() => window.tagged);
		assert.deepEqual(tagged.tags, ["bibliotecas universitárias", "chatbots", "inquérito"]);
		console.log("OK etiquetas: sugeridas e adicionadas ao item com um clique");
		await page.close();
	}

	// ---------- Os meus prompts ----------
	{
		const page = await open("?mode=section&custom=" + encodeURIComponent("Teoria: Identifica o enquadramento teórico."), { width: 420, height: 800 });
		await tab(page, "meus");
		await page.evaluate(() => { window.MOCK.answer = "Teoria da aceitação [D1:p2]."; });
		await page.click("button.zia-action:has-text(\"Teoria\")");
		await page.click(".zia-send");
		await page.waitForSelector("text=Teoria da aceitação");
		assert.match(await page.evaluate(() => window.lastPrompt), /Identifica o enquadramento teórico\./);
		console.log("OK os meus prompts: separador próprio e pedido com a instrução do utilizador");
		await page.close();
	}

	// ---------- Escolher e pedir, respostas recolhidas e histórico guardado ----------
	{
		const page = await open("?mode=section", { width: 420, height: 900 });
		await page.evaluate(a => { window.MOCK.answer = a; }, pontos);
		await page.click('button[data-action="resumo"]');
		assert.equal(await page.evaluate(() => window.lastEngine), undefined, "clicar numa ação não envia logo");
		assert.equal(await page.getAttribute('button[data-action="resumo"]', "aria-pressed"), "true");
		assert.equal(await page.textContent(".zia-pending-chip"), "Resumir✕");
		assert.equal(await page.textContent(".zia-send"), "Pedir ➤");
		await page.click('button[data-action="resumo"]');
		assert.equal(await page.isHidden(".zia-pending"), true, "clicar outra vez cancela a escolha");
		await page.click('button[data-action="resumo"]');
		await page.fill(".zia-textarea", "foca a metodologia");
		await page.keyboard.press("Enter");
		await page.waitForSelector("text=Guardar como nota");
		assert.match(await page.evaluate(() => window.lastPrompt), /Indicações adicionais do utilizador: foca a metodologia/);
		assert.equal(await page.locator('button[data-action="resumo"].zia-done').count(), 1, "ação já pedida fica marcada");
		await act(page, "pontos");
		await page.waitForFunction(() => document.querySelectorAll(".zia-msg-assistant").length === 2 && !document.querySelector(".zia-typing"));
		assert.equal(await page.locator(".zia-msg-assistant.zia-collapsed").count(), 1, "a resposta anterior fica recolhida");
		assert.equal(await page.locator(".zia-msg-user:not([hidden])").count(), 1, "a pergunta da resposta recolhida fica escondida");
		await page.screenshot({ path: path.join(OUT, "ui_painel_recolhido.png") });
		// escolher uma ação já pedida mostra a resposta que existe
		const before = await page.evaluate(() => window.lastPrompt);
		await page.click('button[data-action="resumo"]');
		assert.equal(await page.locator(".zia-msg-assistant.zia-collapsed").count(), 0, "a resposta do resumo volta a abrir");
		assert.match(await page.textContent(".zia-status"), /Já pediste/);
		assert.equal(await page.evaluate(() => window.lastPrompt), before, "nada foi enviado");
		await page.click('button[data-action="resumo"]');
		// o título recolhe e abre
		await page.locator(".zia-msg-assistant .zia-msg-head").first().click();
		assert.equal(await page.locator(".zia-msg-assistant.zia-collapsed").count(), 1);
		// histórico: outra sessão do Zotero (memória vazia) recupera a conversa guardada
		assert.equal(await page.evaluate(() => [...window.FILES.keys()].length), 1, "conversa guardada num ficheiro");
		await page.evaluate(async () => {
			await view.showItem(null);
			ZoteroIA.sessions.clear();
			await view.showItem(window.ITEM_A);
		});
		await page.waitForSelector(".zia-msg-assistant");
		assert.equal(await page.locator(".zia-msg-assistant").count(), 2, "respostas recuperadas");
		assert.equal(await page.locator(".zia-msg-assistant.zia-collapsed").count(), 1, "só a última fica aberta");
		assert.match(await page.textContent(".zia-status"), /Conversa anterior recuperada/);
		await page.click("text=Nova conversa");
		assert.equal(await page.evaluate(() => [...window.FILES.keys()].length), 0, "nova conversa apaga o ficheiro");
		console.log("OK ações: escolher e depois pedir, respostas anteriores recolhidas, ação já pedida mostra a resposta, histórico guardado por artigo");
		await page.close();
	}

	// ---------- Personalizado, ordem das respostas e nota a partir de uma resposta recolhida ----------
	{
		const page = await open("?mode=section", { width: 420, height: 900 });
		await page.evaluate(() => { window.MOCK.answer = "Resposta A [D1:p1]."; });
		// caixa de texto antes das respostas
		const order = await page.evaluate(() => {
			const r = document.querySelector(".zia-root");
			const kids = [...r.children];
			return kids.indexOf(r.querySelector(".zia-input")) < kids.indexOf(r.querySelector(".zia-messages"));
		});
		assert.ok(order, "a caixa de texto fica antes das respostas");
		await tab(page, "meus");
		assert.equal(await page.textContent('.zia-tab[data-group="meus"]'), "Personalizado");
		await page.click(".zia-action-new");
		await page.fill(".zia-custom-name", "Teoria");
		await page.fill(".zia-custom-prompt", "Identifica o enquadramento teórico.");
		await page.click(".zia-custom-btns button:has-text(\"Guardar\")");
		assert.equal(await page.evaluate(() => ZoteroIA.pref("custom.prompts")), "Teoria: Identifica o enquadramento teórico.");
		await act(page, "custom:teoria");
		await page.waitForSelector("text=Guardar como nota");
		assert.match(await page.evaluate(() => window.lastPrompt), /Identifica o enquadramento teórico\./);
		// editar e apagar
		await page.click("button:has-text(\"✎ Editar\")");
		await page.click('button[data-action="custom:teoria"]');
		await page.fill(".zia-custom-prompt", "Identifica a teoria e os autores.");
		await page.click(".zia-custom-btns button:has-text(\"Guardar\")");
		assert.equal(await page.evaluate(() => ZoteroIA.pref("custom.prompts")), "Teoria: Identifica a teoria e os autores.");
		page.once("dialog", d => d.accept());
		await page.click("button:has-text(\"✎ Editar\")");
		await page.click('button[data-action="custom:teoria"]');
		await page.click(".zia-custom-btns button:has-text(\"Apagar\")");
		assert.equal(await page.evaluate(() => ZoteroIA.pref("custom.prompts")), "");
		// a resposta mais recente fica em cima e a anterior pode ser guardada como nota já recolhida
		await tab(page, "compreender");
		await page.evaluate(() => { window.MOCK.answer = "Resposta B [D1:p2]."; });
		await act(page, "resumo");
		await page.waitForFunction(() => document.querySelectorAll(".zia-msg-assistant").length === 2 && !document.querySelector(".zia-send.zia-stop"));
		assert.match(await page.textContent(".zia-msg-assistant >> nth=0"), /Resposta B/, "a mais recente em cima");
		await page.evaluate(() => { window.saved = []; const o = ZoteroIA.saveNote; ZoteroIA.saveNote = async a => { window.saved.push(a.heading); return o(a); }; });
		await page.click(".zia-msg-assistant.zia-collapsed .zia-head-save");
		assert.equal(await page.evaluate(() => window.saved.length), 1, "resposta recolhida guardada como nota");
		assert.equal(await page.locator(".zia-msg-assistant.zia-collapsed").count(), 1, "guardar não abre nem fecha a resposta");
		await page.screenshot({ path: path.join(OUT, "ui_painel_personalizado.png") });
		console.log("OK personalizado: criar, usar, editar e apagar ações no painel; caixa de texto antes das respostas; guardar nota numa resposta recolhida");
		await page.close();
	}

	// ---------- Cancelamento ----------
	{
		const page = await open("?mode=section", { width: 420, height: 700 });
		await page.evaluate(a => { window.MOCK.answer = a; window.MOCK.delayMs = 40; }, pontos);
		await act(page, "resumo");
		await page.waitForSelector(".zia-send.zia-stop");
		await page.waitForTimeout(600);
		await page.click(".zia-send");
		await page.waitForSelector("text=Pedido cancelado.");
		assert.equal(await page.textContent(".zia-send"), "Enviar ➤");
		console.log("OK cancelamento no painel");
		await page.close();
	}

	// ---------- Coleção e comparar via fichas ----------
	{
		const page = await open("?mode=window", { width: 820, height: 900 });
		await page.evaluate(() => {
			window.calls = [];
			window.saved = [];
			const orig = ZoteroIA.runEngine;
			ZoteroIA.runEngine = async (engine, o) => { window.calls.push(o.prompt); return orig(engine, o); };
			const origSave = ZoteroIA.saveNote;
			ZoteroIA.saveNote = async a => { window.saved.push(a.heading); return origSave(a); };
			window.MOCK.answer = "| Campo | Conteúdo |\n|---|---|\n| Método | Inquérito [D1:p3] |";
		});
		await page.click("button:has-text(\"+ Coleção\")");
		await page.waitForSelector(".zia-chip >> nth=1");
		await tab(page, "investigar");
		await page.check(".zia-fichas-toggle input");
		await act(page, "comparar");
		await page.waitForFunction(() => window.calls.length === 3 && !document.querySelector(".zia-stop"), null, { timeout: 30000 });
		const calls = await page.evaluate(() => window.calls);
		assert.match(calls[0], /Preenche uma ficha/);
		assert.match(calls[1], /Preenche uma ficha/);
		assert.match(calls[2], /tipo="ficha"/, "a comparação usa as fichas");
		assert.ok(!calls[2].includes("<p n="), "a comparação não reenvia o texto integral");
		const saved = await page.evaluate(() => window.saved);
		assert.equal(saved.length, 2, "2 fichas guardadas automaticamente");
		assert.match(saved[0], /^Ficha IA · Silva et al\. 2021$/);
		await page.screenshot({ path: path.join(OUT, "ui_janela_fichas.png") });
		console.log("OK coleção e comparar via fichas: 2 fichas criadas e guardadas, comparação só sobre as fichas (" + Math.round(calls[2].length / 1000) + " mil caracteres)");
		await page.close();
	}

	await browser.close();
	if (errors.length) {
		console.error("Erros na página:", errors);
		process.exit(1);
	}
	console.log("\nTodos os testes de interface passaram.");
}

main().catch(e => { console.error("FALHOU:", e); process.exit(1); });
