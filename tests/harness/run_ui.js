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
	// Lista própria da janela: abre e escolhe
	const dd = async (page, sel, value) => {
		await page.click(`${sel} .zia-dd-btn`);
		await page.click(`${sel} .zia-dd-item[data-value="${value}"]`);
	};
	// Janela: juntar os dois PDFs pelo seletor "+ Artigos"
	const addAll = async page => {
		await page.click(".zia-bar-tools button:has-text(\"+ Artigos\")");
		await page.waitForSelector(".zia-picker-row");
		await page.check(".zia-picker-all input");
		await page.uncheck(".zia-picker-row:has-text(\"Outra pasta\") >> input");
		await page.click(".zia-picker button.zia-btn-primary");
	};
	// Escolher uma ação e depois pedir (clicar numa ação já não envia logo)
	// Na janela, as comparações estão dentro de "Comparar artigos" (modelos)
	const COMPARE = ["comparar", "cmp_metodos", "cmp_resultados", "cmp_conceitos", "cmp_tabela"];
	const act = async (page, id) => {
		if (COMPARE.includes(id) && await page.locator('[data-card="compare"]').count()) {
			await page.click('[data-card="compare"]');
			if (id !== "comparar") await page.click(`.zia-preset[data-action="${id}"]`);
		}
		else await page.click(`button[data-action="${id}"]`);
		// Painel Avançado: um clique numa ação envia logo
		if (!(await page.locator(".zia-mode-section:not(.zia-simple)").count())) await page.click(".zia-send");
	};

	// ---------- Janela: comparar 2 PDFs ----------
	for (const dark of [false, true]) {
		const page = await open("?mode=window" + (dark ? "&dark=1" : ""), { width: 820, height: 900 });
		await page.evaluate(a => { window.MOCK.answer = a; }, comparar);
		assert.equal(await page.isHidden(".zia-tabs"), true, "janela: só Comparar, sem separadores");
		assert.equal(await page.isDisabled('[data-card="compare"]'), false, "comparar ativo: abre o seletor de PDFs");
		assert.deepEqual(await page.$$eval(".zia-win-grid .zia-simple-label", ls => ls.map(l => l.textContent)),
			["Comparar artigos", "Perguntar à coleção", "Mapa de temas", "Revisão de literatura", "Triagem"], "5 botões grandes");
		await addAll(page);
		await page.waitForSelector(".zia-chip >> nth=1");
		assert.equal(await page.isDisabled('[data-card="compare"]'), false);
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
		// sem pergunta livre na janela: sem escolher nada, não envia
		await page.evaluate(() => { if (view.selectedAction) view.selectAction(view.selectedAction); });
		assert.equal(await page.isHidden(".zia-input"), true, "sem escolher nada, não há caixa de texto nem Enviar");
		// Perguntar à coleção: resposta de cada artigo, barra e síntese, noutro separador
		await page.evaluate(() => { window.MOCK.answer = "## Resposta de cada artigo\n| Artigo | Resposta | Evidência |\n|---|---|---|\n| D1 | Sim | Confiança alta [D1:p2] |\n| D2 | Não aborda | Não trata [D2:p1] |\n\n## Síntese\nSó um artigo trata a confiança [D1:p2].\n\nRESPOSTA D1: SIM\nRESPOSTA D2: NAO ABORDA"; });
		await page.click('button[data-action="pergunta"]');
		assert.match(await page.getAttribute(".zia-textarea", "placeholder"), /Escreve a tua pergunta/);
		await page.fill(".zia-textarea", "E quanto à confiança dos utilizadores?");
		await page.click(".zia-send");
		await page.waitForSelector(".zia-stances");
		assert.match(await page.evaluate(() => window.lastPrompt), /E quanto à confiança/);
		assert.equal(await page.textContent(".zia-stance-legend"), "Sim 1 · Não aborda 1");
		assert.equal(await page.locator("text=RESPOSTA D1").count(), 0, "as linhas técnicas não aparecem");
		assert.equal(await page.locator(".zia-conv-tab").count(), 2, "comparação e pergunta em separadores diferentes");
		console.log(`OK janela ${dark ? "(escuro)" : ""}: 5 botões, comparação com ${cites} citações, abrir página, copiar, nota, sem pergunta livre, Perguntar à coleção com barra`);
		await page.close();
	}

	// ---------- Painel lateral: sugestões, erro de limite e repetição com Gemini ----------
	{
		const page = await open("?mode=section", { width: 420, height: 900 });
		assert.equal(await page.locator(".zia-chip").count(), 0, "um só PDF no registo: sem chip do artigo no Avançado");
		assert.equal(await page.isVisible(".zia-engine"), false, "no painel o motor escolhe-se nas definições");
		assert.equal(await page.locator(".zia-tab-add").count(), 0, "sem botão +");
		assert.equal(await page.locator('.zia-tab[data-group="meus"]').count(), 1, "separador Os meus sempre visível");
		assert.equal(await page.locator(".zia-suggestion").count(), 0, "sem perguntas por baixo da caixa");
		assert.equal(await page.locator(".zia-footer").count(), 0, "sem rodapé (nem Nova conversa)");
		assert.equal(await page.locator('button[data-action="resumo"] .zia-ic svg').count(), 1, "ação com ícone");
		await page.screenshot({ path: path.join(OUT, "ui_painel_vazio.png") });
		// as perguntas de exemplo estão em Pers.
		await tab(page, "meus");
		assert.equal(await page.locator(".zia-examples .zia-suggestion").count(), 4, "perguntas de exemplo em Pers.");
		await tab(page, "compreender");
		// no painel, Comparar já não é separador: o atalho do rodapé leva à janela grande com os PDFs da conversa
		assert.equal(await page.locator('.zia-tab[data-group="comparar"]').count(), 0, "sem separador Comparar no painel");
		// PT/EN e definições numa linha (sem título repetido), e a faixa "Vários artigos" abre a janela
		assert.equal((await page.textContent(".zia-top")).replace(/\s/g, ""), "PTEN", "sem título repetido");
		assert.equal(await page.locator(".zia-top .zia-btn-icon").count(), 1, "definições na linha do título");
		await page.click(".zia-multi-strip");
		assert.ok(await page.evaluate(() => !!window.openedWindow), "a faixa abre a janela do assistente");
		// PT/EN no painel muda a língua de tudo
		await page.click('.zia-langswitch [data-lang="en"]');
		await page.waitForSelector(".zia-multi-text b:has-text(\"Several articles\")");
		await page.click('.zia-langswitch [data-lang="pt-PT"]');
		await page.waitForSelector(".zia-multi-text b:has-text(\"Vários artigos\")");
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

	// ---------- Janela: + Artigos com seletor, pasta e pesquisa ----------
	{
		const page = await open("?mode=window", { width: 820, height: 700 });
		assert.equal(await page.locator("button:has-text(\"+ Coleção\")").count(), 0, "um só botão para juntar artigos");
		await page.click(".zia-bar-tools button:has-text(\"+ Artigos\")");
		await page.waitForSelector(".zia-picker-row");
		// abre em toda a biblioteca (3 artigos), sem a opção "Pasta aberta"
		assert.equal(await page.locator(".zia-picker-row").count(), 3, "toda a biblioteca");
		assert.equal(await page.locator(".zia-picker-segbtn").count(), 2, "Toda a biblioteca e Coleção");
		assert.equal(await page.locator(".zia-picker-seg").textContent().then(t => /Pasta aberta/.test(t)), false, "sem Pasta aberta");
		assert.equal(await page.locator(".zia-picker-row .zia-picker-ref").first().isVisible(), true, "autor e ano a negrito, título por baixo");
		// Marcar todos: uma caixa por cima do primeiro artigo
		assert.match(await page.textContent(".zia-picker-all"), /Marcar todos \(3\)/);
		await page.check(".zia-picker-all input");
		assert.equal(await page.locator(".zia-picker-row input:checked").count(), 3, "marca todos");
		assert.match(await page.textContent(".zia-picker button.zia-btn-primary"), /Juntar \(3\)/);
		await page.uncheck(".zia-picker-all input");
		assert.equal(await page.locator(".zia-picker-row input:checked").count(), 0, "desmarca todos");
		// a pesquisa conta: só marca os artigos que aparecem; a caixa fica mista com só alguns
		await page.fill(".zia-picker-search", "garcía");
		assert.equal(await page.locator(".zia-picker-row:not([hidden])").count(), 1);
		await page.check(".zia-picker-all input");
		assert.equal(await page.locator(".zia-picker-row input:checked").count(), 1);
		await page.fill(".zia-picker-search", "");
		assert.equal(await page.$eval(".zia-picker-all input", el => el.indeterminate), true, "caixa mista");
		await page.uncheck(".zia-picker-row:has-text(\"García\") >> input");
		await page.fill(".zia-picker-search", "xyz");
		assert.equal(await page.locator(".zia-picker-row:not([hidden])").count(), 0, "pesquisa filtra a lista");
		await page.fill(".zia-picker-search", "");
		// coleção: escolher uma coleção vazia não mostra "Juntar a coleção toda", a escolha de antes fica
		await page.check(".zia-picker-row:has-text(\"Outra pasta\") >> input");
		await page.click(".zia-picker-segbtn:has-text(\"Coleção\")");
		await dd(page, ".zia-picker-colsel", "8");
		await page.waitForSelector(".zia-picker-none");
		assert.equal(await page.isHidden(".zia-picker-whole"), true, "coleção vazia: sem Juntar a coleção toda");
		assert.match(await page.textContent(".zia-picker button.zia-btn-primary"), /Juntar \(1\)/, "a escolha de outra coleção fica");
		await page.click(".zia-picker-segbtn:has-text(\"Toda a biblioteca\")");
		await page.waitForSelector(".zia-picker-row:has-text(\"Outra pasta\")");
		assert.equal(await page.locator(".zia-picker-row input:checked").count(), 1, "o artigo marcado continua marcado");
		await page.uncheck(".zia-picker-row:has-text(\"Outra pasta\") >> input");
		// ordenar por título
		await dd(page, ".zia-picker-sortsel", "title");
		assert.match(await page.textContent(".zia-picker-row >> nth=0"), /Assistentes|Library|Outra/);
		await page.check(".zia-picker-row >> nth=0 >> input");
		await page.screenshot({ path: path.join(OUT, "ui_janela_seletor.png") });
		await page.click(".zia-picker button:has-text(\"Juntar (1)\")");
		await page.waitForSelector(".zia-chip");
		assert.equal(await page.isHidden(".zia-picker"), true);
		// "i" junto de "Usar fichas" e lista das fichas em Comparar
		await page.click('[data-card="compare"]');
		await page.click(".zia-info-btn:not(.zia-triagem-info)");
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
				return { gear: inside(".zia-top .zia-btn-icon"), strip: inside(".zia-multi-strip"), send: inside(".zia-send") };
			});
			assert.ok(r.gear && r.strip && r.send, `largura ${w}: definições, Vários artigos e Enviar visíveis ${JSON.stringify(r)}`);
		}
		await page.evaluate(() => { document.querySelector(".pane").style.width = "min-content"; });
		const minW = await page.evaluate(() => document.querySelector(".pane").getBoundingClientRect().width);
		assert.ok(minW < 200, `o painel não pode exigir largura mínima grande (${minW}px)`);
		console.log("OK painel estreito: definições, Vários artigos e Enviar sempre visíveis, sem forçar a largura do Zotero");
		await page.close();
	}

	// ---------- Sugestão de pergunta e língua das respostas ----------
	{
		const page = await open("?mode=section&lang=en", { width: 420, height: 700 });
		await page.evaluate(() => { window.MOCK.answer = "The main finding is X [D1:p3]."; });
		await tab(page, "meus");
		await page.locator(".zia-suggestion").first().click();
		assert.equal(await page.evaluate(() => window.lastEngine), undefined, "a sugestão só preenche a caixa");
		await page.click(".zia-send");
		await page.waitForSelector("text=The main finding");
		// a antiga preferência "língua das respostas" já não conta: a resposta segue a língua da app
		assert.match(await page.evaluate(() => window.lastSystem), /português europeu/);
		assert.match(await page.locator(".zia-msg-user").first().textContent(), /pergunta de investigação/);
		console.log("OK sugestão de pergunta enviada, respostas na língua da app");
		await page.close();
	}

	// ---------- Interface em inglês ----------
	{
		const page = await open("?mode=section&ui=en", { width: 420, height: 800 });
		assert.equal(await page.textContent('button[data-action="resumo"]'), "Summarise", "botão com verbo");
		assert.equal(await page.textContent('.zia-tab[data-group="compreender"]'), "Understand");
		assert.equal(await page.textContent(".zia-send"), "Send ➤");
		await tab(page, "meus");
		assert.match(await page.locator(".zia-suggestion").first().textContent(), /research question/);
		await tab(page, "compreender");
		await page.evaluate(() => { window.MOCK.answer = "The main finding is X [D1:p3]."; });
		await act(page, "resumo");
		await page.waitForSelector("text=Save as note");
		assert.match(await page.evaluate(() => window.lastSystem), /inglês/, "respostas em inglês por omissão");
		await page.screenshot({ path: path.join(OUT, "ui_painel_ingles.png") });
		console.log("OK interface em inglês: botões, separadores, sugestões e respostas em inglês");
		await page.close();
	}

	// ---------- Mudar de língua muda também o nome das respostas já feitas ----------
	{
		const page = await open("?mode=section", { width: 420, height: 800 });
		await page.evaluate(() => { window.MOCK.answer = "O resultado principal é X [D1:p3]."; });
		await act(page, "resumo");
		await page.waitForSelector("text=Guardar como nota");
		assert.equal(await page.locator(".zia-action-tag").first().textContent(), "Resumo");
		await page.evaluate(() => { window.view.core.setPref("ui.lang", "en"); window.view._onPrefsChanged("ui.lang"); });
		assert.equal(await page.locator(".zia-action-tag").first().textContent(), "Summary", "o título da resposta passa para inglês");
		await page.evaluate(() => { window.view.core.setPref("ui.lang", "pt-PT"); window.view._onPrefsChanged("ui.lang"); });
		assert.equal(await page.locator(".zia-action-tag").first().textContent(), "Resumo");
		console.log("OK mudar de língua muda o nome das respostas já feitas (Resumo / Summary)");
		await page.close();
	}

	// ---------- Modo Simples (licenciatura) ----------
	{
		const page = await open("?mode=section&uimode=simple", { width: 300, height: 900 });
		const pressed = () => page.$$eval(".zia-modeswitch .zia-mode-btn", bs => bs.map(b => b.dataset.uimode + ":" + b.getAttribute("aria-pressed")));
		assert.deepEqual(await pressed(), ["simple:true", "advanced:false"]);
		assert.ok(!(await page.isVisible(".zia-tabs")), "sem separadores no simples");
		assert.ok(!(await page.isVisible(".zia-engine")), "sem lista de motores no simples");
		const labels = await page.$$eval(".zia-simple-btn .zia-simple-label", ls => ls.map(l => l.textContent));
		assert.deepEqual(labels, ["Resumir", "Explicação simples", "Conceitos-chave", "Mapa mental", "Testar o que percebi", "Relevância para o meu tema"]);
		const over = await page.$$eval(".zia-simple-btn", (bs) => bs.filter(b => b.scrollHeight > b.clientHeight + 1 || b.getBoundingClientRect().right > document.querySelector(".zia-root").getBoundingClientRect().right + 1).length);
		assert.equal(over, 0, "botões grandes inteiros e dentro do painel estreito");
		await page.screenshot({ path: path.join(OUT, "ui_painel_simples.png"), fullPage: true });
		assert.equal(await page.getAttribute(".zia-textarea", "placeholder"), "Ou pergunta algo sobre o artigo…");

		// um clique envia logo, sem passar por Enviar
		await page.evaluate(() => { window.MOCK.answer = "O estudo conclui que X melhora Y [D1:p3]."; window.engineCalls = 0; });
		await page.click('.zia-simple-btn[data-action="resumo"]');
		await page.waitForSelector(".zia-check");
		assert.equal(await page.evaluate(() => window.engineCalls), 1, "um clique, um pedido");
		assert.match(await page.evaluate(() => window.lastPrompt), /resumo estruturado/i);
		assert.equal((await page.textContent(".zia-check")).trim(), "✓ Confirmado no PDF", "verificação curta no simples");
		assert.equal(await page.locator(".zia-msg-meta").count(), 0, "sem motor e modelo por baixo da resposta");
		assert.equal(await page.locator("text=Repetir com").count(), 0, "sem Repetir com no simples");
		assert.ok(await page.isVisible("text=Guardar como nota"), "guardar como nota continua");
		assert.equal(await page.textContent(".zia-action-tag"), "Resumo");
		assert.ok(await page.$eval('.zia-simple-btn[data-action="resumo"]', b => b.classList.contains("zia-done")), "visto no botão já pedido");

		// voltar a carregar mostra a resposta que existe, sem novo pedido
		await page.click('.zia-simple-btn[data-action="resumo"]');
		await page.waitForTimeout(300);
		assert.equal(await page.evaluate(() => window.engineCalls), 1, "não repete o pedido");
		assert.ok(!(await page.isVisible(".zia-pending")), "nada fica escolhido à espera de Enviar");

		// ação nova: perguntas de estudo
		await page.evaluate(() => { window.MOCK.answer = "**Pergunta 1.** O que mede o estudo?\n*Resposta:* Mede X [D1:p2]."; });
		await page.click('.zia-simple-btn[data-action="estudo"]');
		await page.waitForFunction(() => window.engineCalls === 2);
		await page.waitForSelector("text=Pergunta 1.");
		assert.match(await page.evaluate(() => window.lastPrompt), /perguntas de estudo/);

		// mapa mental: a lista encaixada aparece como árvore
		await page.evaluate(() => { window.MOCK.answer = "- Estudo sobre X\n  - Problema\n    - Falta de dados sobre X [D1:p2]\n  - Método\n    - Inquérito a 120 pessoas [D1:p4]\n    - Entrevistas a 12 docentes [D1:p5]\n  - Resultados\n    - X melhora Y [D1:p7]\n"; });
		await page.click('.zia-simple-btn[data-action="mapa"]');
		await page.waitForFunction(() => window.engineCalls === 3);
		await page.waitForSelector(".zia-mm-m1 li li li");
		await page.waitForFunction(() => !document.querySelector(".zia-typing"));
		assert.match(await page.evaluate(() => window.lastPrompt), /mapa mental/);
		// só Ramos: raiz, 3 ramos com cor, 4 ideias, só a página nas citações (clicáveis)
		assert.equal(await page.locator(".zia-viewswitch").count(), 0, "sem Diagrama");
		assert.equal((await page.textContent(".zia-mm-m1 > ul > li > .zia-mm-node")).trim(), "Estudo sobre X");
		assert.equal(await page.locator(".zia-mm-m1 > ul > li > ul > li").count(), 3);
		assert.equal(await page.locator(".zia-mm-m1 li li li").count(), 4);
		assert.match(await page.textContent(".zia-mm-m1 .zia-cite"), /^p\. \d+$/);
		await page.locator(".zia-mindmap").screenshot({ path: path.join(OUT, "ui_mapa_mental.png") });
		await page.locator(".zia-mm-m1 .zia-cite >> nth=0").click();
		assert.ok((await page.evaluate(() => window.opened)).some(u => /SILVAPDF#2/.test(u)), "a página abre o PDF");
		// clicar num ramo esconde as suas ideias e volta a mostrar
		await page.locator(".zia-mm-fold >> nth=1").click();
		assert.equal(await page.locator(".zia-mm-m1 li li li:visible").count(), 2);
		await page.locator(".zia-mm-fold >> nth=1").click();
		assert.equal(await page.locator(".zia-mm-m1 li li li:visible").count(), 4);
		await page.evaluate(() => { window.engineCalls = 2; });

		// relevância: precisa do tema escrito na caixa, e pode repetir-se com outro tema
		await page.click('.zia-simple-btn[data-action="relevancia"]');
		await page.waitForSelector("text=Escreve primeiro o teu tema");
		assert.equal(await page.evaluate(() => window.engineCalls), 2, "sem tema, nada é enviado");
		await page.evaluate(() => { window.MOCK.answer = "## Relevância: Alta\nO estudo trata X [D1:p2]."; });
		await page.fill(".zia-textarea", "literacia digital no ensino superior");
		await page.click('.zia-simple-btn[data-action="relevancia"]');
		await page.waitForFunction(() => window.engineCalls === 3);
		await page.waitForSelector("text=Relevância: Alta");
		assert.match(await page.evaluate(() => window.lastPrompt), /literacia digital no ensino superior/);
		assert.match(await page.evaluate(() => window.lastPrompt), /tema do seu trabalho/);
		assert.equal(await page.inputValue(".zia-textarea"), "", "a caixa fica limpa");
		assert.ok(await page.isVisible('.zia-action-tag:has-text("Relevância para o meu tema")'));
		await page.waitForFunction(() => !document.querySelector(".zia-typing"));
		await page.evaluate(() => { window.engineCalls = 2; });

		// pergunta livre continua a funcionar
		await page.evaluate(() => { window.MOCK.answer = "A amostra tem 120 pessoas [D1:p4]."; });
		await page.fill(".zia-textarea", "Qual é a amostra?");
		await page.click(".zia-send");
		await page.waitForFunction(() => window.engineCalls === 3);
		await page.waitForSelector("text=A amostra tem 120");

		// passar a Avançado mostra tudo, mantendo as respostas
		await page.click('.zia-mode-btn[data-uimode="advanced"]');
		assert.deepEqual(await pressed(), ["simple:false", "advanced:true"]);
		assert.equal(await page.evaluate(() => window.view.core.pref("ui.mode")), "advanced");
		assert.ok(await page.isVisible(".zia-tabs"));
		assert.equal(await page.isVisible(".zia-engine"), false, "no Avançado também não há lista do motor");
		assert.ok(await page.isVisible('button[data-action="critica"], .zia-tab[data-group="avaliar"]'));
		assert.equal(await page.locator(".zia-simple-grid").count(), 0);
		assert.ok(await page.isVisible("text=A amostra tem 120"), "a conversa mantém-se ao mudar de modo");
		assert.ok((await page.locator(".zia-msg-meta").count()) > 0, "no avançado volta o motor por baixo da resposta");
		await page.click('.zia-mode-btn[data-uimode="simple"]');
		assert.ok(await page.isVisible(".zia-simple-grid"));
		assert.equal(await page.evaluate(() => window.view.core.pref("ui.mode")), "simple");
		console.log("OK modo simples: 6 botões grandes (com mapa mental e relevância para o tema) que enviam logo, sem motor, separadores nem Repetir, verificação curta, troca para avançado e volta");
		await page.close();
	}
	{
		const page = await open("?mode=section&uimode=simple&ui=en", { width: 300, height: 800 });
		const labels = await page.$$eval(".zia-simple-btn .zia-simple-label", ls => ls.map(l => l.textContent));
		assert.deepEqual(labels, ["Summarise", "Plain-language summary", "Key concepts", "Mind map", "Test my understanding", "Relevance to my topic"]);
		assert.deepEqual(await page.$$eval(".zia-modeswitch .zia-mode-btn", bs => bs.map(b => b.textContent)), ["Simple", "Advanced"]);
		await page.close();
		const win = await open("?mode=window&uimode=simple", { width: 820, height: 800 });
		assert.equal(await win.locator(".zia-modeswitch").count(), 0, "a janela é sempre avançada");
		assert.equal(await win.locator(".zia-simple-grid:not(.zia-win-grid)").count(), 0);
		assert.ok(await win.isVisible(".zia-engine"));
		await win.close();
		console.log("OK modo simples em inglês, e a janela grande fica sempre avançada");
	}
	{
		// mudar o modo nas definições a meio de uma resposta: o painel muda quando a resposta termina
		const page = await open("?mode=section&uimode=simple", { width: 360, height: 800 });
		await page.evaluate(() => { window.MOCK.answer = "Resposta longa sobre o estudo, com muitas palavras para demorar um pouco [D1:p3]."; window.MOCK.delayMs = 40; });
		await page.click('.zia-simple-btn[data-action="conceitos"]');
		await page.waitForSelector(".zia-typing");
		assert.ok(await page.$eval('.zia-simple-btn[data-action="resumo"]', b => b.disabled), "botões parados enquanto responde");
		await page.evaluate(() => { window.view.core.setPref("ui.mode", "advanced"); window.view._onPrefsChanged("ui.mode"); });
		assert.ok(await page.isVisible(".zia-simple-grid"), "não mexe na interface a meio da resposta");
		await page.waitForFunction(() => !document.querySelector(".zia-typing") && !!document.querySelector(".zia-tabs:not([hidden])"));
		assert.ok(await page.isVisible("text=Resposta longa sobre o estudo"), "a resposta fica");
		await page.close();

		// sem motor configurado: o cartão de configuração aparece também no simples e nada é enviado
		const p2 = await open("?mode=section&uimode=simple&setup=1", { width: 360, height: 800 });
		await p2.waitForSelector("text=Liga o assistente a uma IA");
		await p2.click('.zia-simple-btn[data-action="resumo"]');
		await p2.waitForTimeout(300);
		assert.equal(await p2.evaluate(() => window.lastEngine), undefined, "sem motor não envia nada");
		assert.ok(await p2.isVisible(".zia-setup"));
		await p2.close();
		console.log("OK modo simples: mudar nas definições a meio de uma resposta, e configuração inicial sem motor");
	}

	// ---------- Referências-chave (Investigação futura): a lista de referências não é cortada ----------
	{
		const page = await open("?mode=section", { width: 420, height: 800 });
		assert.equal(await page.textContent('.zia-tab[data-group="investigar"]'), "Investigar");
		await page.click('.zia-tab[data-group="investigar"]');
		assert.ok(await page.isVisible('button[data-action="referencias"]'));
		await page.evaluate(() => { window.MOCK.answer = "1. Silva (2020). Teoria X. Usada para definir X [D1:p2]."; });
		await act(page, "referencias");
		await page.waitForSelector("text=Teoria X");
		const p = await page.evaluate(() => window.lastPrompt);
		assert.match(p, /fontes citadas/);
		assert.doesNotMatch(p, /Lista de referências bibliográficas omitida/, "as referências vão no pedido");
		// relevância no avançado: a caixa diz o que escrever, sem tema não envia
		await page.click('.zia-tab[data-group="avaliar"]');
		await page.click('button[data-action="relevancia"]');
		assert.match(await page.getAttribute(".zia-textarea", "placeholder"), /Escreve primeiro o teu tema/);
		const before = await page.evaluate(() => window.lastPrompt);
		await page.click(".zia-send");
		await page.waitForSelector("text=Escreve primeiro o teu tema");
		assert.equal(await page.evaluate(() => window.lastPrompt), before, "sem tema não envia");
		await page.evaluate(() => { window.MOCK.answer = "## Relevância: Média\nTrata X em parte [D1:p3]."; });
		await page.fill(".zia-textarea", "ensino a distância");
		await page.click(".zia-send");
		await page.waitForSelector("text=Relevância: Média");
		assert.match(await page.evaluate(() => window.lastPrompt), /ensino a distância/);
		await page.waitForFunction(() => !document.querySelector(".zia-send.zia-stop"));
		await page.click('.zia-tab[data-group="compreender"]');
		assert.equal(await page.textContent('button[data-action="resumo"]'), "Resumir", "botão com verbo");
		assert.equal(await page.textContent('button[data-action="pontos"]'), "Ideias principais");
		assert.equal(await page.locator('button[data-action="revisao"]').count(), 0, "revisão de literatura só em Comparar");
		await page.close();
		console.log("OK Referências-chave com a lista de referências, relevância no avançado, Investigação futura, Resumir, Ideias principais");
	}

	// ---------- Registo e PDF partilham a mesma conversa ----------
	{
		const page = await open("?mode=section", { width: 420, height: 800 });
		await page.evaluate(() => { window.MOCK.answer = "Resumo do artigo [D1:p1]."; });
		await act(page, "resumo");
		await page.waitForSelector("text=Resumo do artigo");
		const same = await page.evaluate(async () => {
			const parent = Zotero.Items.get(1), pdf = Zotero.Items.get(2);
			const owner = await window.view.core.conversationItem(pdf);
			await window.view.showItem(pdf);
			return owner === parent && window.view.sessionKey === "item:1";
		});
		assert.ok(same, "o PDF usa a conversa do registo");
		assert.ok(await page.isVisible("text=Resumo do artigo"), "a resposta continua ao selecionar o PDF");
		await page.close();
		console.log("OK registo e PDF partilham a mesma conversa");
	}

	// ---------- Explicar os meus destaques (só com destaques) e exportar para o Anki ----------
	{
		let page = await open("?mode=section", { width: 420, height: 800 });
		assert.equal(await page.locator('button[data-action="destaques"]').count(), 0, "sem destaques, sem botão");
		await page.close();
		page = await open("?mode=section&hl=1", { width: 420, height: 900 });
		await page.evaluate(() => { window.MOCK.answer = "\"Os assistentes reduzem o tempo de resposta\" [D1:p2]: quer dizer que respondem mais depressa."; });
		await act(page, "destaques");
		await page.waitForSelector("text=quer dizer que respondem");
		const p = await page.evaluate(() => window.lastPrompt);
		assert.match(p, /destacou excertos/);
		assert.match(p, /Os assistentes reduzem o tempo de resposta/, "os destaques vão no pedido");
		// Anki a partir do Testar o que percebi
		await page.evaluate(() => { window.MOCK.answer = "**Pergunta 1.** O que mede o estudo?\n*Resposta:* Mede o tempo de resposta [D1:p2].\n\n**Pergunta 2.** Com que amostra?\n*Resposta:* 120 pessoas [D1:p4]."; });
		await act(page, "estudo");
		await page.waitForSelector("text=Exportar para o Anki");
		await page.waitForFunction(() => !document.querySelector(".zia-typing"));
		await page.click("text=Exportar para o Anki");
		await page.waitForSelector("text=2 cartões guardados");
		const csv = await page.evaluate(() => window.lastCSV.csv);
		assert.match(csv, /^#separator:Comma/);
		assert.match(csv, /"O que mede o estudo\?","Mede o tempo de resposta \(Silva et al\., 2021, p\. 2\)\."/);
		await page.close();
		page = await open("?mode=section&uimode=simple&hl=1", { width: 360, height: 900 });
		assert.equal(await page.locator('.zia-simple-btn[data-action="destaques"]').count(), 0, "no simples não aparece (só no Avançado)");
		await page.close();
		console.log("OK Explicar os meus destaques só com destaques (os destaques vão no pedido) e exportação para o Anki");
	}

	// ---------- Janela: tabela com as minhas colunas e Mapa de temas (árvore e grafo) ----------
	{
		const page = await open("?mode=window", { width: 820, height: 1000 });
		await addAll(page);
		await page.waitForSelector(".zia-chip >> nth=1");
		// as minhas colunas: sem colunas não envia
		await page.click('[data-card="compare"]');
		assert.deepEqual(await page.$$eval(".zia-preset", ps => ps.map(p => p.textContent)), ["Visão geral", "Métodos", "Resultados", "Conceitos", "As minhas colunas"]);
		await page.click('.zia-preset[data-action="cmp_tabela"]');
		const before = await page.evaluate(() => window.lastPrompt);
		await page.click(".zia-send");
		await page.waitForSelector("text=Escreve as colunas na caixa");
		assert.equal(await page.evaluate(() => window.lastPrompt), before);
		await page.evaluate(() => { window.MOCK.answer = "| Documento | País | Amostra |\n|---|---|---|\n| D1 | Portugal [D1:p1] | 120 [D1:p2] |\n| D2 | Espanha [D2:p1] | Não reportado |"; });
		await page.fill(".zia-textarea", "País. Amostra");
		await page.click(".zia-send");
		await page.waitForSelector("text=Exportar tabela (CSV)");
		assert.match(await page.evaluate(() => window.lastPrompt), /colunas que o utilizador escreveu[\s\S]*País\. Amostra/);
		await page.waitForFunction(() => !document.querySelector(".zia-send.zia-stop"));
		// mapa de temas: só título, resumo e palavras-chave, artigo esquecido avisado
		await page.evaluate(() => { window.MOCK.answer = "- Bibliotecas e IA\n  - Assistentes conversacionais (1)\n    - Chatbots em bibliotecas [D1]\n  - Avaliação (1)\n    - Satisfação dos utilizadores [D1]\n"; });
		await page.click('button[data-action="temas"]');
		assert.match(await page.getAttribute(".zia-textarea", "placeholder"), /Nada a escrever/);
		await page.click(".zia-send");
		await page.waitForSelector("svg.zia-graph");
		await page.waitForFunction(() => !document.querySelector(".zia-send.zia-stop"));
		const mp = await page.evaluate(() => window.lastPrompt);
		assert.match(mp, /tipo="ficha"/, "envia só os metadados");
		assert.ok(!mp.includes("<p n="), "não envia o texto dos PDFs");
		assert.ok(await page.isVisible("text=Artigos que ficaram fora do mapa"), "avisa o artigo que ficou de fora");
		assert.ok(await page.isVisible("text=Agrupamento sugerido pela IA"));
		// constelação (vista por omissão): um artigo em dois temas é um só nó, legenda, destaque e cartão
		assert.equal(await page.locator(".zia-g-theme").count(), 2);
		assert.equal(await page.locator(".zia-g-doc").count(), 1, "o mesmo artigo em dois temas é um só nó");
		assert.equal(await page.locator(".zia-g-edge").count(), 2);
		assert.equal(await page.locator(".zia-g-legend .zia-g-chip").count(), 2);
		await page.locator(".zia-g-legend .zia-g-chip >> nth=0").click();
		assert.equal(await page.locator("svg.zia-graph.zia-g-focus").count(), 1, "clicar num tema destaca-o");
		await page.locator(".zia-g-doc circle").hover();
		assert.ok(await page.isVisible(".zia-g-tip"), "cartão com o título ao passar o rato");
		await page.screenshot({ path: path.join(OUT, "ui_janela_mapa_temas_grafo.png") });
		await page.locator(".zia-g-doc circle").click();
		assert.ok((await page.evaluate(() => window.opened)).some(u => /SILVAPDF/.test(u)), "clicar no artigo abre o PDF");
		await page.screenshot({ path: path.join(OUT, "ui_janela_mapa_temas_grafo.png") });
		await page.click('.zia-viewswitch [data-view="tree"]');
		assert.ok(await page.isVisible(".zia-mindmap li li li"));
		await page.close();
		console.log("OK janela: As minhas colunas (pede colunas), Mapa de temas só com metadados, aviso de artigos de fora, árvore e grafo");
	}

	// ---------- Buy me a coffee no painel e na janela ----------
	for (const mode of ["section", "window"]) {
		const page = await open(`?mode=${mode}`, { width: mode === "section" ? 300 : 820, height: 800 });
		assert.equal(await page.locator(".zia-coffee").count(), 0, "escondido por omissão: " + mode);
		await page.evaluate(() => { window.view.core.SUPPORT_ENABLED = true; window.view._rebuild(); });
		const btn = page.locator(".zia-footer .zia-coffee");
		assert.equal(await btn.count(), 1, "botão no rodapé: " + mode);
		assert.equal((await btn.textContent()).trim(), "Buy me a coffee");
		assert.ok(await btn.isVisible());
		const box = await page.$eval(".zia-footer", el => el.getBoundingClientRect().right);
		const right = await btn.evaluate(el => el.getBoundingClientRect().right);
		assert.ok(right <= box + 1, "não sai do rodapé: " + mode);
		await btn.click();
		assert.deepEqual(await page.evaluate(() => window.opened), ["https://github.com/serbernardo/zotero-assistente-ia/blob/main/APOIAR.md"]);
		await page.close();
	}
	console.log("OK Buy me a coffee escondido por omissão; ligado, abre a página de apoio (painel e janela)");

	// ---------- Sugestões com texto longo nunca ficam cortadas ----------
	{
		const page = await open("?mode=section", { width: 300, height: 800 });
		await tab(page, "meus");
		const cut = await page.$$eval(".zia-suggestion", bs => bs.filter(b => b.scrollHeight > b.clientHeight + 1).map(b => b.textContent));
		assert.deepEqual(cut, [], "sugestões cortadas: " + cut.join(" | "));
		console.log("OK sugestões em painel estreito: texto inteiro, sem cortes");
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
		await page.waitForFunction(() => window.view.engine === "codex");
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
		await page.waitForSelector("text=Teoria da aceitação");
		assert.match(await page.evaluate(() => window.lastPrompt), /Identifica o enquadramento teórico\./);
		console.log("OK os meus prompts: separador próprio e pedido com a instrução do utilizador");
		await page.close();
	}

	// ---------- Escolher e pedir, respostas recolhidas e histórico guardado ----------
	{
		const page = await open("?mode=section", { width: 420, height: 900 });
		await page.evaluate(a => { window.MOCK.answer = a; }, pontos);
		// Avançado: a caixa é só para perguntas e um clique numa ação envia logo (sem "+ indicações")
		assert.equal(await page.getAttribute(".zia-textarea", "placeholder"), "Ou pergunta algo sobre o artigo…");
		assert.equal(await page.locator(".zia-hints-toggle").count(), 0, "sem + indicações");
		assert.equal(await page.isHidden(".zia-hints"), true);
		await page.fill(".zia-textarea", "foca a metodologia");
		await page.keyboard.press("Enter");
		assert.equal(await page.evaluate(() => window.lastEngine), undefined, "Enter não envia");
		await page.fill(".zia-textarea", "");
		await page.click('button[data-action="resumo"]');
		await page.waitForSelector("text=Guardar como nota");
		assert.equal(await page.locator('button[data-action="resumo"].zia-done').count(), 1, "ação já pedida fica marcada");
		// sem título repetido: a bolha do pedido some e as indicações ficam ao lado do nome da ação
		assert.equal(await page.locator(".zia-msg-user:visible").count(), 0, "ação sem bolha repetida");
		// cada ação tem o seu separador
		await act(page, "pontos");
		await page.waitForFunction(() => document.querySelectorAll(".zia-conv-tab").length === 2 && !document.querySelector(".zia-send.zia-stop"));
		assert.equal(await page.locator(".zia-msg-assistant").count(), 1, "o separador Ideias principais só tem a sua resposta");
		assert.match(await page.textContent(".zia-conv-tab >> nth=0"), /Resumo/);
		assert.match(await page.textContent(".zia-conv-tab >> nth=1"), /Ideias principais/);
		await page.screenshot({ path: path.join(OUT, "ui_painel_separadores.png") });
		// escolher uma ação já pedida abre o separador dela, sem repetir o pedido
		const before = await page.evaluate(() => window.lastPrompt);
		await page.click('button[data-action="resumo"]');
		assert.equal(await page.getAttribute(".zia-conv-tab >> nth=0", "aria-selected"), "true", "abre o separador Resumo");
		assert.match(await page.textContent(".zia-status"), /Já pediste/);
		assert.equal(await page.evaluate(() => window.lastPrompt), before, "nada foi enviado");
		await page.click('button[data-action="resumo"]');
		// o título só tem a ação e o x: o motor usado fica por baixo do texto
		assert.equal(await page.locator(".zia-msg-head .zia-engine-tag, .zia-msg-head .zia-fold").count(), 0, "sem motor nem recolher no título");
		assert.equal(await page.locator(".zia-msg-assistant .zia-msg-meta").count() >= 1, true, "motor por baixo da resposta");
		assert.equal(await page.evaluate(() => {
			const m = document.querySelector(".zia-msg-assistant .zia-msg-meta");
			return m === m.parentNode.lastElementChild || !!m.previousElementSibling;
		}), true);
		await page.screenshot({ path: path.join(OUT, "ui_painel_motor_em_baixo.png") });
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
		assert.equal(await page.locator(".zia-footer button:has-text(\"Nova conversa\")").count(), 0, "sem Nova conversa no rodapé do Avançado");
		await page.evaluate(() => view.newConversation());
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
		assert.equal(await page.textContent('.zia-tab[data-group="meus"]'), "Pers.");
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
		// a resposta mais recente fica em cima e a anterior pode ser guardada como nota já recolhida
		await tab(page, "compreender");
		await page.evaluate(() => { window.MOCK.answer = "Resposta B [D1:p2]."; });
		await act(page, "resumo");
		await page.waitForFunction(() => !document.querySelector(".zia-send.zia-stop") && [...document.querySelectorAll(".zia-msg-assistant")].some(e => /Resposta B/.test(e.textContent)));
		assert.equal(await page.locator(".zia-conv-tab").count(), 2, "Teoria e Resumo em separadores diferentes");
		// guardar como nota a partir do botão por cima do texto
		await page.evaluate(() => { window.saved = []; const o = ZoteroIA.saveNote; ZoteroIA.saveNote = async a => { window.saved.push(a.heading); return o(a); }; });
		await page.click(".zia-msg-assistant >> nth=0 >> button:has-text(\"Guardar como nota\")");
		assert.equal(await page.evaluate(() => window.saved.length), 1, "resposta guardada como nota");
		assert.equal(await page.locator(".zia-msg-assistant.zia-collapsed").count(), 0, "as respostas nunca ficam recolhidas");
		await page.screenshot({ path: path.join(OUT, "ui_painel_personalizado.png") });
		console.log("OK personalizado: criar, usar, editar e apagar ações no painel; caixa de texto antes das respostas; guardar nota a partir da resposta");
		await page.close();
	}

	// ---------- Avançado (opção B): relevância com tema, Repetir com só para motores prontos, lista do motor na janela ----------
	{
		const page = await open("?mode=section", { width: 420, height: 900 });
		await page.evaluate(() => { window.MOCK.answer = "Relevante [D1:p1]."; });
		await tab(page, "avaliar");
		await page.click('button[data-action="relevancia"]');
		assert.equal(await page.evaluate(() => window.engineCalls || 0), 0, "sem tema não envia");
		assert.equal(await page.isVisible(".zia-hints-input"), true, "abre o campo para o tema");
		assert.match(await page.getAttribute(".zia-hints-input", "placeholder"), /tema/);
		await page.fill(".zia-hints-input", "literacia digital");
		await page.click(".zia-hints-run");
		await page.waitForSelector("text=Guardar como nota");
		assert.match(await page.evaluate(() => window.lastPrompt), /literacia digital/);
		// o Gemini está "Pronto" (teste ok): aparece Repetir com Gemini
		assert.equal(await page.locator("button:has-text(\"Repetir com Gemini\")").count(), 1);
		await page.close();
		const p2 = await open("?mode=section", { width: 420, height: 900 });
		await p2.evaluate(() => { ZoteroIA.setPref("gemini.lastTest", ""); window.MOCK.answer = "Resumo [D1:p1]."; });
		await act(p2, "resumo");
		await p2.waitForSelector("text=Guardar como nota");
		assert.equal(await p2.locator("button:has-text(\"Repetir com\"), .zia-retry-sel").count(), 0, "motor nunca testado: sem Repetir com");
		await p2.close();
		const w = await open("?mode=window", { width: 820, height: 700 });
		assert.equal(await w.locator("select").count(), 0, "a janela não usa listas nativas (não abrem no Zotero)");
		await dd(w, ".zia-engine", "gemini");
		assert.equal(await w.evaluate(() => view.engine), "gemini", "lista do motor da janela funciona");
		await w.close();
		console.log("OK Avançado: relevância pede o tema, Repetir com só para motores prontos, listas da janela funcionam");
	}

	// ---------- Janela: triagem por critérios ----------
	{
		const page = await open("?mode=window", { width: 820, height: 900 });
		await addAll(page);
		await page.waitForSelector(".zia-chip >> nth=1");
		await page.evaluate(() => { window.MOCK.answer = "## Verificação dos critérios\n- Estudo empírico: Sim [D1:p1].\n\n## Decisão\nIncluir.\n\nTRIAGEM: INCLUIR"; });
		// botão i com o que faz e os passos (aparece ao escolher Triagem)
		await page.click('button[data-action="triagem"]');
		await page.click(".zia-triagem-info");
		await page.waitForSelector(".zia-triagem-panel");
		assert.equal(await page.locator(".zia-triagem-panel li").count(), 4, "quatro passos explicados");
		await page.click(".zia-triagem-panel .zia-info-close");
		assert.equal(await page.locator(".zia-triagem-panel").count(), 0);
		// sem critérios não envia
		await page.click(".zia-send");
		await page.waitForSelector("text=Escreve primeiro os critérios");
		assert.equal(await page.evaluate(() => window.lastEngine), undefined, "sem critérios, nada é enviado");
		await page.fill(".zia-textarea", "estudos empíricos, desde 2018");
		await page.click(".zia-send");
		await page.waitForSelector("text=Resumo da triagem", { timeout: 30000 });
		await page.waitForFunction(() => !document.querySelector(".zia-send.zia-stop"));
		assert.match(await page.evaluate(() => window.lastPrompt), /estudos empíricos, desde 2018/);
		assert.equal(await page.locator("text=TRIAGEM: INCLUIR").count(), 0, "a linha técnica não aparece");
		const summary = page.locator(".zia-msg-assistant", { hasText: "Resumo da triagem" });
		assert.equal(await summary.locator(".zia-table tbody tr").count(), 2, "uma linha por artigo");
		assert.match(await summary.textContent(), /Incluir: 2 · Excluir: 0 · Duvidoso: 0/);
		assert.match(await summary.textContent(), /diagrama PRISMA.*avaliados 2 · incluídos 2 · excluídos 0 · por decidir 0/, "números para o PRISMA");
		assert.equal(await summary.locator("button:has-text(\"Exportar tabela (CSV)\")").count(), 1);
		assert.equal(await summary.locator("button:has-text(\"Repetir com\")").count(), 0, "o resumo é da app, não se repete");
		await page.screenshot({ path: path.join(OUT, "ui_janela_triagem.png") });
		console.log("OK triagem: pede os critérios, um pedido por artigo, resumo com a decisão de cada um e exportação CSV");
		await page.close();
	}

	// ---------- Gemini muda de modelo: não é um erro ----------
	{
		const page = await open("?mode=section", { width: 420, height: 800 });
		await page.evaluate(a => {
			window.MOCK.answer = a;
			window.MOCK.delayMs = 120;
			window.MOCK.notice = "O gemini-3.8-flash está ocupado. A usar o modelo seguinte…";
			window.MOCK.noticeMs = 700;
			window.MOCK.finalNotice = "Respondeu o gemini-3.7-flash-lite, porque o gemini-3.8-flash estava ocupado";
		}, pontos);
		await act(page, "resumo");
		await page.waitForSelector("text=A usar o modelo seguinte");
		// durante a troca: progresso normal, sem laranja, sem vermelho e sem ×
		const during = await page.evaluate(() => {
			const s = document.querySelector(".zia-status");
			return { cls: s.className, x: !!s.querySelector(".zia-status-x"), spinner: !!s.querySelector(".zia-spinner") };
		});
		assert.ok(!/zia-status-(warn|error)/.test(during.cls), "o aviso de troca de modelo não é um aviso laranja: " + during.cls);
		assert.equal(during.x, false, "sem × (não é um problema)");
		assert.equal(during.spinner, true, "mostra progresso");
		// quando a resposta começa, o aviso sai e fica "A escrever a resposta"
		await page.waitForSelector("text=A escrever a resposta");
		assert.equal(await page.locator(".zia-status", { hasText: "ocupado" }).count(), 0, "o aviso antigo já não aparece com a resposta a chegar");
		await page.waitForFunction(() => !document.querySelector(".zia-send.zia-stop"), null, { timeout: 30000 });
		// no fim: concluído, e a explicação discreta por baixo da resposta, sem a palavra erro
		assert.equal((await page.textContent(".zia-status")).trim(), "", "no Avançado o estado fica vazio no fim");
		assert.match(await page.textContent(".zia-msg-meta"), /\d+ s/, "o tempo está na linha por baixo da resposta");
		assert.doesNotMatch(await page.textContent(".zia-msg-meta"), /erro|Erro/);
		assert.match(await page.textContent(".zia-msg-meta"), /Respondeu o gemini-3\.7-flash-lite, porque o gemini-3\.8-flash estava ocupado/);
		assert.equal(await page.locator(".zia-msg-assistant .zia-preview-error, .zia-msg-error").count(), 0);
		await page.screenshot({ path: path.join(OUT, "ui_painel_troca_de_modelo.png") });
		console.log("OK Gemini muda de modelo: aviso neutro, sem laranja nem ×, e a explicação fica por baixo da resposta");
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
		// escolhe a coleção em "Procurar em", sem ter de a selecionar antes no Zotero, e junta-a toda
		await page.click(".zia-bar-tools button:has-text(\"+ Artigos\")");
		await page.waitForSelector(".zia-picker-row");
		await page.click(".zia-picker-segbtn:has-text(\"Coleção\")");
		await dd(page, ".zia-picker-colsel", "7");
		await page.click(".zia-picker-whole:has-text(\"Juntar a coleção toda (2)\")");
		await page.waitForSelector(".zia-chip-col:has-text(\"Coleção: Tese\")");
		await page.waitForSelector("text=Coleção «Tese» selecionada");
		await page.waitForSelector(".zia-chip >> nth=1");
		await page.click('[data-card="compare"]');
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
		await page.click(".zia-info-btn:not(.zia-triagem-info)");
		await page.waitForSelector(".zia-info-panel");
		assert.equal(await page.locator(".zia-info-fields li").count(), 14, "a explicação lista os campos da ficha");
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

	// ---------- Todos os botões do painel (avançado e simples): cada um faz alguma coisa e nenhum dá erro ----------
	for (const uimode of ["advanced", "simple"]) {
		const snapshot = page => page.evaluate(() => JSON.stringify([
			document.querySelector(".zia-root").innerHTML, window.opened, window.copied || null,
			window.lastEngine || null, window.tagged || null, window.openedWindow ? 1 : 0,
		]));
		const prepare = async () => {
			const page = await open("?mode=section&uimode=" + uimode, { width: 420, height: 900 });
			const before = errors.length;
			await page.evaluate(a => { window.MOCK.answer = a + "\nETIQUETAS: chatbots; bibliotecas"; }, pontos);
			if (uimode === "simple") await page.click('.zia-simple-btn[data-action="resumo"]');
			else await act(page, "pontos");
			await page.waitForSelector("text=Guardar como nota");
			await page.waitForFunction(() => !document.querySelector(".zia-typing"));
			return { page, before };
		};
		const { page: p0 } = await prepare();
		const labels = await p0.evaluate(() => [...document.querySelectorAll(".zia-root button")]
			.filter(b => b.offsetParent && !b.disabled)
			// o separador já aberto não tem nada a fazer
			.map(b => b.getAttribute("aria-selected") === "true" || (b.classList.contains("zia-mode-btn") && b.getAttribute("aria-pressed") === "true") ? null : b)
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
		console.log(`OK ${uimode}: todos os ${labels.filter(l => l[0] !== "(").length} botões do painel respondem sem erros: ${labels.filter(l => l[0] !== "(").join(", ")}`);
	}

	await browser.close();
	if (errors.length) {
		console.error("Erros na página:", errors);
		process.exit(1);
	}
	console.log("\nTodos os testes de interface passaram.");
}

main().catch(e => { console.error("FALHOU:", e); process.exit(1); });
