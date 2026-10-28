// Mede a verificação automática (verifyAnswer) em PDFs reais, sem IA:
// 1. falsos alarmes: transcrições certas, escritas como um modelo as escreve, têm de passar
// 2. deteção: erros plantados em transcrições certas (palavra trocada, negação, número, página, artigo)
// 3. casos difíceis: frases partidas entre páginas e referências tiradas do meio da frase
// 4. números fora das transcrições: certos, trocados e atribuídos ao artigo errado
//
// Uso: PDFS="a.pdf:b.pdf:c.pdf" node tests/harness/run_verif_pdfs.js
// Sem PDFS usa os dois PDFs de teste (fáceis: curtos e sem defeitos de extração).
// Os resultados servem para comparar versões: medir antes e depois de mudar a verificação.
const path = require("path");
const { pdfText } = require("./mockzotero.js");
const L = require("../../addon/content/lib.js");

const files = (process.env.PDFS || [path.join(__dirname, "silva2021.pdf"), path.join(__dirname, "garcia2023.pdf")].join(":"))
	// separados por ";" ou ":" (o ":" de uma letra de unidade do Windows, C:\\, não separa)
	.split(/;|(?<!(?:^|[;:])[A-Za-z]):/).map(x => x.trim()).filter(Boolean);

let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const tally = {}, examples = {};
const add = (k, v, ex) => {
	(tally[k] = tally[k] || {})[v] = (tally[k][v] || 0) + 1;
	if (ex && !["ok", "apanhou"].includes(v) && (examples[k] = examples[k] || []).length < 3) examples[k].push(ex);
};

