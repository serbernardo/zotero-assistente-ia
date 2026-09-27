// Testes de integração do núcleo com o Claude Code real e PDFs reais.
// Uso: node run_core.js [rapido]
const path = require("path");
const fs = require("fs");
const assert = require("assert/strict");
const { createEnv } = require("./mockzotero");

// Caminho do executável do Claude Code (com sessão iniciada): CLAUDE_PATH=<caminho>
const CLAUDE = process.env.CLAUDE_PATH ? path.resolve(process.env.CLAUDE_PATH) : null;
if (!CLAUDE) {
	console.error("Define CLAUDE_PATH com o caminho do Claude Code (por exemplo, o resultado de: where claude).");
	process.exit(2);
}
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

async function main() {
	const quick = process.argv.includes("rapido");
	const env = createEnv({ prefs: { "claude.path": CLAUDE, "claude.model": "haiku" } });
	const { core } = env;
	const L = core.lib;
	const silva = env.addPaper({
		title: "Assistentes conversacionais em bibliotecas universitárias portuguesas",
		date: "2021-06-01", key: "SILVAPDF",
		creators: [{ lastName: "Silva", firstName: "Ana" }, { lastName: "Costa", firstName: "Rui" }, { lastName: "Reis", firstName: "Marta" }],
		pdf: path.join(__dirname, "silva2021.pdf"),
	});
	const garcia = env.addPaper({
		title: "Library chatbots after deployment",
		date: "2023", key: "GARCIAPDF",
		creators: [{ lastName: "García", firstName: "Lucía" }, { lastName: "Ortega", firstName: "Tomás" }],
		pdf: path.join(__dirname, "garcia2023.pdf"),
	});

	// 1. Descrição e texto
	const d1 = await core.describeItem(silva.parent);
	const d2 = await core.describeItem(garcia.att); // também funciona a partir do anexo
	assert.equal(d1.ref, "Silva et al., 2021");
	assert.equal(d2.ref, "García & Ortega, 2023");
	d1.id = "D1"; d2.id = "D2";
	await core.loadText(d1);
	await core.loadText(d2);
	assert.equal(d1.pagesReliable, true);
	assert.equal(d1.pages.length, 6);
	console.log(`OK texto: D1 ${d1.pages.length} páginas, ${d1.chars} caracteres; D2 ${d2.pages.length} páginas`);
	const fitted = L.fitDocuments([d1, d2], 600000);
	assert.equal(fitted.docs[0].refsFromPage, 5, "referências de D1 detetadas na página 5");
	const block = L.buildDocumentBlock(fitted.docs[0]);
	assert.ok(!block.includes("Davis, F. D."), "referências removidas do pedido");
	console.log("OK referências removidas a partir da página", fitted.docs[0].refsFromPage);

	// 2. Descoberta do executável e argumentos
	const exe = await core.findClaudeExecutable();
	assert.equal(exe, CLAUDE);
	const args = core.claudeArgs("sonnet", "/tmp/s.md", new Set());
	assert.ok(args.includes("--tools="));
	console.log("OK executável:", exe);

	// 3. Pedido real: pontos-chave de D1 (haiku, barato)
	const docsMap = { D1: d1, D2: d2 };
	let deltas = 0;
	const req1 = L.buildRequest({ fitted: L.fitDocuments([d1], 600000), history: [], userText: L.actionPrompt("pontos", [d1]) });
	const r1 = await core.runClaude({
		system: L.SYSTEM_PROMPT, prompt: req1, model: "haiku",
		onDelta: () => deltas++,
	});
	fs.writeFileSync(path.join(OUT, "pontos_D1.md"), r1.text);
	assert.ok(deltas > 1, "recebeu texto em fluxo");
	const cites = [...r1.text.matchAll(L.CITE_GROUP_RE)];
	assert.ok(cites.length >= 3, "tem citações [D1:pX]");
	console.log(`OK Claude (${r1.model}) pontos-chave: ${r1.text.length} caracteres, ${deltas} blocos em fluxo, ${cites.length} citações`);
	// citações válidas (páginas existentes)
	for (const m of cites) {
		for (const c of L.parseCiteGroup(m[1])) {
			assert.equal(c.doc, "D1");
			if (c.page) assert.ok(c.page >= 1 && c.page <= 6, "página válida " + c.page);
		}
	}
	console.log("OK todas as páginas citadas existem");

	// 4. Nota com ligações zotero://open-pdf
	const note = await core.saveNote({ markdown: r1.text, heading: "Pontos principais · Silva et al. 2021", docs: [d1], docsMap, engine: "claude", collectionIDs: [] });
	assert.equal(note.parentID, silva.parent.id);
	assert.match(note.html, /zotero:\/\/open-pdf\/library\/items\/SILVAPDF\?page=\d/);
	fs.writeFileSync(path.join(OUT, "nota_D1.html"), note.html);
	console.log("OK nota filha com ligações para as páginas do PDF");

	if (!quick) {
		// 5. Comparação real com Sonnet
		const req2 = L.buildRequest({ fitted, history: [], userText: L.actionPrompt("comparar", [d1, d2]) });
		const t0 = Date.now();
		const r2 = await core.runClaude({ system: L.SYSTEM_PROMPT, prompt: req2, model: "sonnet" });
		fs.writeFileSync(path.join(OUT, "comparar_D1_D2.md"), r2.text);
		const tables = L.extractTables(r2.text);
		assert.ok(tables.length >= 1, "comparação tem tabela");
		const csv = L.tablesToCSV(r2.text, { docsMap });
		fs.writeFileSync(path.join(OUT, "comparar.csv"), csv);
		assert.ok(/D1/.test(r2.text) && /D2/.test(r2.text));
		console.log(`OK comparação (${r2.model}) em ${Math.round((Date.now() - t0) / 1000)} s, ${tables.length} tabela(s), CSV com ${csv.split("\r\n").length} linhas`);
		const note2 = await core.saveNote({ markdown: r2.text, heading: "Comparação · Silva et al. 2021; García & Ortega 2023", docs: [d1, d2], docsMap, engine: "claude", collectionIDs: [5] });
		assert.equal(note2.parentID, undefined);
		assert.equal(note2.libraryID, 1);
		assert.deepEqual(note2.relations, [silva.parent.id, garcia.parent.id]);
		assert.deepEqual(note2.collections, [5]);
		fs.writeFileSync(path.join(OUT, "nota_comparar.html"), note2.html);
		console.log("OK nota independente, relacionada com os 2 artigos e na coleção");

		// 6. Lacunas
		const req3 = L.buildRequest({ fitted, history: [], userText: L.actionPrompt("lacunas", [d1, d2]) });
		const r3 = await core.runClaude({ system: L.SYSTEM_PROMPT, prompt: req3, model: "sonnet" });
		fs.writeFileSync(path.join(OUT, "lacunas_D1_D2.md"), r3.text);
		assert.match(r3.text, /Inferência/);
		console.log("OK lacunas:", r3.text.length, "caracteres");
	}

	// 7. Cancelamento
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 1500);
	try {
		await core.runClaude({ system: L.SYSTEM_PROMPT, prompt: req1, model: "haiku", signal: ac.signal });
		assert.fail("devia ter sido cancelado");
	}
	catch (e) {
		assert.equal(e.kind, "aborted");
		console.log("OK cancelamento:", e.message);
	}

	// 8. Versão antiga que não conhece --safe-mode: repete sem a opção
	const fake = path.join(env.tmp, "claude-antigo.sh");
	fs.writeFileSync(fake, `#!/bin/sh
for a in "$@"; do if [ "$a" = "--safe-mode" ]; then echo "error: unknown option '--safe-mode'" >&2; exit 1; fi; done
exec "${CLAUDE}" "$@"
`, { mode: 0o755 });
	env.prefStore.set("extensions.zoteroia.claude.path", fake);
	const r4 = await core.runClaude({ system: "Responde apenas OK.", prompt: "teste", model: "haiku" });
	assert.match(r4.text, /OK/i);
	const lastArgs = env.Subprocess.calls[env.Subprocess.calls.length - 1].args;
	assert.ok(!lastArgs.includes("--safe-mode"));
	console.log("OK repetição automática sem --safe-mode");

	// 9. Sem sessão iniciada: mensagem clara
	const noauth = path.join(env.tmp, "claude-semsessao.sh");
	fs.writeFileSync(noauth, `#!/bin/sh
cat >/dev/null
echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'
exit 1
`, { mode: 0o755 });
	env.prefStore.set("extensions.zoteroia.claude.path", noauth);
	try {
		await core.runClaude({ system: "x", prompt: "y" });
		assert.fail("devia falhar");
	}
	catch (e) {
		assert.equal(e.kind, "auth");
		console.log("OK sem sessão:", e.message);
	}
	// 10. Limite da subscrição
	const limit = path.join(env.tmp, "claude-limite.sh");
	fs.writeFileSync(limit, `#!/bin/sh
cat >/dev/null
echo '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1790527200"}'
exit 1
`, { mode: 0o755 });
	env.prefStore.set("extensions.zoteroia.claude.path", limit);
	try {
		await core.runClaude({ system: "x", prompt: "y" });
	}
	catch (e) {
		assert.equal(e.kind, "limit");
		console.log("OK limite:", e.message);
	}
	// 11. ANTHROPIC_API_KEY é retirada do ambiente
	process.env.ANTHROPIC_API_KEY = "sk-teste";
	env.prefStore.set("extensions.zoteroia.claude.path", noauth);
	try { await core.runClaude({ system: "x", prompt: "y" }); } catch (e) { /* esperado */ }
	const lastEnv = env.Subprocess.calls[env.Subprocess.calls.length - 1].environment;
	assert.equal(lastEnv.ANTHROPIC_API_KEY, undefined);
	delete process.env.ANTHROPIC_API_KEY;
	console.log("OK ANTHROPIC_API_KEY retirada");

	// 12. Chave Gemini encriptada
	await core.setGeminiKey("AIza-teste");
	assert.ok(env.prefStore.get("extensions.zoteroia.gemini.key").startsWith("oskv1:"));
	assert.equal(await core.getGeminiKey(), "AIza-teste");
	console.log("OK chave Gemini guardada encriptada");

	// 13. Fichas: encontra nota existente
	await core.saveNote({ markdown: "| Campo | Conteúdo |\n|---|---|\n| Método | Inquérito [D1:p3] |", heading: "Ficha IA · Silva et al. 2021", docs: [d1], docsMap, engine: "claude" });
	const fn = core.findFichaNote(silva.parent.id);
	assert.ok(fn, "ficha encontrada");
	assert.match(core.noteToText(fn), /Inquérito/);
	console.log("OK ficha reutilizável encontrada");
	console.log("\nTodos os testes do núcleo passaram.");
}

main().catch(e => {
	console.error("FALHOU:", e);
	process.exit(1);
});
