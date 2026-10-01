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
		const page = await browser.newPage({ viewport, colorScheme: /dark=1/.test(query) ? "dark" : "light" });
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
		await tab(page, "comparar");
		assert.equal(await page.isDisabled('button[data-action="comparar"]'), false, "comparar ativo: abre o seletor de PDFs");
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
		assert.equal(await page.locator(".zia-action-tag").first().textContent(), "Visão geral");
		await page.screenshot({ path: path.join(OUT, dark ? "ui_janela_comparar_escuro.png" : "ui_janela_comparar.png"), fullPage: false });
		// copiar converte citações
		await page.click("text=Copiar");
		const copied = await page.evaluate(() => window.copied);
		assert.ok(copied.includes("(Silva et al., 2021, p.") && !copied.includes("[D1:"));
		// guardar nota
		await page.click("text=Guardar como nota");
		await page.waitForSelector("text=Nota guardada");
		assert.equal(await page.evaluate(() => window.lastHeading), "Comparação: visão geral · Silva et al. 2021, García e Ortega 2023", "título da nota da comparação");
		// uma pergunta abre o seu próprio separador (a comparação fica no dela)
		await page.evaluate(() => { window.MOCK.answer = "Resposta da pergunta [D2:p4]."; });
		await page.fill(".zia-textarea", "E quanto à confiança dos utilizadores?");
		await page.click(".zia-send");
		await page.waitForSelector("text=Resposta da pergunta");
		assert.equal(await page.locator(".zia-conv-tab").count(), 2, "comparação e pergunta em separadores diferentes");
		assert.match(await page.textContent(".zia-conv-tab >> nth=1"), /E quanto à confiança/);
		assert.doesNotMatch(await page.evaluate(() => window.lastPrompt), /<historico>/, "pergunta num separador novo, sem histórico");
		console.log(`OK janela ${dark ? "(escuro)" : ""}: comparação com ${cites} citações, abrir página, copiar, nota, pergunta noutro separador`);
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
		// no painel, o separador Comparar leva à janela grande com os PDFs da conversa
		assert.match(await page.textContent('.zia-tab[data-group="comparar"]'), /↗/);
		await page.click('.zia-tab[data-group="comparar"]');
		assert.equal(await page.evaluate(() => window.openedWindow && window.openedWindow.group), "comparar", "abre a janela em Comparar");
		assert.equal(await page.getAttribute('.zia-tab[data-group="comparar"]', "aria-selected"), "false", "o painel não muda para Comparar");
		// o painel é para o artigo selecionado: sem "+ PDF" (vários PDFs só na janela)
		assert.equal(await page.locator(".zia-chip-add").count(), 0, "sem + PDF no painel");
		assert.doesNotMatch(await page.textContent(".zia-docs"), /D1/, "sem D1 nos chips");

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

	// ---------- Janela: + PDF com seletor e pesquisa ----------
	{
		const page = await open("?mode=window", { width: 820, height: 700 });
		await page.click(".zia-chip-add");
		await page.waitForSelector(".zia-picker-row");
		assert.equal(await page.locator(".zia-picker-row").count(), 2);
		await page.fill(".zia-picker-search", "garcía");
		assert.equal(await page.locator(".zia-picker-row:not([hidden])").count(), 1);
		await page.fill(".zia-picker-search", "xyz");
		assert.equal(await page.locator(".zia-picker-row:not([hidden])").count(), 0, "pesquisa filtra a lista");
		await page.fill(".zia-picker-search", "");
		await page.check(".zia-picker-row >> nth=0 >> input");
		await page.screenshot({ path: path.join(OUT, "ui_janela_seletor.png") });
		await page.click(".zia-picker button:has-text(\"Juntar (1)\")");
		await page.waitForSelector(".zia-chip");
		assert.equal(await page.isHidden(".zia-picker"), true);
		// "i" junto de "Usar fichas" e lista das fichas em Comparar
		await tab(page, "comparar");
		await page.click(".zia-info-btn");
		await page.waitForSelector(".zia-info-panel");
		assert.equal(await page.locator(".zia-fichas-list").count(), 1);
		console.log("OK janela: + PDF com seletor e pesquisa, i das fichas junto de Usar fichas");
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
		assert.equal(await page.evaluate(() => window.lastEngine), undefined, "Enter não envia");
		await page.click(".zia-send");
		await page.waitForSelector("text=Guardar como nota");
		assert.match(await page.evaluate(() => window.lastPrompt), /Indicações adicionais do utilizador: foca a metodologia/);
		assert.equal(await page.locator('button[data-action="resumo"].zia-done').count(), 1, "ação já pedida fica marcada");
		// cada ação tem o seu separador
		await act(page, "pontos");
		await page.waitForFunction(() => document.querySelectorAll(".zia-conv-tab").length === 2 && !document.querySelector(".zia-send.zia-stop"));
		assert.equal(await page.locator(".zia-msg-assistant").count(), 1, "o separador Pontos-chave só tem a sua resposta");
		assert.match(await page.textContent(".zia-conv-tab >> nth=0"), /Resumir/);
		assert.match(await page.textContent(".zia-conv-tab >> nth=1"), /Pontos-chave/);
		await page.screenshot({ path: path.join(OUT, "ui_painel_separadores.png") });
		// escolher uma ação já pedida abre o separador dela, sem repetir o pedido
		const before = await page.evaluate(() => window.lastPrompt);
		await page.click('button[data-action="resumo"]');
		assert.equal(await page.getAttribute(".zia-conv-tab >> nth=0", "aria-selected"), "true", "abre o separador Resumir");
		assert.match(await page.textContent(".zia-status"), /Já pediste/);
		assert.equal(await page.evaluate(() => window.lastPrompt), before, "nada foi enviado");
		await page.click('button[data-action="resumo"]');
		// o título recolhe e abre
		await page.locator(".zia-msg-assistant .zia-msg-head").first().click();
		assert.equal(await page.locator(".zia-msg-assistant.zia-collapsed").count(), 1);
		await page.screenshot({ path: path.join(OUT, "ui_painel_recolhido.png") });
		// histórico: outra sessão do Zotero (memória vazia) recupera os separadores guardados
		assert.equal(await page.evaluate(() => [...window.FILES.keys()].length), 1, "conversas guardadas num ficheiro");
		await page.evaluate(async () => {
			await view.showItem(null);
			ZoteroIA.sessions.clear();
			await view.showItem(window.ITEM_A);
		});
		await page.waitForSelector(".zia-conv-tab");
		assert.equal(await page.locator(".zia-conv-tab").count(), 2, "separadores recuperados");
		assert.match(await page.textContent(".zia-status"), /Conversa anterior recuperada/);
		// histórico antigo (tudo numa conversa) é separado por ação
		await page.evaluate(async () => {
			const L = ZoteroIA.lib;
			const msgs = [
				{ role: "user", display: "Resumir", promptText: "x" }, { role: "assistant", text: "R1 [D1:p1]", actionID: "resumo", actionLabel: "Resumir" },
				{ role: "user", display: "Pontos-chave", promptText: "y" }, { role: "assistant", text: "R2 [D1:p1]", actionID: "pontos", actionLabel: "Pontos-chave" },
				{ role: "user", display: "Qual a amostra?", promptText: "Qual a amostra?" }, { role: "assistant", text: "R3 [D1:p1]" },
			];
			window.splitCount = view._splitByAction(msgs).length;
		});
		assert.equal(await page.evaluate(() => window.splitCount), 3, "histórico antigo: um separador por ação e por pergunta");
		// Nova conversa abre um separador vazio
		await page.click(".zia-footer button:has-text(\"Nova conversa\")");
		assert.equal(await page.locator(".zia-conv-tab").count(), 3);
		assert.equal(await page.locator(".zia-msg-assistant").count(), 0, "conversa nova vazia");
		// fechar um separador pede sempre confirmação
		let asked = 0;
		page.on("dialog", d => { asked++; d.accept(); });
		await page.locator(".zia-conv-close >> nth=0").click();
		assert.equal(asked, 1, "pede confirmação");
		assert.equal(await page.locator(".zia-conv-tab").count(), 2);
		console.log("OK ações: escolher e depois pedir, um separador por ação, ação já pedida abre o seu separador, histórico guardado e antigo separado por ação, fechar com aviso");
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
		await page.click(".zia-custom-btns button:has-text(\"Eliminar\")");
		assert.equal(await page.evaluate(() => ZoteroIA.pref("custom.prompts")), "");
		// escolher a ação mostra "Editar", que abre o formulário com Eliminar
		await page.click(".zia-action-new");
		await page.fill(".zia-custom-name", "Rápida");
		await page.fill(".zia-custom-prompt", "Diz o tema.");
		await page.click(".zia-custom-btns button:has-text(\"Guardar\")");
		await page.click('button[data-action="custom:rapida"]');
		await page.click(".zia-pending button:has-text(\"Editar\")");
		page.once("dialog", d => d.accept());
		await page.click(".zia-custom-btns button:has-text(\"Eliminar\")");
		assert.equal(await page.evaluate(() => ZoteroIA.pref("custom.prompts")), "");
		assert.equal(await page.isHidden(".zia-pending"), true);
		// a resposta mais recente fica em cima e a anterior pode ser guardada como nota já recolhida
		await tab(page, "compreender");
		await page.evaluate(() => { window.MOCK.answer = "Resposta B [D1:p2]."; });
		await act(page, "resumo");
		await page.waitForFunction(() => !document.querySelector(".zia-send.zia-stop") && [...document.querySelectorAll(".zia-msg-assistant")].some(e => /Resposta B/.test(e.textContent)));
		assert.equal(await page.locator(".zia-conv-tab").count(), 2, "Teoria e Resumir em separadores diferentes");
		// recolher a resposta e guardá-la como nota sem a abrir
		await page.locator(".zia-msg-assistant .zia-msg-head").first().click();
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
		// escolhe a coleção numa lista, sem ter de a selecionar antes no Zotero
		assert.equal(await page.locator(".zia-col-row").count(), 2);
		await page.click(".zia-col-row:has-text(\"Tese\")");
		await page.waitForSelector(".zia-chip-col:has-text(\"Coleção: Tese\")");
		await page.waitForSelector("text=Coleção «Tese» selecionada");
		await page.waitForSelector(".zia-chip >> nth=1");
		await tab(page, "comparar");
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

	// ---------- Fichas: botão "i", lista das fichas e erros que se podem retirar ----------
	{
		const page = await open("?mode=section", { width: 420, height: 900 });
		await page.evaluate(() => {
			window.fichaSaved = false;
			ZoteroIA.findFichaNote = () => (window.fichaSaved ? { id: 999 } : null);
			const o = ZoteroIA.saveNote;
			ZoteroIA.saveNote = async a => { if (/^Ficha IA/.test(a.heading)) window.fichaSaved = true; return o(a); };
			window.MOCK.answer = "| Campo | Conteúdo |\n|---|---|\n| Método | Inquérito [D1:p3] |";
		});
		await tab(page, "escrever");
		await page.click(".zia-info-btn");
		await page.waitForSelector(".zia-info-panel");
		assert.equal(await page.locator(".zia-info-fields li").count(), 13, "a explicação lista os campos da ficha");
		await page.screenshot({ path: path.join(OUT, "ui_painel_ficha_info.png") });
		await page.click(".zia-info-close");
		assert.equal(await page.locator(".zia-info-panel").count(), 0);
		// artigo sem ficha: criar e guardar logo como nota
		await page.click(".zia-ficha-missing");
		await page.waitForSelector(".zia-ficha-ok");
		assert.equal(await page.evaluate(() => window.fichaSaved), true, "ficha guardada como nota");
		// erros: um x retira a resposta e a pergunta da conversa
		await page.evaluate(() => { window.MOCK.error = { kind: "busy", message: "Os servidores estão sobrecarregados." }; });
		await tab(page, "compreender");
		await act(page, "resumo");
		await page.waitForSelector(".zia-msg-del");
		const before = await page.locator(".zia-msg").count();
		const errMsg = page.locator(".zia-msg-assistant", { hasText: "sobrecarregados" });
		await errMsg.locator(".zia-msg-del").click();
		await page.waitForSelector("text=Eliminar este erro da conversa?");
		await page.click(".zia-confirm-del button:has-text(\"Eliminar\")");
		assert.equal(await page.locator(".zia-msg").count(), before - 2, "erro e pergunta retirados");
		// resposta com conteúdo: no separador da ficha, cancelar o aviso não apaga
		await page.locator(".zia-conv-label >> nth=0").click();
		const n0 = await page.locator(".zia-msg").count();
		await page.locator(".zia-msg-assistant >> nth=0").locator(".zia-msg-del").click();
		await page.waitForSelector(".zia-confirm-del");
		const cancelled = await page.locator(".zia-confirm-del button:has-text(\"Cancelar\")");
		await cancelled.click();
		assert.equal(await page.locator(".zia-confirm-del").count(), 0, "cancelar não apaga");
		assert.equal(await page.locator(".zia-msg").count(), n0);
		await page.evaluate(() => { window.MOCK.error = null; window.MOCK.answer = "Resumo curto [D1:p1]."; });
		await act(page, "pontos");
		await page.waitForFunction(() => !document.querySelector(".zia-send.zia-stop"));
		await page.evaluate(() => { window.savedNotes = 0; const o = ZoteroIA.saveNote; ZoteroIA.saveNote = async a => { window.savedNotes++; return o(a); }; });
		const n1 = await page.locator(".zia-msg").count();
		await page.locator(".zia-msg-assistant >> nth=0").locator(".zia-msg-del").click();
		await page.waitForSelector("text=Ainda não está guardada como nota");
		await page.click(".zia-confirm-del button:has-text(\"Guardar como nota e eliminar\")");
		await page.waitForFunction(n => document.querySelectorAll(".zia-msg").length === n - 2, n1);
		assert.equal(await page.evaluate(() => window.savedNotes), 1, "guardada como nota antes de eliminar");
		console.log("OK fichas: botão i com os campos, criar ficha a partir da lista e guardar como nota; erros retirados com x");
		await page.close();
	}

	// ---------- Registo sem PDF: o painel fica visível e explica o que fazer ----------
	{
		const page = await open("?mode=section", { width: 420, height: 520 });
		await page.evaluate(async () => {
			const it = { id: 500, key: "NOPDF", libraryID: 1, isRegularItem: () => true, isAttachment: () => false, isPDFAttachment: () => false,
				getAttachments: () => [], getBestAttachment: async () => null, getField: () => "", getCreators: () => [], getDisplayTitle: () => "Livro sem PDF", getNotes: () => [] };
			await view.showItem(it);
		});
		await page.waitForSelector("text=Este registo não tem PDF");
		assert.equal(await page.locator(".zia-nopdf button").count(), 1, "um só botão: abrir a janela");
		assert.equal(await page.locator(".zia-footer button:has-text(\"Comparar coleção\")").count(), 0, "um só link para a janela no rodapé");
		await page.screenshot({ path: path.join(OUT, "ui_painel_sem_pdf.png") });
		await page.click(".zia-nopdf button");
		assert.ok(await page.evaluate(() => !!window.openedWindow), "abre a janela do assistente");
		console.log("OK registo sem PDF: aviso no painel e um botão para abrir a janela");
		await page.close();
	}

	// ---------- Todos os botões do painel: cada um faz alguma coisa e nenhum dá erro ----------
	{
		const snapshot = page => page.evaluate(() => JSON.stringify([
			document.querySelector(".zia-root").innerHTML, window.opened, window.copied || null,
			window.lastEngine || null, window.tagged || null, window.openedWindow ? 1 : 0,
		]));
		const prepare = async () => {
			const page = await open("?mode=section", { width: 420, height: 900 });
			const before = errors.length;
			await page.evaluate(a => { window.MOCK.answer = a + "\nETIQUETAS: chatbots; bibliotecas"; }, pontos);
			await act(page, "pontos");
			await page.waitForSelector("text=Guardar como nota");
			await page.waitForFunction(() => !document.querySelector(".zia-typing"));
			return { page, before };
		};
		const { page: p0 } = await prepare();
		const labels = await p0.evaluate(() => [...document.querySelectorAll(".zia-root button")]
			.filter(b => b.offsetParent && !b.disabled)
			// o separador já aberto não tem nada a fazer
			.map(b => b.getAttribute("aria-selected") === "true" ? null : b)
			.map(b => !b ? "(separador aberto)" : (b.dataset.action ? "ação " + b.dataset.action : b.dataset.group ? "separador " + b.dataset.group : (b.title || b.textContent).trim()).slice(0, 40)));
		await p0.close();
		const dead = [];
		for (let i = 0; i < labels.length; i++) {
			if (labels[i] === "(separador aberto)") continue;
			const { page, before } = await prepare();
			const s0 = await snapshot(page);
			await page.evaluate(i => {
				const bs = [...document.querySelectorAll(".zia-root button")].filter(b => b.offsetParent && !b.disabled);
				bs[i].click();
			}, i);
			let changed = false;
			for (let t = 0; t < 15 && !changed; t++) {
				await page.waitForTimeout(100);
				changed = (await snapshot(page)) !== s0;
			}
			if (!changed) dead.push(labels[i]);
			if (errors.length > before) dead.push(labels[i] + " (erro: " + errors.slice(before).join(" | ") + ")");
			await page.close();
		}
		assert.equal(dead.length, 0, "botões sem efeito ou com erro: " + dead.join(", "));
		console.log(`OK todos os ${labels.length - 1} botões do painel respondem sem erros: ${labels.filter(l => l[0] !== "(").join(", ")}`);
	}

	await browser.close();
	if (errors.length) {
		console.error("Erros na página:", errors);
		process.exit(1);
	}
	console.log("\nTodos os testes de interface passaram.");
}

main().catch(e => { console.error("FALHOU:", e); process.exit(1); });
