// Ambiente simulado do Zotero para testar o núcleo do plugin em Node.
// O Subprocess usa child_process real, para testar o Claude Code verdadeiro.
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const { spawn, execSync } = require("child_process");

const ADDON = path.resolve(__dirname, "../../addon");

async function pdfText(file) {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const data = new Uint8Array(fs.readFileSync(file));
	const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
	const pages = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const tc = await page.getTextContent();
		pages.push(tc.items.map(it => it.str + (it.hasEOL ? "\n" : " ")).join(""));
	}
	// Mesmo formato do pdf-worker do Zotero: páginas separadas por \f
	return { text: pages.map(p => p + "\n\n").join("\f").trim(), totalPages: doc.numPages, extractedPages: doc.numPages };
}

function makeSubprocessShim(log) {
	function pipeReader(stream) {
		const chunks = [];
		const waiters = [];
		let ended = false;
		stream.on("data", b => {
			const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
			if (waiters.length) waiters.shift()(ab);
			else chunks.push(ab);
		});
		stream.on("end", () => {
			ended = true;
			while (waiters.length) waiters.shift()(new ArrayBuffer(0));
		});
		return {
			read() {
				if (chunks.length) return Promise.resolve(chunks.shift());
				if (ended) return Promise.resolve(new ArrayBuffer(0));
				return new Promise(r => waiters.push(r));
			},
		};
	}
	return {
		calls: [],
		async call({ command, arguments: args, environment, workdir, stderr }) {
			this.calls.push({ command, args, environment, workdir });
			log && log(`spawn ${command} ${args.join(" ")}`);
			const child = spawn(command, args, { cwd: workdir || undefined, env: environment || process.env, stdio: ["pipe", "pipe", "pipe"] });
			const exitP = new Promise(r => child.on("close", code => r({ exitCode: code == null ? -9 : code })));
			return {
				stdin: {
					write(s) { return new Promise(r => child.stdin.write(s, () => r())); },
					close() { return new Promise(r => child.stdin.end(() => r())); },
				},
				stdout: pipeReader(child.stdout),
				stderr: pipeReader(child.stderr),
				wait() { return exitP; },
				kill() { child.kill("SIGKILL"); },
			};
		},
		async pathSearch(cmd) {
			const q = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
			return execSync(q).toString().split(/\r?\n/)[0].trim();
		},
		getEnvironment() { return Object.assign({}, process.env); },
	};
}

/** Cria um "item" do Zotero simulado a partir de um PDF. */
let nextID = 100;
function makePaper({ title, date, creators, pdf, key }) {
	const parent = {
		id: nextID++, key: "P" + key, libraryID: 1, _notes: [],
		isAttachment: () => false, isRegularItem: () => true, isPDFAttachment: () => false,
		getCreators: () => creators,
		getField: f => ({ title, date, publicationTitle: "Revista de Teste" })[f] || "",
		getDisplayTitle: () => title,
		getNotes() { return this._notes; },
	};
	const att = {
		id: nextID++, key, libraryID: 1, parentItem: parent, dateModified: "2026-09-01",
		isAttachment: () => true, isRegularItem: () => false, isPDFAttachment: () => true,
		getField: f => (f === "title" ? "PDF" : ""),
		getFilePathAsync: async () => pdf,
	};
	parent.getBestAttachment = async () => att;
	parent.getAttachments = () => [att.id];
	return { parent, att };
}

