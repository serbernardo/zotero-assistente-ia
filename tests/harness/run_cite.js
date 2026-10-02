// Testa as citações no estilo escolhido no Zotero com o motor de citações REAL (citeproc.js do Zotero)
// e estilos CSL reais (APA, ABNT). Precisa do código do Zotero: ZOTERO_SRC=<clone> node run_cite.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");
const { createEnv } = require("./mockzotero");

if (!process.env.ZOTERO_SRC) {
	console.log("ZOTERO_SRC não definido: teste das citações em estilos ignorado.");
	process.exit(0);
}
const CSLDIR = path.join(__dirname, "csl");
const sandbox = { console, setTimeout, clearTimeout, DOMParser: undefined };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(process.env.ZOTERO_SRC, "chrome/content/zotero/xpcom/citeproc.js"), "utf8"), sandbox);
const CSL = sandbox.CSL;
assert.ok(CSL, "citeproc carregado");

const CSL_ITEMS = {
	1: { id: 1, type: "article-journal", title: "Chatbots em bibliotecas", author: [{ family: "Silva", given: "Ana" }, { family: "Costa", given: "Rui" }, { family: "Reis", given: "Marta" }], issued: { "date-parts": [[2021]] }, "container-title": "Revista A" },
	2: { id: 2, type: "article-journal", title: "Library chatbots after deployment", author: [{ family: "García", given: "Lucía" }, { family: "Ortega", given: "Tomás" }], issued: { "date-parts": [[2023]] }, "container-title": "Journal B" },
	3: { id: 3, type: "article-journal", title: "Atitudes dos estudantes", author: [{ family: "Silva", given: "Ana" }, { family: "Costa", given: "Rui" }, { family: "Reis", given: "Marta" }], issued: { "date-parts": [[2021]] }, "container-title": "Revista C" },
};

function engineFor(file) {
	const xml = fs.readFileSync(path.join(CSLDIR, file), "utf8");
	return (locale, format) => {
		const sys = {
			retrieveLocale: lang => {
				for (const l of [lang, "pt-PT", "en-US"]) {
					const f = path.join(CSLDIR, `locales-${l}.xml`);
					if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
				}
			},
			retrieveItem: id => CSL_ITEMS[id],
		};
		const e = new CSL.Engine(sys, xml, locale, true);
		e.setOutputFormat(format || "text");
		return e;
	};
}

(async () => {
	const env = createEnv({});
	const { core, Zotero } = env;
	const styles = {
		"http://www.zotero.org/styles/apa": { styleID: "http://www.zotero.org/styles/apa", title: "American Psychological Association 7th edition", getCiteProc: engineFor("apa.csl") },
		"http://www.zotero.org/styles/abnt": { styleID: "http://www.zotero.org/styles/abnt", title: "ABNT", getCiteProc: engineFor("associacao-brasileira-de-normas-tecnicas.csl") },
	};
	Zotero.Styles = { get: id => styles[id] || null, getVisible: () => Object.values(styles) };
	const reg = id => ({ id, key: "K" + id, libraryID: 1, isRegularItem: () => true });
	Zotero.Items.get = id => (id <= 3 ? reg(id) : null);
	const docsMap = {
		D1: { id: "D1", parentID: 1, ref: "Silva et al., 2021a", title: "Chatbots em bibliotecas" },
		D2: { id: "D2", parentID: 2, ref: "García e Ortega, 2023", title: "Library chatbots after deployment" },
		D3: { id: "D3", parentID: 3, ref: "Silva et al., 2021b", title: "Atitudes dos estudantes" },
		D4: { id: "D4", parentID: null, ref: "Sem item, 2020" },
	};
	const L = core.lib;
	const copy = t => L.citesToText(t, docsMap);

	// Sem estilo escolhido: formato simples
	core.setPref("cite.style", "");
	assert.equal(copy("[D2:p4, D1:p3]"), "(García e Ortega, 2023, p. 4; Silva et al., 2021a, p. 3)");

	// APA em português
	core.setPref("cite.style", "http://www.zotero.org/styles/apa");
	L.I18N.setLang("pt-PT");
	let out = copy("[D2:p4]");
	console.log("APA pt-PT:", out);
	// O estilo APA oficial usa "&" dentro do parêntesis também em português
	assert.match(out, /^\(García & Ortega, 2023, p\. 4\)$/);
	out = copy("[D1:p3, D2:p4]");
	console.log("APA pt-PT, várias fontes:", out);
	assert.match(out, /^\(.*(García & Ortega, 2023, p\. 4.*Silva et al., 2021[ab], p\. 3|Silva et al., 2021[ab], p\. 3.*García & Ortega, 2023, p\. 4).*\)$/, "duas fontes no mesmo parêntesis");
	assert.ok(out.includes(";"), "separadas por ponto e vírgula");
	out = copy("[D1:p1, p5]");
	console.log("APA, várias páginas:", out);
	assert.match(out, /pp\. 1, 5/);
	// os dois Silva et al., 2021 ficam com letras diferentes
	const a = copy("[D1:p3]"), b = copy("[D3:p3]");
	console.log("Mesmo autor e ano:", a, "|", b);
	assert.notEqual(a, b);
	assert.match(a, /2021[ab]/);
	assert.match(b, /2021[ab]/);

	// APA em inglês
	L.I18N.setLang("en");
	out = copy("[D2:p4]");
	console.log("APA en:", out);
	assert.match(out, /^\(García & Ortega, 2023, p\. 4\)$/, "APA em inglês usa &");
	L.I18N.setLang("pt-PT");

	// ABNT
	core.setPref("cite.style", "http://www.zotero.org/styles/abnt");
	out = copy("[D2:p4]");
	console.log("ABNT:", out);
	assert.match(out, /GARCÍA; ORTEGA, 2023, p\. 4|García; Ortega, 2023, p\. 4/i);

	// Artigo sem item no Zotero (anexo solto): volta ao formato simples
	core.setPref("cite.style", "http://www.zotero.org/styles/apa");
	assert.equal(copy("[D4:p2]"), "(Sem item, 2020, p. 2)");
	// Estilo que já não existe: formato simples
	core.setPref("cite.style", "http://www.zotero.org/styles/inexistente");
	assert.equal(copy("[D2:p4]"), "(García e Ortega, 2023, p. 4)");
	assert.equal(core.citationStyles().length, 2);

	// Notas em HTML: cada citação formatada, com a sua ligação ao PDF
	core.setPref("cite.style", "http://www.zotero.org/styles/apa");
	const html = L.markdownToHTML("Texto [D1:p3] e [D2:p4].", { docsMap, citeHref: c => `zotero://x/${c.doc}?page=${c.page}` });
	console.log("Nota HTML:", html);
	assert.match(html, /<a href="zotero:\/\/x\/D2\?page=4">\(García &amp; Ortega, 2023, p\. 4\)<\/a>/);
	assert.match(html, /<a href="zotero:\/\/x\/D1\?page=3">\(Silva et al\., 2021b, p\. 3\)<\/a>/);
	console.log("\nTodos os testes das citações em estilos passaram.");
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });
