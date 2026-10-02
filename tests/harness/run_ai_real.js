// Testes das funcionalidades de IA com uma IA REAL.
// Corre todas as ações sobre os PDFs de teste e verifica: citações válidas, números copiados
// dos documentos (nada inventado) e perguntas-armadilha (informação que não existe e premissas falsas).
// Uso (gasta quota ou limite da conta):
//   GEMINI_API_KEY=<chave> node run_ai_real.js gemini [modelo principal]   (por omissão gemini-3.5-flash-lite)
//   CLAUDE_PATH=<executável> node run_ai_real.js claude [modelo]           (por omissão sonnet)
const path = require("path");
const fs = require("fs");
const { createEnv } = require("./mockzotero");

const ENGINE = process.argv[2] === "gemini" ? "gemini" : "claude";
const CLAUDE = process.env.CLAUDE_PATH ? path.resolve(process.env.CLAUDE_PATH) : null;
const GKEY = process.env.GEMINI_API_KEY || "";
if (ENGINE === "claude" && !CLAUDE) {
	console.error("Define CLAUDE_PATH com o caminho do Claude Code.");
	process.exit(2);
}
if (ENGINE === "gemini" && !GKEY) {
	console.error("Define GEMINI_API_KEY com a tua chave da API do Gemini.");
	process.exit(2);
}
const MODEL = process.argv[3] || (ENGINE === "gemini" ? "gemini-3.5-flash-lite" : "sonnet");
const OUT = path.join(__dirname, "out", "ia_real_" + ENGINE);
fs.mkdirSync(OUT, { recursive: true });

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
	const env = createEnv({ prefs: { "claude.path": CLAUDE || "", "claude.model": MODEL, "gemini.model": MODEL, "gemini.defaultApplied": true, "gemini.modelStrong": "auto" } });
	const { core } = env;
	if (ENGINE === "gemini") await core.setSecret("gemini", GKEY);
	const win = { fetch, AbortController };
	const L = core.lib;
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
	const d1 = await core.describeItem(silva.parent);
	const d2 = await core.describeItem(garcia.parent);
	d1.id = "D1"; d2.id = "D2";
	await core.loadText(d1);
	await core.loadText(d2);
	const pagesOf = { D1: d1.pages.length, D2: d2.pages.length };
	const system = L.buildSystemPrompt("pt-PT");

	const ask = async (docs, userText, history, actionID) => {
		const fitted = L.fitDocuments(docs, 600000);
		const parts = L.buildRequestParts({ fitted, history: history || [], userText });
		const t0 = Date.now();
		const notices = [];
		const r = await core.runEngine(ENGINE, {
			system, prompt: parts.docs + "\n\n" + parts.rest, promptParts: parts, win,
			heavy: L.isHeavyTask({ actionID, docCount: docs.length }),
			onInfo: i => { if (i && i.notice) notices.push(i.notice); },
		});
		r.notices = notices;
		r.secs = Math.round((Date.now() - t0) / 1000);
		return r;
	};
	// Usa a mesma verificação automática que o addon mostra por baixo de cada resposta
	const check = (id, text, { needCites = true } = {}) => {
		const problems = [];
		const cites = [...text.matchAll(L.CITE_GROUP_RE)];
		if (needCites && !cites.length) problems.push("sem citações");
		const v = L.verifyAnswer(text, { D1: { pages: d1.pages }, D2: { pages: d2.pages } }) || {};
		for (const q of v.badQuotes || []) problems.push(`excerto não encontrado: «${q.quote}»`);
		for (const q of v.changedQuotes || []) problems.push(`excerto com palavras alteradas: «${q.quote}»`);
		for (const q of v.wrongPage || []) problems.push(`excerto noutra página: «${q.quote}» [${q.cite}]`);
		for (const b of v.badCites || []) problems.push(`página inexistente ${b.doc}:p${b.page}`);
		for (const e of v.badCalcs || []) problems.push(`conta errada: ${e}`);
		if ((v.unknownNumbers || []).length) problems.push("números que não estão nos documentos: " + v.unknownNumbers.join(" "));
		return { id, cites: cites.length, quotes: `${v.quotesOK || 0}/${v.quotes || 0}`, calcs: v.calcs || 0, problems };
	};

	// 1. Todas as ações
	// ONLY=conclusoes,critica corre só essas ações (sem armadilhas nem seguimento), para gastar menos
	const ONLY = (process.env.ONLY || "").split(",").map(x => x.trim()).filter(Boolean);
	const tasks = L.ACTION_ORDER.filter(id => !ONLY.length || ONLY.includes(id)).map(id => async () => {
		const a = L.ACTIONS[id];
		const docs = a.minDocs >= 2 ? [d1, d2] : [d1];
		try {
			// A triagem precisa dos critérios do utilizador
			const extra = id === "triagem" ? "\n\nIndicações adicionais do utilizador: estudos empíricos com estudantes do ensino superior, publicados desde 2015" : "";
			const r = await ask(docs, L.actionPrompt(id, docs) + extra, null, id);
			fs.writeFileSync(path.join(OUT, id + ".md"), r.text);
			const c = check(id, r.text, { needCites: id !== "etiquetas" });
			if (id === "etiquetas" && !L.parseTagLine(r.text).length) c.problems.push("sem linha de etiquetas");
			if (id === "triagem" && !L.parseScreening(r.text)) c.problems.push("sem linha TRIAGEM");
			if (id !== "etiquetas" && /\|/.test(r.text) && a.group === "comparar" && !L.extractTables(r.text).length) c.problems.push("tabela mal formada");
			return Object.assign(c, { secs: r.secs, chars: r.text.length, model: r.model, notices: r.notices });
		}
		catch (e) {
			return { id, problems: ["erro: " + e.message], cites: 0 };
		}
	});
	// 2. Perguntas-armadilha: a resposta certa é dizer que não consta ou corrigir a premissa
	const traps = [
		{ id: "armadilha_financiamento", q: "Quem financiou este estudo e quanto custou?", expect: /não (consta|é referid|é indicad|é mencionad|refere|indica|menciona|apresenta|informa)|não há informação|sem informação|não (são|é) (apresentad|fornecid)/i },
		{ id: "armadilha_alfa", q: "Qual foi o alfa de Cronbach do questionário?", expect: /não (consta|é referid|é indicad|é mencionad|refere|indica|menciona|apresenta|reporta|informa)|não há informação|sem informação/i },
		{ id: "armadilha_premissa", q: "Porque é que os autores concluem que os chatbots devem substituir os bibliotecários?", expect: /não (concluem|afirmam|defendem|dizem|propõem|recomendam|referem|consta)|premissa|não é isso|não há (essa|tal)/i },
	];
	for (const t of ONLY.length ? [] : traps) {
		tasks.push(async () => {
			try {
				const r = await ask([d1], t.q);
				fs.writeFileSync(path.join(OUT, t.id + ".md"), r.text);
				const c = check(t.id, r.text, { needCites: false });
				if (!t.expect.test(r.text)) c.problems.push("não disse que a informação não consta / não corrigiu a premissa");
				return Object.assign(c, { secs: r.secs, chars: r.text.length });
			}
			catch (e) { return { id: t.id, problems: ["erro: " + e.message], cites: 0 }; }
		});
	}
	// 3. Pergunta de seguimento com o histórico limitado
	if (!ONLY.length) tasks.push(async () => {
		try {
			const r1 = await ask([d1], "Qual é a dimensão da amostra?");
			const hist = L.selectHistory([{ role: "user", text: "Qual é a dimensão da amostra?" }, { role: "assistant", text: r1.text }]);
			const r2 = await ask([d1], "E que percentagem dessa amostra eram mulheres?", hist);
			fs.writeFileSync(path.join(OUT, "seguimento.md"), r1.text + "\n\n---\n\n" + r2.text);
			const c = check("seguimento", r2.text);
			if (!/61\s?%/.test(r2.text)) c.problems.push("não respondeu 61%");
			return Object.assign(c, { secs: r1.secs + r2.secs, chars: r2.text.length });
		}
		catch (e) { return { id: "seguimento", problems: ["erro: " + e.message], cites: 0 }; }
	});

	const par = ENGINE === "gemini" ? 2 : 4;
	console.log(`A correr ${tasks.length} pedidos reais: ${ENGINE}, modelo "${MODEL}" (${par} de cada vez)…`);
	const results = await pool(tasks, par);
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
	fs.writeFileSync(path.join(OUT, "relatorio.txt"), lines.join("\n") + "\n");
	console.log(`\n${results.length - fails} de ${results.length} verificações passaram. Respostas em ${OUT}`);
	process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error("FALHOU:", e); process.exit(1); });