function createEnv({ prefs = {}, log = null, noOSKeyStore = false } = {}) {
	const items = new Map();
	const savedNotes = [];
	const prefStore = new Map();
	// preferências por omissão lidas do prefs.js real
	const prefsSrc = fs.readFileSync(path.join(ADDON, "prefs.js"), "utf8");
	vm.runInNewContext(prefsSrc, { pref: (k, v) => prefStore.set(k, v) });
	for (const [k, v] of Object.entries(prefs)) prefStore.set("extensions.zoteroia." + k, v);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zia-"));
	const Subprocess = makeSubprocessShim(log);
	const opened = [];

	class NoteItem {
		constructor(type) { this.itemType = type; this.id = nextID++; this.relations = []; this.collections = []; }
		setNote(h) { this.html = h; }
		getNote() { return this.html; }
		getNoteTitle() { const m = /<h1>(.*?)<\/h1>/.exec(this.html || ""); return m ? m[1].replace(/&amp;/g, "&") : ""; }
		setCollections(c) { this.collections = c; }
		addRelatedItem(it) { this.relations.push(it.id); }
		async saveTx() {
			savedNotes.push(this);
			items.set(this.id, this);
			if (this.parentID) items.get(this.parentID)._notes.push(this.id);
			return this.id;
		}
	}

	const Zotero = {
		isWin: process.platform === "win32",
		locale: "pt-PT",
		debug: m => log && log("[debug] " + m),
		logError: e => console.error("[logError]", e),
		Prefs: {
			get: k => prefStore.get(k),
			set: (k, v) => prefStore.set(k, v),
		},
		Items: { get: id => items.get(id) },
		Collections: { get: id => ({ id, libraryID: 1 }) },
		Item: NoteItem,
		PDFWorker: {
			getFullText: async attID => {
				const att = items.get(attID);
				return pdfText(await att.getFilePathAsync());
			},
		},
		getTempDirectory: () => ({ path: tmp }),
		Utilities: { unescapeHTML: h => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"") },
		API: { getLibraryPrefix: () => "library" },
		Reader: { open: async (id, loc) => { opened.push({ id, loc }); } },
		File: { putContentsAsync: async (p, s) => fs.writeFileSync(p, s) },
		getMainWindow: () => null,
	};
	// Gestor de credenciais simulado (Services.logins)
	const loginStore = [];
	const logins = {
		store: loginStore,
		async searchLoginsAsync({ origin, httpRealm }) {
			return loginStore.filter(l => l.origin === origin && l.httpRealm === httpRealm);
		},
		findLogins(origin, formAction, httpRealm) {
			return loginStore.filter(l => l.origin === origin && l.httpRealm === httpRealm);
		},
		async addLoginAsync(l) { loginStore.push(l); return l; },
		removeLogin(l) { const i = loginStore.indexOf(l); if (i >= 0) loginStore.splice(i, 1); },
	};
	const ctx = {
		Zotero,
		Services: {
			env: { get: n => process.env[n] || "" },
			dirsvc: { get: () => ({ path: os.homedir() }) },
			logins,
		},
		Components: {
			interfaces: { nsIFile: {}, nsILoginInfo: {} },
			classes: {},
			Constructor: () => function LoginInfo(origin, formAction, httpRealm, username, password) {
				Object.assign(this, { origin, formAction, httpRealm, username, password });
			},
		},
		ChromeUtils: {
			importESModule: uri => {
				if (uri.includes("Subprocess")) return { Subprocess };
				if (uri.includes("OSKeyStore")) {
					if (noOSKeyStore) throw new Error("OSKeyStore indisponível");
					return { OSKeyStore: {
						encrypt: async s => Buffer.from(s).toString("base64"),
						decrypt: async s => Buffer.from(s, "base64").toString(),
					} };
				}
				throw new Error("módulo não simulado: " + uri);
			},
		},
		IOUtils: {
			exists: async p => fs.existsSync(p),
			makeDirectory: async p => fs.mkdirSync(p, { recursive: true }),
			writeUTF8: async (p, s) => fs.writeFileSync(p, s, "utf8"),
			readUTF8: async p => fs.readFileSync(p, "utf8"),
			remove: async (p, o) => fs.rmSync(p, { recursive: !!(o && o.recursive), force: true }),
			getChildren: async p => fs.readdirSync(p).map(n => path.join(p, n)),
		},
		PathUtils: { join: (...a) => path.join(...a), parent: p => path.dirname(p), filename: p => path.basename(p) },
		TextDecoder, TextEncoder, setTimeout, clearTimeout, fetch, console, AbortController,
	};
	vm.createContext(ctx);
	for (const f of ["content/i18n.js", "content/lib.js", "content/chatview.js", "content/zoteroia.js"]) {
		vm.runInContext(fs.readFileSync(path.join(ADDON, f), "utf8"), ctx, { filename: f });
	}
	const core = vm.runInContext("ZoteroIA", ctx);
	core.init({ id: "assistente-ia@sbhg.pt", version: "test", rootURI: "file://" + ADDON + "/" });

	function addPaper(spec) {
		const p = makePaper(spec);
		items.set(p.parent.id, p.parent);
		items.set(p.att.id, p.att);
		return p;
	}
	return { core, Zotero, Subprocess, addPaper, savedNotes, opened, prefStore, tmp, logins };
}

module.exports = { createEnv, pdfText };