(async () => {
	const docs = {}, ids = [];
	for (const [i, f] of files.entries()) {
		const r = await pdfText(f);
		const s = L.splitPages(r.text, r.totalPages);
		const id = "D" + (i + 1);
		docs[id] = { pages: s.pages };
		ids.push(id);
		console.log(`${id}: ${path.basename(f).slice(0, 70)} (${s.pages.length} páginas)`);
	}
	const verdict = (quote, id, page) => {
		const r = L.verifyAnswer(`Segundo os autores, «${quote}» [${id}:p${page}].`, docs);
		if (!r || !r.quotes) return "não lida";
		if (r.quotesOK) return "ok";
		if ((r.otherDoc || []).length) return "noutro artigo";
		if (r.wrongPage.length) return "outra página";
		if (r.changedQuotes.length) return "alterada";
		return "não encontrada";
	};
	const caught = (q, id, pg) => verdict(q, id, pg) === "ok" ? "falhou" : "apanhou";

	// Vocabulário do próprio corpus, para escrever como um modelo arrumado (junta "bus iness")
	const vocab = new Map();
	for (const id of ids) for (const p of docs[id].pages) for (const w of p.replace(/-\n/g, "").toLowerCase().match(/\p{L}+/gu) || []) vocab.set(w, (vocab.get(w) || 0) + 1);
	const isWord = w => (vocab.get(w.toLowerCase()) || 0) >= 2;
	const tidy = s => {
		s = s.replace(/(\p{L}+)-\n(\p{L}+)/gu, (m, a, b) => isWord(a + b) ? a + b : a + "-" + b).replace(/\s+/g, " ")
			.replace(/\s+([,.;:)\]%])/g, "$1").replace(/([(\[])\s+/g, "$1").replace(/\s+[-–]\s+/g, "-").replace(/(\d)\s+(?=\d)/g, "$1");
		const t = s.split(" "), out = [];
		for (let i = 0; i < t.length; i++) {
			const a = t[i], b = t[i + 1];
			if (b && /^\p{L}+$/u.test(a) && /^\p{L}+[,.;:]?$/u.test(b)) {
				const bw = b.replace(/[,.;:]$/, "");
				if (isWord(a + bw) && !(isWord(a) && isWord(bw))) { out.push(a + b); i++; continue; }
			}
			out.push(a);
		}
		return out.join(" ");
	};
	const variants = {
		"transcrição certa, cópia literal": s => s.replace(/-\n/g, "-").replace(/\s+/g, " "),
		"transcrição certa, arrumada": tidy,
	};
	// Corpo de cada artigo (sem a lista de referências), página a página
	const body = id => {
		const P = docs[id].pages;
		let at = P.findIndex(p => /\b(References|REFERENCES|Bibliography|Referências)\b/.test(p));
		if (at < 0) at = P.length;
		return P.slice(0, at + 1).map((p, k) => k === at ? p.slice(0, p.search(/\b(References|REFERENCES|Bibliography|Referências)\b/)) : p);
	};

	// 1 e 2. Frases do corpo: transcrições certas e erros plantados
	const neg = q => {
		if (/\bnot\b/.test(q)) return q.replace(/\s*\bnot\b/, "");
		const m = q.match(/\b(is|are|was|were|can|may|will|should|could|would|has|have|does|do)\b/);
		return m ? q.replace(m[0], m[0] + " not") : null;
	};
	const longWords = [...vocab.keys()].filter(w => w.length >= 7);
	for (const id of ids) {
		const mine = [];
		body(id).forEach((p, k) => {
			for (const s of p.replace(/([^-])\n/g, "$1 ").split(/(?<=[.!?])\s+(?=[A-Z])/)) {
				const n = s.split(/ +/).length;
				if (n >= 12 && n <= 50 && !/https?:|doi|@|©|[≤≥=∑∈"“”«»‘’]/i.test(s) && (s.match(/(?:^|\s)\p{L}(?=\s)/gu) || []).length < 4) mine.push({ page: k + 1, s });
			}
		});
		const step = Math.max(1, Math.floor(mine.length / 40));
		for (let i = 0, got = 0; i < mine.length && got < 40; i += step, got++) {
			const x = mine[i], w = x.s.split(/ +/);
			const n = Math.min(w.length, 8 + Math.floor(rnd() * 8));
			const st = Math.floor(rnd() * (w.length - n + 1));
			const raw = w.slice(st, st + n).join(" ").replace(/^[^\p{L}\p{N}]+|[,;:.\-\n]+$/gu, "");
			for (const [name, f] of Object.entries(variants)) add(name, verdict(f(raw), id, x.page), `${id} p${x.page}: ${f(raw)}`);
			const clean = tidy(raw);
			if (verdict(clean, id, x.page) !== "ok") continue;
			const nq = neg(clean);
			if (nq) add("erro: negação", caught(nq, id, x.page), nq);
			const ws = clean.split(" ");
			const cand = ws.map((v, j) => j).filter(j => /^\p{L}{6,}$/u.test(ws[j]));
			if (cand.length) {
				const swap = j => { const c = ws.slice(); c[j] = longWords[Math.floor(rnd() * longWords.length)]; return c.join(" "); };
				const q1 = swap(cand[Math.floor(rnd() * cand.length)]);
				add("erro: uma palavra trocada", caught(q1, id, x.page), q1);
				const q2 = swap(cand[cand.length - 1]);
				add("erro: palavra trocada perto do fim", caught(q2, id, x.page), q2);
			}
			if (/\d/.test(clean)) add("erro: número trocado na transcrição", caught(clean.replace(/\d+/, d => String(+d + 3)), id, x.page));
			const np = docs[id].pages.length, far = x.page + 3 <= np ? x.page + 3 : x.page - 3;
			if (far >= 1) add("erro: página errada (3 ao lado)", caught(clean, id, far));
			const other = ids.find(o => o !== id);
			if (other) add("erro: atribuída ao artigo errado", verdict(clean, other, 1) === "noutro artigo" ? "apanhou" : "falhou");
		}
	}

	// 3. Casos difíceis
	const words = s => s.replace(/(\p{L})-\n(\p{L})/gu, "$1$2").split(/\s+/).filter(Boolean);
	for (const id of ids) {
		const P = body(id);
		for (let k = 0; k + 1 < P.length; k++) {
			const a = P[k].trim().split("\n"), b = P[k + 1].trim().split("\n");
			const last = a[a.length - 1];
			if (/[.!?:]\s*$/.test(last) || last.split(" ").length < 5) continue;
			const cont = b.slice(1, 6).find(l => /^[a-z]/.test(l));
			if (!cont) continue;
			const q = (words(last).slice(-6).join(" ") + " " + words(cont).slice(0, 6).join(" ")).replace(/[,;:.]+$/, "");
			add("certa: frase partida entre páginas", verdict(q, id, k + 1), `${id} p${k + 1}: ${q}`);
		}
		P.forEach((p, k) => {
			const flat = p.replace(/(\p{L})-\n(\p{L})/gu, "$1$2").replace(/\s+/g, " ");
			for (const m of flat.matchAll(/(\b[\p{L},'’ -]{25,90}) (\((?:[^()]{0,120}?)(?:19|20)\d{2}[a-z]?\)|\[\d[\d ,–-]*\])([.,;]? [\p{L},'’ -]{12,90})/gu)) {
				const q = (m[1].trim() + m[3].trimEnd()).replace(/[,;: ]+$/, "");
				add("certa: referência tirada do meio", verdict(q, id, k + 1), `${id} p${k + 1}: ${q}`);
			}
		});
	}

	// 4. Números fora das transcrições
	const unk = t => L.verifyAnswer(t, docs).unknownNumbers;
	for (const id of ids) {
		docs[id].pages.forEach((p, k) => {
			const seen = new Set();
			for (const m of p.matchAll(/\d+(?:[.,]\d+)?\s?%|\d+[.,]\d+/g)) {
				if (seen.size > 6) break;
				const n = m[0].replace(/\s+/g, "");
				if (seen.has(n)) continue;
				seen.add(n);
				add("número certo", unk(`O valor é ${n} [${id}:p${k + 1}].`).length ? "falso alarme" : "ok", `${id} p${k + 1}: ${n}`);
				const mut = n.replace(/(\d)(?=\D*$)/, d => String((+d + 3) % 10));
				add("erro: número trocado", unk(`O valor é ${mut} [${id}:p${k + 1}].`).length ? "apanhou" : "falhou", `${n} -> ${mut}`);
				const other = ids.find(o => o !== id);
				if (other) add("erro: número de outro artigo", unk(`O valor é ${n} [${other}:p1].`).length ? "apanhou" : "falhou", n);
			}
		});
	}

	console.log("");
	for (const [k, v] of Object.entries(tally)) {
		const tot = Object.values(v).reduce((a, b) => a + b, 0);
		const good = (v.ok || 0) + (v.apanhou || 0);
		console.log(`${k.padEnd(40)} ${String(Math.round(100 * good / tot)).padStart(3)}% certo  (n=${tot}) ${JSON.stringify(v)}`);
		for (const e of examples[k] || []) console.log("      ex.:", e.slice(0, 120));
	}
	console.log("\n(\"não lida\" numa transcrição certa é quase sempre uma frase do PDF com aspas lá dentro, que o teste não sabe citar.)");
})().catch(e => { console.error(e); process.exit(1); });
