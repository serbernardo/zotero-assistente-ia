// Testes das funcionalidades de IA com uma IA REAL.
// Corre todas as ações sobre os PDFs de teste e verifica: citações válidas, números copiados
// dos documentos (nada inventado) e perguntas-armadilha (informação que não existe e premissas falsas).
// Uso (gasta quota ou limite da conta):
//   GEMINI_API_KEY=<chave> node run_ai_real.js gemini [modelo principal]   (por omissão gemini-3.5-flash-lite)
//   CLAUDE_PATH=<executável> node run_ai_real.js claude [modelo]           (por omissão sonnet)
//   IAEDU_API_KEY=<chave> node run_ai_real.js iaedu                        (modelo do agente)
//     IAEDU_ENDPOINT=<url> e IAEDU_CHANNEL=<id>: agente próprio, os dois do mesmo cartão da chave.
//     Em branco: agente partilhado da UPorto (como nas definições do addon).
//   OPENAI_API_KEY=<chave> node run_ai_real.js openai [modelo]             (ou OPENAI_MODEL, por omissão o do addon)
// Opções (variáveis de ambiente):
//   PDFS=<a.pdf>:<b.pdf>   usa estes PDFs em vez dos dois de teste (separados por ":" ou ";"). O autor e o ano
//                          vêm do nome do ficheiro do Zotero ("Autor - Ano - Título.pdf"). As ações de um artigo
//                          correm uma vez por PDF (resumo_D1.md, resumo_D2.md) e as de vários artigos com todos.
//                          As perguntas-armadilha e a de seguimento dependem dos PDFs de teste e ficam de fora.
//   ONLY=<ações>           corre só essas ações (ex.: ONLY=resumo,critica), sem armadilhas nem seguimento
//   UI_LANG=en             app em inglês: confirma que as respostas saem em inglês
//   PAR=<n>                pedidos ao mesmo tempo (por omissão 2 no Gemini e no IAEdu, 4 nos outros)
const path = require("path");
const fs = require("fs");
const { createEnv } = require("./mockzotero");

const ENGINES = ["claude", "gemini", "iaedu", "openai"];
if (process.argv[2] && !ENGINES.includes(process.argv[2])) {
	console.error(`Motor desconhecido: ${process.argv[2]}. Usa um destes: ${ENGINES.join(", ")}.`);
	process.exit(2);
}
const ENGINE = process.argv[2] || "claude";
const CLAUDE = process.env.CLAUDE_PATH ? path.resolve(process.env.CLAUDE_PATH) : null;
const GKEY = process.env.GEMINI_API_KEY || "";
const IAEDU_KEY = (process.env.IAEDU_API_KEY || "").trim();
const IAEDU_ENDPOINT = (process.env.IAEDU_ENDPOINT || "").trim();
const IAEDU_CHANNEL = (process.env.IAEDU_CHANNEL || "").trim();
const OKEY = (process.env.OPENAI_API_KEY || "").trim();
const MISSING = {
	claude: !CLAUDE && "Define CLAUDE_PATH com o caminho do Claude Code.",
	gemini: !GKEY && "Define GEMINI_API_KEY com a tua chave da API do Gemini.",
	iaedu: !IAEDU_KEY && "Define IAEDU_API_KEY com a chave do teu cartão do IAEdu. Se o cartão não for o do agente partilhado "
		+ "da UPorto, define também IAEDU_ENDPOINT e IAEDU_CHANNEL, copiados do mesmo cartão.",
	openai: !OKEY && "Define OPENAI_API_KEY com a tua chave da API da OpenAI.",
};
if (MISSING[ENGINE]) {
	console.error(MISSING[ENGINE]);
	process.exit(2);
}
// "" fica com o modelo das preferências do addon (OpenAI) ou do agente (IAEdu)
const MODEL = process.argv[3] || {
	gemini: "gemini-3.5-flash-lite",
	claude: "sonnet",
	openai: (process.env.OPENAI_MODEL || "").trim(),
	iaedu: "",
}[ENGINE];
// UI_LANG=en corre tudo com a app em inglês e confirma que as respostas saem em inglês
const UI_LANG = process.env.UI_LANG === "en" ? "en" : "pt-PT";
const OUT = path.join(__dirname, "out", "ia_real_" + ENGINE);
const PAR = Math.max(1, parseInt(process.env.PAR, 10) || (ENGINE === "gemini" || ENGINE === "iaedu" ? 2 : 4));
// Os mesmos tempos de chatview.js (LIMIT_WAITS): os motores com chave pedem uma pausa quando se passa
// o limite de pedidos por minuto. O Gemini já espera sozinho e o Claude Code tem limites de horas.
const LIMIT_WAITS = [30, 60, 90];
const LIMIT_ENGINES = ["iaedu", "anthropic", "openai"];

// PDFS: separados por ";" ou ":". O ":" de uma letra de unidade do Windows (C:\) não separa.
const PDFS = (process.env.PDFS || "").split(/;|(?<!(?:^|[;:])[A-Za-z]):/).map(x => x.trim()).filter(Boolean).map(f => path.resolve(f));
const CUSTOM = PDFS.length > 0;
for (const f of PDFS) {
	if (!fs.existsSync(f)) {
		console.error(`PDF não encontrado: ${f}`);
		process.exit(2);
	}
}

/**
 * Autor, ano e título a partir do nome que o Zotero dá aos ficheiros: "Volik and Kovaleva - 2020 - Título.pdf"
 * ou "Shahzad et al. - 2024 - Título.pdf". As cópias enviadas podem trazer "_" em vez de espaços e um prefixo
 * como "50d8f56c-". Sem esse formato fica o nome do ficheiro.
 */
function refFromFileName(file) {
	const base = path.basename(file).replace(/\.pdf$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
	const m = /^(?:[0-9a-f]{8}-)?(.+?) - (\d{4}) - (.+)$/i.exec(base);
	if (!m) {
		const year = (base.match(/\b(1[5-9]\d\d|20\d\d)\b/) || [])[1] || "";
		return { authors: base, creators: [{ lastName: base }], year, title: base };
	}
	const authors = m[1].trim();
	const etal = /\s+et al\.?$/i.test(authors);
	const creators = authors.replace(/\s+et al\.?$/i, "").split(/\s+(?:and|e|&)\s+/)
		.map(s => s.trim()).filter(Boolean).map(lastName => ({ lastName }));
	// "et al.": três autores ou mais, para o addon escrever "Autor et al." como no Zotero
	if (etal) while (creators.length < 3) creators.push({ lastName: "et al." });
	return { authors, creators, year: m[2], title: m[3].trim() };
}

async function pool(tasks, n) {
	const results = [];
	let i = 0;
	await Promise.all(Array.from({ length: n }, async () => {
		while (i < tasks.length) {
			const k = i++;
			results[k] = await tasks[k]();
		}
	}));
	return results;
}

async function main() {
	const prefs = { "ui.lang": UI_LANG, "engine": ENGINE, "claude.path": CLAUDE || "", "gemini.defaultApplied": true, "gemini.modelStrong": "auto" };
	if (ENGINE === "claude") prefs["claude.model"] = MODEL;
	if (ENGINE === "gemini") prefs["gemini.model"] = MODEL;
	if (ENGINE === "openai" && MODEL) prefs["openai.model"] = MODEL;
	const env = createEnv({ prefs });
	const { core } = env;
	const L = core.lib;
	// As chaves vão para o cofre simulado e o agente do IAEdu para as preferências, como nas definições do addon
	if (ENGINE === "gemini") await core.setSecret("gemini", GKEY);
	if (ENGINE === "openai") await core.setSecret("openai", OKEY);
	if (ENGINE === "iaedu") {
		await core.setSecret("iaedu", IAEDU_KEY);
		// Mesmas regras de saveIAEduFields (preferences.js): os dois em branco ou os dois válidos
		if (IAEDU_ENDPOINT || IAEDU_CHANNEL) {
			if (!L.isIAEduEndpoint(IAEDU_ENDPOINT)) {
				console.error("IAEDU_ENDPOINT tem de ser o Endpoint da API do cartão do IAEdu: um endereço https do domínio iaedu.pt.");
				process.exit(2);
			}
			if (!/^[A-Za-z0-9_-]{8,80}$/.test(IAEDU_CHANNEL)) {
				console.error("IAEDU_CHANNEL tem de ser o ID do Canal do mesmo cartão do IAEdu (8 a 80 letras, números, - ou _).");
				process.exit(2);
			}
		}
		core.setPref("iaedu.endpoint", IAEDU_ENDPOINT);
		core.setPref("iaedu.channel", IAEDU_CHANNEL);
	}
	if (!core.isEngineReady(ENGINE)) {
		console.error(`O motor ${ENGINE} não ficou pronto com estas variáveis.`);
		process.exit(2);
	}
	// O IAEdu precisa do FormData da janela (pedido multipart)
	const win = { fetch, AbortController, FormData };

	// Documentos: os dois PDFs de teste ou os de PDFS
	const docs = [];
	if (CUSTOM) {
		for (const [i, file] of PDFS.entries()) {
			const meta = refFromFileName(file);
			const p = env.addPaper({ title: meta.title, date: meta.year, key: "PDF" + (i + 1), creators: meta.creators, pdf: file });
			const d = await core.describeItem(p.parent);
			d.id = "D" + (i + 1);
			d.fullRef = `${meta.authors} (${meta.year || L.yearFrom("")}). ${meta.title}.`;
			docs.push(d);
		}
		L.disambiguateRefs(docs);
	}
	else {
		const silva = env.addPaper({
			title: "Assistentes conversacionais em bibliotecas universitárias portuguesas", date: "2021-06-01", key: "SILVAPDF",
			creators: [{ lastName: "Silva", firstName: "Ana" }, { lastName: "Costa", firstName: "Rui" }, { lastName: "Reis", firstName: "Marta" }],
			pdf: path.join(__dirname, "silva2021.pdf"),
		});
		const garcia = env.addPaper({
			title: "Library chatbots after deployment", date: "2023", key: "GARCIAPDF",
			creators: [{ lastName: "García", firstName: "Lucía" }, { lastName: "Ortega", firstName: "Tomás" }],
			pdf: path.join(__dirname, "garcia2023.pdf"),
		});
		for (const p of [silva, garcia]) {
			const d = await core.describeItem(p.parent);
			d.id = "D" + (docs.length + 1);
			docs.push(d);
		}
	}
	// Texto página a página e número impresso nas páginas (pageOffset), pelo mesmo loadText do addon
	for (const d of docs) {
		try { await core.loadText(d); }
		catch (e) {
			console.error(`Não foi possível ler o PDF de ${d.id} (${d.ref}): ${e.message}`);
			process.exit(2);
		}
	}
	const d1 = docs[0];
	const system = L.buildSystemPrompt("ui");
	const docLines = docs.map(d => `  ${d.id} ${d.ref}: ${d.pages.length} páginas, ${d.chars} caracteres, `
		+ `desvio das páginas ${typeof d.pageOffset === "number" ? (d.pageOffset > 0 ? "+" : "") + d.pageOffset : "não detetado"}`);

	const ask = async (docs, userText, history, actionID) => {
		const a = actionID ? L.ACTIONS[actionID] : null;
		const fitted = L.fitDocuments(docs, core.maxCharsFor(ENGINE), { keepRefs: !!(a && a.keepRefs) });
		const parts = L.buildRequestParts({ fitted, history: history || [], userText });
		const t0 = Date.now();
		const notices = fitted.warnings.slice();
		let r;
		for (let attempt = 0; ; attempt++) {
			try {
				r = await core.runEngine(ENGINE, {
					system, prompt: parts.docs + "\n\n" + parts.rest, promptParts: parts, win,
					heavy: L.isHeavyTask({ actionID, docCount: docs.length }),
					// Comparar exige um modelo completo (Gemini): nunca os "lite"
					noLite: !!(a && a.group === "comparar"),
					onInfo: i => { if (i && i.notice) notices.push(i.notice); },
				});
				break;
			}
			catch (e) {
				if (e.kind !== "limit" || !LIMIT_ENGINES.includes(ENGINE) || attempt >= LIMIT_WAITS.length) throw e;
				notices.push(`limite de pedidos por minuto: pausa de ${LIMIT_WAITS[attempt]} s`);
				await new Promise(res => setTimeout(res, LIMIT_WAITS[attempt] * 1000));
			}
		}
		r.notices = notices;
		r.secs = Math.round((Date.now() - t0) / 1000);
		return r;
	};
	// A resposta tem de sair na língua da app. Os excertos entre aspas ficam na língua do PDF,
	// por isso são retirados antes de contar as palavras.
	const wrongLanguage = text => {
		const fora = String(text).replace(/["\u201c\u00ab][^"\u201d\u00bb\n]{10,500}["\u201d\u00bb]/g, " ");
		const conta = re => (fora.match(re) || []).length;
		const pt = conta(/(^|[^\wÀ-ÿ])(não|são|também|está|estão|foram|pelos|pelas|dos|das|uma|como|mais|entre|sobre|página|estudo|resultados|autores|artigo)([^\wÀ-ÿ]|$)/gi);
		const en = conta(/(^|[^\w])(the|and|of|that|with|were|was|this|from|their|study|results|authors|page|between|about)([^\w]|$)/gi);
		if (UI_LANG === "en" && pt > 3 && pt > en) return `resposta em português (app em inglês): ${pt} palavras PT, ${en} EN`;
		if (UI_LANG === "pt-PT" && en > 3 && en > pt) return `resposta em inglês (app em português): ${en} palavras EN, ${pt} PT`;
		return null;
	};

	// Usa a mesma verificação automática que o addon mostra por baixo de cada resposta,
	// só com os documentos que foram no pedido
	const check = (id, text, reqDocs, { needCites = true } = {}) => {
		const problems = [];
		const lang = wrongLanguage(text);
		if (lang) problems.push(lang);
		const cites = [...text.matchAll(L.CITE_GROUP_RE)];
		if (needCites && !cites.length) problems.push("sem citações");
		const v = L.verifyAnswer(text, Object.fromEntries(reqDocs.map(d => [d.id, { pages: d.pages }]))) || {};
		for (const q of v.badQuotes || []) problems.push(`excerto não encontrado: «${q.quote}»`);
		for (const q of v.changedQuotes || []) problems.push(`excerto com palavras alteradas: «${q.quote}»`);
		for (const q of v.wrongPage || []) problems.push(`excerto noutra página: «${q.quote}» [${q.cite}]`);
		for (const q of v.otherDoc || []) problems.push(`excerto de outro artigo (${q.doc}): «${q.quote}» [${q.cite}]`);
		for (const b of v.badCites || []) problems.push(`página inexistente ${b.doc}:p${b.page}`);
		for (const e of v.badCalcs || []) problems.push(`conta errada: ${e}`);
		if ((v.unknownNumbers || []).length) problems.push("números que não estão nos documentos: " + v.unknownNumbers.join(" "));
		return { id, cites: cites.length, quotes: `${v.quotesOK || 0}/${v.quotes || 0}`, calcs: v.calcs || 0, problems };
	};

	// 1. Todas as ações
	// ONLY=conclusoes,critica corre só essas ações (sem armadilhas nem seguimento), para gastar menos
	const ONLY = (process.env.ONLY || "").split(",").map(x => x.trim()).filter(Boolean);
	const unknownIDs = ONLY.filter(id => !L.ACTIONS[id]);
	if (unknownIDs.length) console.warn(`Ações desconhecidas em ONLY (ignoradas): ${unknownIDs.join(", ")}`);
	const runAction = (id, reqDocs, tag) => async () => {
		const a = L.ACTIONS[id];
		const name = tag ? `${id}_${tag}` : id;
		try {
			// Mapa de temas: como no addon, só o título, o resumo e as palavras-chave de cada artigo
			const sent = a.metaOnly
				? await Promise.all(reqDocs.map(async d => Object.assign({}, d, { kind: "ficha", fichaText: await core.itemMetaText(d) })))
				: reqDocs;
			const r = await ask(sent, L.actionPrompt(id, sent), null, id);
			fs.writeFileSync(path.join(OUT, name + ".md"), r.text);
			const c = check(name, r.text, reqDocs, { needCites: id !== "etiquetas" });
			if (id === "etiquetas" && !L.parseTagLine(r.text).length) c.problems.push("sem linha de etiquetas");
			if (id !== "etiquetas" && /\|/.test(r.text) && a.group === "comparar" && !L.extractTables(r.text).length) c.problems.push("tabela mal formada");
			return Object.assign(c, { secs: r.secs, chars: r.text.length, model: r.model, notices: r.notices });
		}
		catch (e) {
			return { id: name, problems: ["erro: " + e.message], cites: 0 };
		}
	};
	const tasks = [];
	// Ações de um artigo: com os PDFs de teste só no D1, com PDFS em cada um
	const singleDocs = CUSTOM ? docs : [d1];
	let skippedMulti = 0;
	for (const id of L.ACTION_ORDER.filter(id => !ONLY.length || ONLY.includes(id))) {
		const a = L.ACTIONS[id];
		if (a.minDocs >= 2) {
			if (docs.length < a.minDocs) { skippedMulti++; continue; }
			tasks.push(runAction(id, docs));
		}
		else for (const d of singleDocs) tasks.push(runAction(id, [d], CUSTOM ? d.id : null));
	}
	// 2. Perguntas-armadilha: a resposta certa é dizer que não consta ou corrigir a premissa.
	// Dependem do conteúdo dos PDFs de teste, por isso não correm com PDFS.
	const traps = [
		{ id: "armadilha_financiamento", q: "Quem financiou este estudo e quanto custou?", expect: /não (consta|é referid|é indicad|é mencionad|refere|indica|menciona|apresenta|informa)|não há informação|sem informação|não (são|é) (apresentad|fornecid)/i },
		{ id: "armadilha_alfa", q: "Qual foi o alfa de Cronbach do questionário?", expect: /não (consta|é referid|é indicad|é mencionad|refere|indica|menciona|apresenta|reporta|informa)|não há informação|sem informação/i },
		{ id: "armadilha_premissa", q: "Porque é que os autores concluem que os chatbots devem substituir os bibliotecários?", expect: /não (concluem|afirmam|defendem|dizem|propõem|recomendam|referem|consta)|premissa|não é isso|não há (essa|tal)/i },
	];
	const fixtureExtras = !CUSTOM && !ONLY.length;
	for (const t of fixtureExtras ? traps : []) {
		tasks.push(async () => {
			try {
				const r = await ask([d1], t.q);
				fs.writeFileSync(path.join(OUT, t.id + ".md"), r.text);
				const c = check(t.id, r.text, [d1], { needCites: false });
				if (!t.expect.test(r.text)) c.problems.push("não disse que a informação não consta / não corrigiu a premissa");
				return Object.assign(c, { secs: r.secs, chars: r.text.length, model: r.model, notices: r.notices });
			}
			catch (e) { return { id: t.id, problems: ["erro: " + e.message], cites: 0 }; }
		});
	}
	// 3. Pergunta de seguimento com o histórico limitado (a resposta certa está no PDF de teste)
	if (fixtureExtras) tasks.push(async () => {
		try {
			const r1 = await ask([d1], "Qual é a dimensão da amostra?");
			const hist = L.selectHistory([{ role: "user", text: "Qual é a dimensão da amostra?" }, { role: "assistant", text: r1.text }]);
			const r2 = await ask([d1], "E que percentagem dessa amostra eram mulheres?", hist);
			fs.writeFileSync(path.join(OUT, "seguimento.md"), r1.text + "\n\n---\n\n" + r2.text);
			const c = check("seguimento", r2.text, [d1]);
			if (!/61\s?%/.test(r2.text)) c.problems.push("não respondeu 61%");
			return Object.assign(c, { secs: r1.secs + r2.secs, chars: r2.text.length, model: r2.model, notices: r1.notices.concat(r2.notices) });
		}
		catch (e) { return { id: "seguimento", problems: ["erro: " + e.message], cites: 0 }; }
	});
	if (!tasks.length) {
		console.error("Nada para correr: confirma ONLY e PDFS.");
		process.exit(2);
	}

	const modelLabel = ENGINE === "iaedu" ? "o do agente" : `"${ENGINE === "openai" ? core.openaiModel() : MODEL}"`;
	const agent = ENGINE === "iaedu" ? (IAEDU_ENDPOINT ? `, agente ${IAEDU_ENDPOINT}` : ", agente partilhado (por omissão)") : "";
	const head = [`Motor ${ENGINE}${agent}, modelo ${modelLabel}, app em ${UI_LANG}`, "Documentos:"].concat(docLines);
	if (skippedMulti) head.push(`(${skippedMulti === 1 ? "1 ação de vários artigos ficou" : skippedMulti + " ações de vários artigos ficaram"} de fora: precisam de 2 PDFs ou mais)`);
	if (CUSTOM && !ONLY.length) head.push("(PDFS: sem perguntas-armadilha nem pergunta de seguimento, dependem dos PDFs de teste)");
	console.log(head.join("\n"));
	fs.mkdirSync(OUT, { recursive: true });
	console.log(`\nA correr ${tasks.length} pedidos reais (${PAR} de cada vez)…`);
	const results = await pool(tasks, PAR);
	let fails = 0;
	const lines = [];
	for (const r of results) {
		const ok = !r.problems.length;
		if (!ok) fails++;
		const line = `${ok ? "OK " : "FALHOU"} ${r.id.padEnd(24)} ${String(r.cites).padStart(3)} citações  excertos ${String(r.quotes || "").padEnd(5)} ${String(r.secs || "?").padStart(3)} s  ${(r.model || "").padEnd(24)} ${ok ? "" : r.problems.join("; ")}`
			+ (r.notices && r.notices.length ? `\n       avisos: ${r.notices.join(" | ")}` : "");
		lines.push(line);
		console.log(line);
	}
	fs.writeFileSync(path.join(OUT, "relatorio.txt"), head.join("\n") + "\n\n" + lines.join("\n") + "\n");
	console.log(`\n${results.length - fails} de ${results.length} verificações passaram. Respostas em ${OUT}`);
	process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error("FALHOU:", e); process.exit(1); });
