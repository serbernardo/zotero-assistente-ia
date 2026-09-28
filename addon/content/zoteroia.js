/*
 * Assistente IA para Zotero
 * zoteroia.js: núcleo ligado ao Zotero (documentos, motores de IA, notas, chaves).
 * Carregado pelo bootstrap.js depois de lib.js e chatview.js.
 */

/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils, ZIALib, ZIAChatView, TextDecoder */

var ZoteroIA = {
	id: null,
	version: null,
	rootURI: null,
	lib: ZIALib,
	PREF_BRANCH: "extensions.zoteroia.",
	WINDOW_TYPE: "zoteroia:chat",
	PREFS_PANE_ID: "zoteroia-prefs",
	_textCache: new Map(),
	// conversas por item (memória da sessão), para o painel lateral
	sessions: new Map(),

	// Motores disponíveis. "claude" mantém o identificador da versão 0.1 (Claude Code).
	// local: programa instalado no computador (conta do utilizador), key: chave de API
	ENGINES: {
		anthropic: { provider: "Anthropic", family: "claude", kind: "key" },
		claude: { provider: "Anthropic", family: "claude", kind: "local" },
		openai: { provider: "OpenAI", family: "openai", kind: "key" },
		codex: { provider: "OpenAI", family: "openai", kind: "local" },
		gemini: { provider: "Google", family: "gemini", kind: "key" },
	},
	ENGINE_ORDER: ["anthropic", "claude", "openai", "codex", "gemini"],

	// Chaves de API guardadas de forma segura (nunca em texto simples nas preferências)
	SECRETS: { anthropic: "anthropic.key", openai: "openai.key", gemini: "gemini.key" },
	LOGIN_ORIGIN: "chrome://zoteroia",

	API_TIMEOUT_MS: 15 * 60 * 1000,

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.ChatView = ZIAChatView;
		this.applyLanguage();
		// Migra chaves antigas guardadas sem encriptação
		this.migrateSecrets().catch(e => this.log("Migração de chaves: " + e));
	},

	/** Língua da interface: preferência ui.lang ("auto", "pt-PT" ou "en"). */
	applyLanguage() {
		let pref = "auto";
		try { pref = this.pref("ui.lang") || "auto"; }
		catch (e) { /* preferências ainda indisponíveis */ }
		return this.lib.I18N.setLang(this.lib.I18N.resolve(pref, Zotero.locale));
	},

	t(key, vars) {
		return this.lib.I18N.t(key, vars);
	},

	log(msg) {
		Zotero.debug("Assistente IA: " + msg);
	},

	pref(key) {
		return Zotero.Prefs.get(this.PREF_BRANCH + key, true);
	},

	setPref(key, value) {
		Zotero.Prefs.set(this.PREF_BRANCH + key, value, true);
	},

	error(kind, message) {
		const e = new Error(message);
		e.kind = kind;
		return e;
	},

	// ------------------------------------------------------------------
	// Documentos
	// ------------------------------------------------------------------

	/** Devolve { parent, attachment } para um item (artigo ou anexo PDF), ou null. */
	async resolvePDF(item) {
		if (!item) return null;
		if (item.isAttachment && item.isAttachment()) {
			if (!item.isPDFAttachment()) return null;
			return { parent: item.parentItem || null, attachment: item };
		}
		if (!item.isRegularItem || !item.isRegularItem()) return null;
		let best = null;
		try {
			best = await item.getBestAttachment();
		}
		catch (e) {
			this.log("getBestAttachment falhou: " + e);
		}
		if (best && best.isPDFAttachment()) return { parent: item, attachment: best };
		for (const id of item.getAttachments()) {
			const att = Zotero.Items.get(id);
			if (att && att.isPDFAttachment()) return { parent: item, attachment: att };
		}
		return null;
	},

	/** Metadados leves de um documento (sem extrair texto). */
	async describeItem(item) {
		const r = await this.resolvePDF(item);
		if (!r) return null;
		const meta = r.parent || r.attachment;
		const creators = (r.parent && r.parent.getCreators) ? r.parent.getCreators() : [];
		const author = this.lib.shortAuthor(creators);
		const year = this.lib.yearFrom(r.parent ? r.parent.getField("date") : "");
		const title = (r.parent ? r.parent.getField("title") : r.attachment.getField("title")) || this.t("ref.noTitle");
		const pub = r.parent ? (r.parent.getField("publicationTitle") || r.parent.getField("bookTitle") || r.parent.getField("publisher") || "") : "";
		const authorsFull = creators.map(c => c.lastName ? (c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName) : (c.name || "")).filter(Boolean).join("; ");
		return {
			id: null,
			kind: "pdf",
			itemID: meta.id,
			parentID: r.parent ? r.parent.id : null,
			attachmentID: r.attachment.id,
			attachmentKey: r.attachment.key,
			libraryID: r.attachment.libraryID,
			title,
			ref: `${author}, ${year}`,
			shortRef: `${author} ${year}`,
			fullRef: `${authorsFull || author} (${year}). ${title}.${pub ? " " + pub + "." : ""}`,
			pages: null,
			pagesReliable: false,
		};
	},

	/** Extrai o texto do PDF página a página (com cache em memória). */
	async loadText(doc) {
		const att = Zotero.Items.get(doc.attachmentID);
		if (!att) throw this.error("doc", this.t("err.attachmentGone", { ref: doc.ref }));
		const path = await att.getFilePathAsync();
		if (!path) {
			throw this.error("doc", this.t("err.pdfNotLocal", { ref: doc.ref }));
		}
		const cacheKey = `${att.id}:${att.dateModified}:${att.attachmentSyncedModificationTime || ""}`;
		let cached = this._textCache.get(cacheKey);
		if (!cached) {
			let result;
			try {
				result = await Zotero.PDFWorker.getFullText(att.id, null, true);
			}
			catch (e) {
				const msg = String(e && e.message || e);
				if (/password/i.test(msg)) throw this.error("doc", this.t("err.pdfPassword", { ref: doc.ref }));
				throw this.error("doc", this.t("err.pdfRead", { ref: doc.ref, e: msg }));
			}
			const split = this.lib.splitPages(result && result.text, result && result.totalPages);
			cached = {
				pages: split.pages,
				pagesReliable: split.pagesReliable,
				totalPages: (result && result.totalPages) || split.pages.length,
			};
			this._textCache.set(cacheKey, cached);
			if (this._textCache.size > 60) {
				this._textCache.delete(this._textCache.keys().next().value);
			}
		}
		const chars = cached.pages.reduce((a, p) => a + p.length, 0);
		if (chars < 200) {
			throw this.error("doc", this.t("err.pdfNoText", { ref: doc.ref, n: chars }));
		}
		doc.pages = cached.pages;
		doc.pagesReliable = cached.pagesReliable;
		doc.totalPages = cached.totalPages;
		doc.chars = chars;
		return doc;
	},

	/** Procura uma nota "Ficha IA" já existente no item. */
	findFichaNote(parentID) {
		if (!parentID) return null;
		const parent = Zotero.Items.get(parentID);
		if (!parent || !parent.getNotes) return null;
		for (const id of parent.getNotes()) {
			const note = Zotero.Items.get(id);
			const title = note && note.getNoteTitle ? note.getNoteTitle() : "";
			if (title && this.lib.FICHA_NOTE_PREFIXES.some(p => title.startsWith(p))) return note;
		}
		return null;
	},

	noteToText(note) {
		const html = note.getNote() || "";
		try {
			return Zotero.Utilities.unescapeHTML(html.replace(/<\/(p|h\d|li|tr|div)>/gi, "\n$&").replace(/<\/t[dh]>/gi, " | $&"));
		}
		catch (e) {
			return html.replace(/<[^>]+>/g, " ");
		}
	},

	/** Destaques e comentários do utilizador no PDF (página do PDF, 1-based). */
	loadAnnotations(doc) {
		const att = Zotero.Items.get(doc.attachmentID);
		if (!att || !att.getAnnotations) return [];
		let list = [];
		try {
			list = att.getAnnotations() || [];
		}
		catch (e) {
			this.log("getAnnotations: " + e);
			return [];
		}
		const out = [];
		for (const a of list) {
			const text = String(a.annotationText || "").replace(/\s+/g, " ").trim().slice(0, 1500);
			const comment = String(a.annotationComment || "").replace(/\s+/g, " ").trim().slice(0, 1500);
			if (!text && !comment) continue;
			let page = null;
			try {
				const pos = JSON.parse(a.annotationPosition || "{}");
				if (typeof pos.pageIndex === "number") page = pos.pageIndex + 1;
			}
			catch (e) { /* sem posição */ }
			out.push({ page, text, comment, sort: a.annotationSortIndex || "" });
		}
		out.sort((x, y) => (x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : 0));
		return out;
	},

	/** Adiciona etiquetas a um item. Devolve quantas eram novas. */
	async addTags(itemID, tags) {
		const item = Zotero.Items.get(itemID);
		if (!item) throw new Error("item não encontrado");
		let added = 0;
		for (const t of tags || []) {
			const name = String(t || "").trim().slice(0, 100);
			if (!name) continue;
			if (item.addTag(name)) added++;
		}
		if (added) await item.saveTx();
		return added;
	},

	/** Itens (artigos) da coleção selecionada na biblioteca. */
	selectedCollectionItems() {
		const zp = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
		if (!zp) return { name: null, items: [] };
		let col = null;
		try { col = zp.getSelectedCollection && zp.getSelectedCollection(); }
		catch (e) { /* sem coleção */ }
		if (!col) return { name: null, items: [] };
		let items = [];
		try { items = col.getChildItems(false) || []; }
		catch (e) { this.log("getChildItems: " + e); }
		return { name: col.name, id: col.id, items: items.filter(i => i.isRegularItem() || (i.isAttachment() && i.isPDFAttachment())) };
	},

	// ------------------------------------------------------------------
	// Motor 1: Claude (subscrição Pro através do Claude Code instalado)
	// ------------------------------------------------------------------

	get Subprocess() {
		if (!this._subprocess) {
			this._subprocess = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
		}
		return this._subprocess;
	},

	homeDir() {
		try {
			return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
		}
		catch (e) {
			return Services.env.get(Zotero.isWin ? "USERPROFILE" : "HOME");
		}
	},

	/** Locais habituais de um programa de linha de comandos (claude ou codex). */
	toolCandidates(name) {
		const home = this.homeDir();
		const env = n => { try { return Services.env.get(n); } catch (e) { return ""; } };
		if (Zotero.isWin) {
			const appData = env("APPDATA");
			const localAppData = env("LOCALAPPDATA");
			return [
				PathUtils.join(home, ".local", "bin", name + ".exe"),
				localAppData && PathUtils.join(localAppData, "Microsoft", "WinGet", "Links", name + ".exe"),
				appData && PathUtils.join(appData, "npm", name + ".cmd"),
			].filter(Boolean);
		}
		const list = [
			PathUtils.join(home, ".local", "bin", name),
			"/opt/homebrew/bin/" + name,
			"/usr/local/bin/" + name,
			"/usr/bin/" + name,
			PathUtils.join(home, ".npm-global", "bin", name),
		];
		if (name === "claude") list.push(PathUtils.join(home, ".claude", "local", "claude"));
		return list;
	},

	claudeCandidates() {
		return this.toolCandidates("claude");
	},

	/** Cópia do Claude Code descarregada pela aplicação Claude para computador (versão mais recente). */
	async bundledClaudeCandidates() {
		const env = n => { try { return Services.env.get(n); } catch (e) { return ""; } };
		const base = Zotero.isWin
			? (env("APPDATA") && PathUtils.join(env("APPDATA"), "Claude", "claude-code"))
			: Zotero.isMac ? PathUtils.join(this.homeDir(), "Library", "Application Support", "Claude", "claude-code") : null;
		if (!base) return [];
		let dirs = [];
		try { dirs = await IOUtils.getChildren(base); }
		catch (e) { return []; }
		const ver = p => PathUtils.filename(p).split(/[.\-]/).map(n => parseInt(n, 10) || 0);
		dirs.sort((a, b) => {
			const va = ver(a), vb = ver(b);
			for (let i = 0; i < Math.max(va.length, vb.length); i++) {
				if ((vb[i] || 0) !== (va[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
			}
			return 0;
		});
		return dirs.map(d => PathUtils.join(d, Zotero.isWin ? "claude.exe" : "claude"));
	},

	_toolCache: {},

	/** Localiza o executável de um programa (definição manual, locais habituais, PATH). */
	async findToolExecutable(name) {
		const label = name === "codex" ? "Codex" : "Claude Code";
		const manual = (this.pref(name + ".path") || "").trim();
		if (manual) {
			if (await IOUtils.exists(manual)) return manual;
			this.setPref(name + ".enabled", false);
			throw this.error("notfound", this.t("err.pathMissing", { tool: label, path: manual }));
		}
		const cached = this._toolCache[name];
		if (cached && await IOUtils.exists(cached)) return cached;
		const firstExisting = async list => {
			for (const p of list) {
				try {
					if (await IOUtils.exists(p)) return p;
				}
				catch (e) { /* caminho inválido nesta plataforma */ }
			}
			return null;
		};
		let found = await firstExisting(this.toolCandidates(name));
		const names = Zotero.isWin ? [name + ".exe", name + ".cmd"] : [name];
		for (const n of names) {
			if (found) break;
			try { found = await this.Subprocess.pathSearch(n); }
			catch (e) { /* não está no PATH */ }
		}
		if (!found && name === "claude") found = await firstExisting(await this.bundledClaudeCandidates());
		if (found) {
			this._toolCache[name] = found;
			return found;
		}
		this.setPref(name + ".enabled", false);
		throw this.error("notfound", this.t(name === "codex" ? "err.codexNotFound" : "err.claudeNotFound"));
	},

	findClaudeExecutable() {
		return this.findToolExecutable("claude");
	},

	get _claudePathCache() {
		return this._toolCache.claude || null;
	},

	set _claudePathCache(v) {
		this._toolCache.claude = v;
	},

	/**
	 * No Windows, os programas instalados pelo npm são ficheiros .cmd, que não se podem
	 * executar sem a linha de comandos. Lê o .cmd e devolve o node e o script JavaScript,
	 * para os chamar diretamente (sem cmd.exe, sem risco de interpretação de argumentos).
	 */
	async resolveCmdShim(cmdPath) {
		const text = await IOUtils.readUTF8(cmdPath);
		const m = /"%~?dp0%?\\([^"]+?\.(?:js|mjs|cjs))"/i.exec(text);
		if (!m) throw this.error("notfound", this.t("err.pathMissing", { tool: cmdPath, path: cmdPath }));
		const dir = PathUtils.parent(cmdPath);
		const script = PathUtils.join(dir, ...m[1].split("\\"));
		let node = PathUtils.join(dir, "node.exe");
		if (!(await IOUtils.exists(node))) {
			node = await this.Subprocess.pathSearch("node.exe");
		}
		return { command: node, prefix: [script] };
	},

	async workDir() {
		const dir = PathUtils.join(Zotero.getTempDirectory().path, "zoteroia");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	/** Corre um comando e devolve { exitCode, stdout, stderr } (para testes e versão). */
	async runProcess(command, args, { stdin = null, env = null, workdir = null, onStdout = null, signal = null, timeoutMs = 0, killRef = null } = {}) {
		const Subprocess = this.Subprocess;
		if (Zotero.isWin && /\.(cmd|bat)$/i.test(command)) {
			const shim = await this.resolveCmdShim(command);
			command = shim.command;
			args = shim.prefix.concat(args);
		}
		const opts = { command, arguments: args, stderr: "pipe" };
		if (env) opts.environment = env;
		if (workdir) opts.workdir = workdir;
		const proc = await Subprocess.call(opts);
		let killed = false;
		const kill = () => {
			if (killed) return;
			killed = true;
			try { proc.kill(); } catch (e) { /* já terminou */ }
		};
		let onAbort = null;
		if (signal) {
			if (signal.aborted) kill();
			onAbort = () => kill();
			signal.addEventListener("abort", onAbort);
		}
		if (killRef) killRef.kill = kill;
		let timer = null;
		if (timeoutMs) timer = setTimeout(kill, timeoutMs);
		const readAll = async (pipe, cb) => {
			// Lê bytes até ao fim (buffer vazio) e descodifica em modo contínuo,
			// para não cortar caracteres acentuados entre blocos
			const dec = new TextDecoder("utf-8");
			let out = "";
			for (;;) {
				let buf;
				try {
					buf = await pipe.read();
				}
				catch (e) {
					break;
				}
				if (!buf || !buf.byteLength) break;
				const s = dec.decode(buf, { stream: true });
				if (s) {
					out += s;
					if (cb) cb(s);
				}
			}
			const tail = dec.decode();
			if (tail) {
				out += tail;
				if (cb) cb(tail);
			}
			return out;
		};
		const outP = readAll(proc.stdout, onStdout);
		const errP = readAll(proc.stderr, null);
		try {
			if (stdin != null) await proc.stdin.write(stdin);
			await proc.stdin.close();
		}
		catch (e) {
			this.log("Erro ao escrever no stdin: " + e);
		}
		const [stdout, stderr] = await Promise.all([outP, errP]);
		const { exitCode } = await proc.wait();
		if (timer) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		return { exitCode, stdout, stderr, killed, aborted: !!(signal && signal.aborted) };
	},

	claudeArgs(model, sysPath, dropped) {
		const args = [
			"-p",
			"--output-format", "stream-json",
			"--verbose",
			"--include-partial-messages",
			"--no-session-persistence",
			"--tools=",
			"--strict-mcp-config",
			"--safe-mode",
			"--model", model || "sonnet",
			"--system-prompt-file", sysPath,
		];
		// Remove opções que uma versão antiga não reconheça
		const out = [];
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			const name = a.split("=")[0];
			if (dropped.has(name)) continue;
			out.push(a);
		}
		return out;
	},

	async runClaude({ system, prompt, model, onDelta, onInfo, signal }) {
		const exe = await this.findClaudeExecutable();
		const dir = await this.workDir();
		// Nome único: o painel e a janela podem fazer pedidos ao mesmo tempo
		const sysPath = PathUtils.join(dir, `instrucoes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
		await IOUtils.writeUTF8(sysPath, system);
		try {
			const env = this.Subprocess.getEnvironment();
			if (this.pref("claude.ignoreApiKey")) {
				// Garante que a subscrição é usada, e não uma chave de API paga por uso
				delete env.ANTHROPIC_API_KEY;
				delete env.ANTHROPIC_AUTH_TOKEN;
			}
			const optional = new Set(["--safe-mode", "--include-partial-messages", "--strict-mcp-config", "--no-session-persistence"]);
			const dropped = new Set();
			for (let attempt = 0; attempt < 4; attempt++) {
				const parser = this.lib.createClaudeStreamParser((delta, all) => onDelta && onDelta(delta, all));
				const res = await this.runProcess(exe, this.claudeArgs(model, sysPath, dropped), {
					stdin: prompt,
					env,
					workdir: dir,
					onStdout: chunk => parser.push(chunk),
					signal,
					timeoutMs: 20 * 60 * 1000,
				});
				const state = parser.end();
				if (res.aborted) throw this.error("aborted", this.t("err.aborted"));
				if (state.rateLimit && onInfo) onInfo({ rateLimit: state.rateLimit });
				if (state.result !== null && !state.isError) {
					return { text: state.result || state.text, model: state.model, usage: state.usage, rateLimit: state.rateLimit };
				}
				const errText = state.errorText || res.stderr || res.stdout || `O Claude Code terminou com o código ${res.exitCode}.`;
				const unknown = /unknown option '([^']+)'/i.exec(errText);
				if (unknown && optional.has(unknown[1]) && !dropped.has(unknown[1])) {
					this.log(`Claude Code não reconhece ${unknown[1]}; a repetir sem essa opção`);
					dropped.add(unknown[1]);
					continue;
				}
				if (state.text && !state.isError && res.exitCode === 0) {
					return { text: state.text, model: state.model };
				}
				const c = this.lib.classifyClaudeError(errText);
				throw this.error(c.kind, c.message);
			}
			throw this.error("version", this.t("err.tooOld", { tool: "Claude Code" }));
		}
		finally {
			try { if (IOUtils.remove) await IOUtils.remove(sysPath); }
			catch (e) { /* ficheiro temporário */ }
		}
	},

	/** Teste rápido: versão e um pedido mínimo. */
	async testClaude() {
		const exe = await this.findClaudeExecutable();
		const v = await this.runProcess(exe, ["--version"], { timeoutMs: 30000 });
		const version = (v.stdout || v.stderr || "").trim();
		const r = await this.runClaude({
			system: this.t("test.reply"),
			prompt: this.t("test.prompt"),
			model: this.pref("claude.model") || "sonnet",
		});
		this.setPref("claude.enabled", true);
		return { path: exe, version, reply: (r.text || "").trim().slice(0, 80), model: r.model };
	},

	// ------------------------------------------------------------------
	// Motor 2: Gemini (API do Google, quota gratuita ou paga)
	// ------------------------------------------------------------------

	get OSKeyStore() {
		if (this._osKeyStore === undefined) {
			try {
				this._osKeyStore = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs").OSKeyStore;
			}
			catch (e) {
				this._osKeyStore = null;
			}
		}
		return this._osKeyStore;
	},

	// ------------------------------------------------------------------
	// Cofre de chaves
	// 1. Cofre do sistema operativo (OSKeyStore: Windows, macOS, Linux com libsecret):
	//    nas preferências fica só o texto encriptado ("oskv1:...").
	// 2. Reserva: gestor de credenciais do Zotero (o mesmo que guarda a chave de
	//    sincronização): nas preferências fica só a marca "login:".
	// Nunca se guarda a chave em texto simples.
	// ------------------------------------------------------------------

	_secretPref(name) {
		const p = this.SECRETS[name];
		if (!p) throw new Error("Segredo desconhecido: " + name);
		return p;
	},

	_loginRealm(name) {
		return "Assistente IA: " + name;
	},

	async _loginFind(name) {
		const logins = Services.logins;
		if (!logins) return [];
		const realm = this._loginRealm(name);
		try {
			if (logins.searchLoginsAsync) {
				return await logins.searchLoginsAsync({ origin: this.LOGIN_ORIGIN, httpRealm: realm });
			}
		}
		catch (e) {
			this.log("searchLoginsAsync: " + e);
		}
		return logins.findLogins(this.LOGIN_ORIGIN, null, realm) || [];
	},

	async _loginSet(name, value) {
		const logins = Services.logins;
		if (!logins) throw new Error("gestor de credenciais indisponível");
		for (const l of await this._loginFind(name)) {
			try { logins.removeLogin(l); } catch (e) { /* já removida */ }
		}
		if (!value) return;
		const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
			Components.interfaces.nsILoginInfo, "init");
		const info = new LoginInfo(this.LOGIN_ORIGIN, null, this._loginRealm(name), name, value, "", "");
		if (logins.addLoginAsync) await logins.addLoginAsync(info);
		else logins.addLogin(info);
	},

	/** Guarda uma chave de API. Devolve "encrypted", "login" ou "empty". */
	async setSecret(name, value) {
		const prefKey = this._secretPref(name);
		value = String(value || "").trim();
		// apaga sempre a cópia anterior no gestor de credenciais
		try { await this._loginSet(name, ""); } catch (e) { /* sem gestor */ }
		if (!value) {
			this.setPref(prefKey, "");
			return "empty";
		}
		const ks = this.OSKeyStore;
		if (ks) {
			try {
				const enc = await ks.encrypt(value);
				this.setPref(prefKey, "oskv1:" + enc);
				return "encrypted";
			}
			catch (e) {
				this.log("OSKeyStore indisponível: " + e);
			}
		}
		try {
			await this._loginSet(name, value);
			this.setPref(prefKey, "login:");
			return "login";
		}
		catch (e) {
			this.log("Gestor de credenciais indisponível: " + e);
		}
		// a preferência fica como estava (não se perde uma chave já guardada)
		throw this.error("auth", this.t("err.secureStore"));
	},

	async getSecret(name) {
		const v = this.pref(this._secretPref(name)) || "";
		if (!v) return "";
		const label = this.t("key." + name);
		if (v.startsWith("oskv1:")) {
			const ks = this.OSKeyStore;
			if (!ks) throw this.error("auth", this.t("err.keyStoreOpen", { label }));
			try {
				return (await ks.decrypt(v.slice(6))).trim();
			}
			catch (e) {
				throw this.error("auth", this.t("err.keyDecrypt", { label }));
			}
		}
		if (v.startsWith("login:")) {
			const found = await this._loginFind(name);
			if (!found.length) throw this.error("auth", this.t("err.keyGone", { label }));
			return String(found[0].password || "").trim();
		}
		// formato antigo (0.1): texto simples, migrado no arranque
		if (v.startsWith("plain:")) return v.slice(6);
		return v;
	},

	/** Estado de uma chave, sem a desencriptar: "none", "encrypted", "login" ou "plain". */
	secretState(name) {
		const v = this.pref(this._secretPref(name)) || "";
		if (!v) return "none";
		if (v.startsWith("oskv1:")) return "encrypted";
		if (v.startsWith("login:")) return "login";
		return "plain";
	},

	hasSecret(name) {
		return this.secretState(name) !== "none";
	},

	/** Chaves em texto simples (versão 0.1) passam para o cofre. */
	async migrateSecrets() {
		for (const name of Object.keys(this.SECRETS)) {
			if (this.secretState(name) !== "plain") continue;
			const key = await this.getSecret(name);
			try {
				await this.setSecret(name, key);
				this.log(`Chave ${name} migrada para armazenamento seguro`);
			}
			catch (e) {
				this.log(`Não foi possível migrar a chave ${name}: ${e}`);
			}
		}
	},

	async clearAllSecrets() {
		for (const name of Object.keys(this.SECRETS)) await this.setSecret(name, "");
	},

	// Compatibilidade com a versão 0.1
	setGeminiKey(key) {
		return this.setSecret("gemini", key);
	},

	getGeminiKey() {
		return this.getSecret("gemini");
	},

	/** fetch com cancelamento pelo utilizador e tempo limite. */
	async _fetch(win, url, opts, signal) {
		// O ambiente do plugin não tem AbortController: usa o de uma janela do Zotero
		const w = win || (Zotero.getMainWindow && Zotero.getMainWindow());
		const f = (w && w.fetch) ? w.fetch.bind(w) : fetch;
		const AC = (w && w.AbortController) || (typeof AbortController !== "undefined" ? AbortController : null);
		if (!AC) {
			const res = await f(url, Object.assign({}, opts, signal ? { signal } : {}));
			return { res, cleanup: () => {}, ctrl: null };
		}
		const ctrl = new AC();
		const onAbort = () => ctrl.abort();
		if (signal) {
			if (signal.aborted) ctrl.abort();
			else signal.addEventListener("abort", onAbort);
		}
		const timer = setTimeout(() => ctrl.abort(), this.API_TIMEOUT_MS);
		const cleanup = () => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		try {
			const res = await f(url, Object.assign({}, opts, { signal: ctrl.signal }));
			return { res, cleanup, ctrl };
		}
		catch (e) {
			cleanup();
			throw e;
		}
	},

	/** Lê um corpo em fluxo (SSE) e passa os pedaços ao parser. */
	async _readStream(res, parser) {
		const reader = res.body.getReader();
		const dec = new TextDecoder("utf-8");
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parser.push(dec.decode(value, { stream: true }));
		}
		parser.push(dec.decode());
	},

	geminiModel() {
		return String(this.pref("gemini.model") || "gemini-3.8-flash").replace(/^models\//, "").trim();
	},

	GEMINI_RETRY_MS: [2000, 5000],

	_sleep(ms, signal) {
		return new Promise(resolve => {
			const timer = setTimeout(resolve, ms);
			if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
		});
	},

	/**
	 * Gemini com tolerância a sobrecarga (erros 500 a 504): repete o pedido e, se o modelo
	 * continuar indisponível, tenta até dois modelos flash alternativos da mesma conta.
	 */
	async runGemini({ system, prompt, model, onDelta, signal, win }) {
		const key = await this.getSecret("gemini");
		if (!key) {
			throw this.error("auth", this.t("err.noKey", { label: this.t("key.gemini") }));
		}
		model = String(model || this.geminiModel()).replace(/^models\//, "");
		let streamed = false;
		const opts = { system, prompt, signal, win, key, onDelta: (d, all) => { streamed = true; if (onDelta) onDelta(d, all); } };
		const retryable = e => e.kind === "busy" && !streamed && !(signal && signal.aborted);
		let lastErr;
		for (let i = 0; i <= this.GEMINI_RETRY_MS.length; i++) {
			try { return await this._geminiOnce(model, opts); }
			catch (e) {
				if (!retryable(e)) throw e;
				lastErr = e;
				if (i < this.GEMINI_RETRY_MS.length) {
					this.log(`Gemini ${model} sobrecarregado, nova tentativa em ${this.GEMINI_RETRY_MS[i]} ms`);
					await this._sleep(this.GEMINI_RETRY_MS[i], signal);
				}
			}
		}
		let alternatives = [];
		try { alternatives = this.lib.geminiFallbacks(model, await this.listGeminiModels(win)); }
		catch (e) { this.log("Lista de modelos Gemini: " + e); }
		for (const alt of alternatives) {
			try {
				this.log(`Gemini: a tentar o modelo alternativo ${alt}`);
				return await this._geminiOnce(alt, opts);
			}
			catch (e) {
				if (!retryable(e)) throw e;
				lastErr = e;
			}
		}
		throw lastErr;
	},

	async _geminiOnce(model, { system, prompt, onDelta, signal, win, key }) {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
		const body = {
			systemInstruction: { parts: [{ text: system }] },
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			generationConfig: { temperature: 0.2 },
		};
		let res, cleanup;
		try {
			({ res, cleanup } = await this._fetch(win, url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-goog-api-key": key },
				body: JSON.stringify(body),
			}, signal));
		}
		catch (e) {
			if (signal && signal.aborted) throw this.error("aborted", this.t("err.aborted"));
			throw this.error("network", this.t("err.network", { provider: "Gemini", e }));
		}
		try {
			if (!res.ok) {
				const t = await res.text();
				const c = this.lib.classifyGeminiError(res.status, t);
				throw this.error(c.kind, c.message);
			}
			const parser = this.lib.createGeminiSSEParser((d, all) => onDelta && onDelta(d, all));
			try {
				await this._readStream(res, parser);
			}
			catch (e) {
				if (signal && signal.aborted) throw this.error("aborted", this.t("err.aborted"));
				throw this.error("network", this.t("err.interrupted", { provider: "Gemini", e }));
			}
			const st = parser.end();
			if (st.error) {
				const c = this.lib.classifyGeminiError(st.error.code || 500, JSON.stringify({ error: st.error }));
				throw this.error(c.kind, c.message);
			}
			if (!st.text) {
				if (st.blockReason) throw this.error("blocked", this.t("err.geminiBlocked", { reason: st.blockReason }));
				if (st.finishReason && st.finishReason !== "STOP") throw this.error("blocked", this.t("err.geminiStopped", { reason: st.finishReason }));
				throw this.error("other", this.t("err.noText", { engine: "Gemini" }));
			}
			let text = st.text;
			if (st.finishReason === "MAX_TOKENS") {
				text += "\n\n> " + this.t("err.cut");
			}
			return { text, model, usage: st.usage };
		}
		finally {
			cleanup();
		}
	},

	async listGeminiModels(win) {
		const key = await this.getSecret("gemini");
		if (!key) throw this.error("auth", this.t("err.saveKeyFirst", { label: this.t("key.gemini") }));
		const { res, cleanup } = await this._fetch(win, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
			headers: { "x-goog-api-key": key },
		});
		try {
			const t = await res.text();
			if (!res.ok) {
				const c = this.lib.classifyGeminiError(res.status, t);
				throw this.error(c.kind, c.message);
			}
			const j = JSON.parse(t);
			return (j.models || [])
				.filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
				.map(m => m.name.replace(/^models\//, ""))
				.filter(n => /gemini/i.test(n) && !/(embedding|tts|image|live|audio|robotics|transcribe|omni)/i.test(n));
		}
		finally {
			cleanup();
		}
	},

	// ------------------------------------------------------------------
	// Motor 3: Claude através da API oficial da Anthropic (chave do utilizador)
	// ------------------------------------------------------------------

	ANTHROPIC_URL: "https://api.anthropic.com/v1",
	ANTHROPIC_MODELS: [
		{ id: "claude-opus-5", label: "Claude Opus 5", tier: "best" },
		{ id: "claude-sonnet-5", label: "Claude Sonnet 5", tier: "balanced" },
		{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "fast" },
	],

	anthropicModel() {
		const m = String(this.pref("anthropic.model") || "claude-opus-5").trim();
		return /^[a-z0-9][a-z0-9._-]{2,80}$/i.test(m) ? m : "claude-opus-5";
	},

	_anthropicHeaders(key) {
		return {
			"content-type": "application/json",
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
			// o pedido parte do próprio computador do utilizador, com a chave dele
			"anthropic-dangerous-direct-browser-access": "true",
		};
	},

	async runAnthropic({ system, prompt, promptParts, model, onDelta, signal, win }) {
		const key = await this.getSecret("anthropic");
		if (!key) {
			throw this.error("auth", this.t("err.noKey", { label: this.t("key.anthropic") }));
		}
		model = model || this.anthropicModel();
		// Os documentos ficam num bloco próprio, guardado em cache: as perguntas
		// seguintes sobre os mesmos PDFs custam muito menos.
		const content = promptParts
			? [
				{ type: "text", text: promptParts.docs, cache_control: { type: "ephemeral" } },
				{ type: "text", text: promptParts.rest },
			]
			: [{ type: "text", text: prompt }];
		const body = {
			model,
			max_tokens: 32000,
			stream: true,
			system,
			messages: [{ role: "user", content }],
		};
		const headers = this._anthropicHeaders(key);
		// Nos modelos com classificadores de segurança, uma recusa passa para outro modelo
		let useFallbacks = /^claude-(opus-5|fable)/.test(model);
		for (let attempt = 0; attempt < 2; attempt++) {
			const h = Object.assign({}, headers);
			const b = Object.assign({}, body);
			if (useFallbacks) {
				h["anthropic-beta"] = "server-side-fallback-2026-07-01";
				b.fallbacks = "default";
			}
			let res, cleanup;
			try {
				({ res, cleanup } = await this._fetch(win, this.ANTHROPIC_URL + "/messages", {
					method: "POST", headers: h, body: JSON.stringify(b),
				}, signal));
			}
			catch (e) {
				if (signal && signal.aborted) throw this.error("aborted", this.t("err.aborted"));
				throw this.error("network", this.t("err.network", { provider: "Anthropic", e }));
			}
			try {
				if (!res.ok) {
					const t = await res.text();
					if (useFallbacks && res.status === 400 && /fallback|anthropic-beta/i.test(t)) {
						this.log("Recusa com reserva não suportada: a repetir sem ela");
						useFallbacks = false;
						continue;
					}
					const c = this.lib.classifyAnthropicError(res.status, t);
					throw this.error(c.kind, c.message);
				}
				const parser = this.lib.createAnthropicSSEParser((d, all) => onDelta && onDelta(d, all));
				try {
					await this._readStream(res, parser);
				}
				catch (e) {
					if (signal && signal.aborted) throw this.error("aborted", this.t("err.aborted"));
					throw this.error("network", this.t("err.interrupted", { provider: "Anthropic", e }));
				}
				const st = parser.end();
				if (st.error) {
					const c = this.lib.classifyAnthropicError(0, { error: st.error });
					throw this.error(c.kind, c.message);
				}
				if (st.stopReason === "refusal" && !st.text) {
					throw this.error("blocked", this.t("err.refusal", { engine: "Claude" }));
				}
				if (!st.text) throw this.error("other", this.t("err.noText", { engine: "Claude" }));
				let text = st.text;
				if (st.stopReason === "max_tokens") {
					text += "\n\n> " + this.t("err.cut");
				}
				else if (st.stopReason === "refusal") {
					text += "\n\n> " + this.t("err.refusalCut");
				}
				return { text, model: st.model || model, usage: st.usage };
			}
			finally {
				cleanup();
			}
		}
		throw this.error("other", this.t("err.failed", { provider: "Anthropic" }));
	},

	/** Lista os modelos da conta (serve também para testar a chave, sem gastar tokens). */
	async listAnthropicModels(win) {
		const key = await this.getSecret("anthropic");
		if (!key) throw this.error("auth", this.t("err.saveKeyFirst", { label: this.t("key.anthropic") }));
		const h = this._anthropicHeaders(key);
		delete h["content-type"];
		const { res, cleanup } = await this._fetch(win, this.ANTHROPIC_URL + "/models?limit=100", { headers: h });
		try {
			const t = await res.text();
			if (!res.ok) {
				const c = this.lib.classifyAnthropicError(res.status, t);
				throw this.error(c.kind, c.message);
			}
			const j = JSON.parse(t);
			return (j.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }));
		}
		finally {
			cleanup();
		}
	},

	// ------------------------------------------------------------------
	// Motor 4: ChatGPT através da API da OpenAI (chave do utilizador)
	// ------------------------------------------------------------------

	OPENAI_URL: "https://api.openai.com/v1",
	OPENAI_MODELS: [
		{ id: "gpt-6-sol", label: "GPT-6 Sol", tier: "balanced" },
		{ id: "gpt-6-astra", label: "GPT-6 Astra", tier: "best" },
		{ id: "gpt-6-luna", label: "GPT-6 Luna", tier: "fast" },
	],

	openaiModel() {
		const m = String(this.pref("openai.model") || "gpt-6-sol").trim();
		return /^[a-z0-9][a-z0-9._:-]{1,80}$/i.test(m) ? m : "gpt-6-sol";
	},

	async runOpenAI({ system, prompt, model, onDelta, signal, win }) {
		const key = await this.getSecret("openai");
		if (!key) throw this.error("auth", this.t("err.noKey", { label: this.t("key.openai") }));
		model = model || this.openaiModel();
		// A OpenAI guarda automaticamente em cache o início repetido do pedido (os documentos)
		const body = {
			model,
			stream: true,
			stream_options: { include_usage: true },
			max_completion_tokens: 32000,
			messages: [
				{ role: "developer", content: system },
				{ role: "user", content: prompt },
			],
		};
		let res, cleanup;
		try {
			({ res, cleanup } = await this._fetch(win, this.OPENAI_URL + "/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
				body: JSON.stringify(body),
			}, signal));
		}
		catch (e) {
			if (signal && signal.aborted) throw this.error("aborted", this.t("err.aborted"));
			throw this.error("network", this.t("err.network", { provider: "OpenAI", e }));
		}
		try {
			if (!res.ok) {
				const c = this.lib.classifyOpenAIError(res.status, await res.text());
				throw this.error(c.kind, c.message);
			}
			const parser = this.lib.createOpenAISSEParser((d, all) => onDelta && onDelta(d, all));
			try {
				await this._readStream(res, parser);
			}
			catch (e) {
				if (signal && signal.aborted) throw this.error("aborted", this.t("err.aborted"));
				throw this.error("network", this.t("err.interrupted", { provider: "OpenAI", e }));
			}
			const st = parser.end();
			if (st.error) {
				const c = this.lib.classifyOpenAIError(0, { error: st.error });
				throw this.error(c.kind, c.message);
			}
			if (!st.text) {
				if (st.refusal || st.finishReason === "content_filter") throw this.error("blocked", this.t("err.refusal", { engine: "ChatGPT" }));
				throw this.error("other", this.t("err.noText", { engine: "ChatGPT" }));
			}
			let text = st.text;
			if (st.finishReason === "length") text += "\n\n> " + this.t("err.cut");
			else if (st.finishReason === "content_filter") text += "\n\n> " + this.t("err.refusalCut");
			return { text, model: st.model || model, usage: st.usage };
		}
		finally {
			cleanup();
		}
	},

	/** Lista os modelos da conta (serve para testar a chave, sem gastar tokens). */
	async listOpenAIModels(win) {
		const key = await this.getSecret("openai");
		if (!key) throw this.error("auth", this.t("err.saveKeyFirst", { label: this.t("key.openai") }));
		const { res, cleanup } = await this._fetch(win, this.OPENAI_URL + "/models", {
			headers: { "Authorization": "Bearer " + key },
		});
		try {
			const txt = await res.text();
			if (!res.ok) {
				const c = this.lib.classifyOpenAIError(res.status, txt);
				throw this.error(c.kind, c.message);
			}
			const j = JSON.parse(txt);
			return (j.data || [])
				.map(m => m.id)
				.filter(id => /^(gpt|o\d|chatgpt)/i.test(id) && !/(audio|realtime|transcribe|tts|image|embedding|search|moderation|instruct)/i.test(id))
				.sort()
				.map(id => ({ id, label: id }));
		}
		finally {
			cleanup();
		}
	},

	// ------------------------------------------------------------------
	// Motor 5: ChatGPT com a conta do utilizador (gratuita ou paga), através do Codex
	// O Codex é o programa oficial da OpenAI. Cada pessoa inicia sessão uma vez com
	// "codex login". O assistente corre-o sem ferramentas: sandbox só de leitura, numa
	// pasta temporária vazia, e interrompe o pedido se o Codex tentar usar uma ferramenta.
	// ------------------------------------------------------------------

	findCodexExecutable() {
		return this.findToolExecutable("codex");
	},

	codexArgs(model, dropped) {
		const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never"];
		if (model) args.push("--model", model);
		const out = [];
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (dropped.has(a)) {
				// opção com valor: salta também o valor
				if (a === "--color") i++;
				continue;
			}
			out.push(a);
		}
		return out;
	},

	codexModel() {
		const m = String(this.pref("codex.model") || "").trim();
		return /^[a-z0-9][a-z0-9._:-]{1,80}$/i.test(m) ? m : "";
	},

	async runCodex({ system, prompt, model, onDelta, signal }) {
		const exe = await this.findCodexExecutable();
		const dir = PathUtils.join(await this.workDir(), "codex-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		// O Codex não tem opção para instruções de sistema próprias: vão no início do pedido
		const input = "<instrucoes_de_sistema>\n" + system
			+ "\nResponde apenas com texto. Não executes comandos, não leias nem escrevas ficheiros e não pesquises na Internet."
			+ "\n</instrucoes_de_sistema>\n\n" + prompt;
		const env = this.Subprocess.getEnvironment();
		// Garante o uso da conta ChatGPT, e não de uma chave de API paga por uso
		if (this.pref("claude.ignoreApiKey") !== false) {
			delete env.OPENAI_API_KEY;
			delete env.CODEX_API_KEY;
		}
		const optional = new Set(["--ephemeral", "--color"]);
		const dropped = new Set();
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				const killRef = {};
				let toolUsed = null;
				const parser = this.lib.createCodexStreamParser(
					(d, all) => onDelta && onDelta(d, all),
					tool => {
						toolUsed = tool;
						if (killRef.kill) killRef.kill();
					});
				const res = await this.runProcess(exe, this.codexArgs(model || this.codexModel(), dropped), {
					stdin: input,
					env,
					workdir: dir,
					onStdout: chunk => parser.push(chunk),
					signal,
					timeoutMs: 20 * 60 * 1000,
					killRef,
				});
				const st = parser.end();
				if (res.aborted) throw this.error("aborted", this.t("err.aborted"));
				if (toolUsed || st.tool) throw this.error("blocked", this.t("err.toolBlocked", { tool: toolUsed || st.tool }));
				if (st.text && !st.error) return { text: st.text, model: model || this.codexModel() || "codex", usage: st.usage };
				const errText = st.error || res.stderr || res.stdout || this.t("err.exitCode", { tool: "Codex", code: res.exitCode });
				const unknown = /unexpected argument '([^']+)'|unknown option '?([-\w]+)/i.exec(errText);
				const flag = unknown && (unknown[1] || unknown[2]);
				if (flag && optional.has(flag) && !dropped.has(flag)) {
					this.log(`Codex não reconhece ${flag}; a repetir sem essa opção`);
					dropped.add(flag);
					continue;
				}
				const c = this.lib.classifyCodexError(errText);
				throw this.error(c.kind, c.message);
			}
			throw this.error("version", this.t("err.tooOld", { tool: "Codex" }));
		}
		finally {
			try { if (IOUtils.remove) await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }); }
			catch (e) { /* pasta temporária */ }
		}
	},

	/** Teste rápido: versão e um pedido mínimo. Ativa o motor quando corre bem. */
	async testCodex() {
		const exe = await this.findCodexExecutable();
		const v = await this.runProcess(exe, ["--version"], { timeoutMs: 30000 });
		const version = (v.stdout || v.stderr || "").trim();
		const r = await this.runCodex({ system: this.t("test.reply"), prompt: this.t("test.prompt") });
		this.setPref("codex.enabled", true);
		return { path: exe, version, reply: (r.text || "").trim().slice(0, 80), model: r.model };
	},

	// ------------------------------------------------------------------
	// Execução unificada
	// ------------------------------------------------------------------

	engineLabel(engine) {
		return this.ENGINES[engine] ? this.t("engine." + engine) : this.t("engine.none");
	},

	/** Motor escolhido nas definições ("" quando ainda não foi configurado). */
	defaultEngine() {
		const e = this.pref("engine");
		return this.ENGINES[e] ? e : "";
	},

	/** Verificação rápida (sem rede): o motor tem o que precisa para ser usado? */
	isEngineReady(engine) {
		const e = this.ENGINES[engine];
		if (!e) return false;
		if (e.kind === "key") return this.hasSecret(engine);
		return !!this.pref(engine + ".enabled") || this.pref("engine") === engine;
	},

	readyEngines() {
		return this.ENGINE_ORDER.filter(e => this.isEngineReady(e));
	},

	/** Teste real de qualquer motor: um pedido mínimo. Devolve { model, reply, path?, version? }. */
	async testEngine(engine, win) {
		if (engine === "claude") return this.testClaude();
		if (engine === "codex") return this.testCodex();
		const r = await this.runEngine(engine, { system: this.t("test.reply"), prompt: this.t("test.prompt"), win });
		return { model: r.model, reply: (r.text || "").trim().slice(0, 80) };
	},

	maxCharsFor(engine) {
		const v = this.pref((this.ENGINES[engine] ? engine : "claude") + ".maxChars");
		return Math.max(20000, parseInt(v, 10) || 400000);
	},

	async runEngine(engine, opts) {
		switch (engine) {
			case "gemini": return this.runGemini(Object.assign({ model: this.geminiModel() }, opts));
			case "anthropic": return this.runAnthropic(Object.assign({ model: this.anthropicModel() }, opts));
			case "claude": return this.runClaude(Object.assign({ model: this.pref("claude.model") || "sonnet" }, opts));
			case "openai": return this.runOpenAI(Object.assign({ model: this.openaiModel() }, opts));
			case "codex": return this.runCodex(Object.assign({ model: this.codexModel() }, opts));
		}
		throw this.error("notconfigured", this.t("err.notConfigured"));
	},

	// ------------------------------------------------------------------
	// Notas, ligações e exportação
	// ------------------------------------------------------------------

	citeHref(doc, page) {
		if (!doc || !doc.attachmentKey) return null;
		let prefix = "library";
		try { prefix = Zotero.API.getLibraryPrefix(doc.libraryID); }
		catch (e) { /* biblioteca pessoal */ }
		return `zotero://open-pdf/${prefix}/items/${doc.attachmentKey}` + (page ? `?page=${page}` : "");
	},

	async openAtPage(doc, page) {
		if (!doc || !doc.attachmentID) return;
		const location = page ? { pageIndex: page - 1 } : null;
		await Zotero.Reader.open(doc.attachmentID, location);
	},

	/**
	 * Guarda uma resposta como nota.
	 * Com um só documento com item-pai: nota filha. Caso contrário: nota independente
	 * na mesma biblioteca (e na coleção indicada), relacionada com os artigos.
	 */
	async saveNote({ markdown, heading, docs, docsMap, engine, collectionIDs }) {
		const L = this.lib;
		const ctx = { docsMap, citeHref: c => this.citeHref(docsMap[c.doc], c.page) };
		const body = L.markdownToHTML(markdown, ctx);
		const refs = docs.map(d => `<li>${L.escapeHTML(d.id)}: ${L.escapeHTML(d.fullRef || d.ref)}</li>`).join("");
		const date = new Date().toLocaleDateString(L.I18N.getLang() === "en" ? "en-GB" : "pt-PT");
		const html = `<h1>${L.escapeHTML(heading)}</h1>\n${body}\n<hr/>\n`
			+ (docs.length > 1 ? `<p><strong>${L.escapeHTML(this.t("note.documents"))}</strong></p><ul>${refs}</ul>` : "")
			+ `<p><em>${L.escapeHTML(this.t("note.footer", { engine: this.engineLabel(engine), date }))}</em></p>`;
		const note = new Zotero.Item("note");
		const single = docs.length === 1 ? docs[0] : null;
		if (single && single.parentID) {
			note.parentID = single.parentID;
		}
		else {
			note.libraryID = docs[0].libraryID;
			if (collectionIDs && collectionIDs.length) {
				note.setCollections(collectionIDs.filter(id => {
					const c = Zotero.Collections.get(id);
					return c && c.libraryID === note.libraryID;
				}));
			}
		}
		note.setNote(html);
		if (!note.parentID) {
			for (const d of docs) {
				const it = Zotero.Items.get(d.parentID || d.attachmentID);
				if (it && it.libraryID === note.libraryID) {
					try { note.addRelatedItem(it); }
					catch (e) { /* relação opcional */ }
				}
			}
		}
		await note.saveTx();
		return note;
	},

	async saveCSV(win, csv, defaultName) {
		const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
		const fp = new FilePicker();
		fp.init(win, this.t("note.csvTitle"), fp.modeSave);
		fp.appendFilter("CSV (Excel)", "*.csv");
		fp.defaultString = (defaultName || "tabela").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80) + ".csv";
		fp.defaultExtension = "csv";
		const rv = await fp.show();
		if (rv !== fp.returnOK && rv !== fp.returnReplace) return null;
		await Zotero.File.putContentsAsync(fp.file, csv);
		return fp.file;
	},

	copyToClipboard(text) {
		Components.classes["@mozilla.org/widget/clipboardhelper;1"]
			.getService(Components.interfaces.nsIClipboardHelper)
			.copyString(text);
	},

	// ------------------------------------------------------------------
	// Janela do assistente (várias fontes, comparação)
	// ------------------------------------------------------------------

	openWindow({ items = [], collectionIDs = [], autoAction = null } = {}) {
		const win = Zotero.getMainWindow();
		const args = { items, collectionIDs, autoAction };
		args.wrappedJSObject = args;
		// Reutiliza a janela aberta, se existir
		const existing = Services.wm.getMostRecentWindow(this.WINDOW_TYPE);
		if (existing && existing.ZIAWindow) {
			existing.ZIAWindow.receive(args);
			existing.focus();
			return existing;
		}
		return win.openDialog("chrome://zoteroia/content/window.xhtml", "zoteroia-chat",
			"chrome,resizable,centerscreen,dialog=no", args);
	},

	closeAllWindows() {
		const en = Services.wm.getEnumerator(this.WINDOW_TYPE);
		while (en.hasMoreElements()) {
			const w = en.getNext();
			try { w.close(); } catch (e) { /* já fechada */ }
		}
	},

	/** Itens selecionados na janela principal (biblioteca ou leitor). */
	selectedItems() {
		const zp = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
		if (!zp) return [];
		try { return zp.getSelectedItems() || []; }
		catch (e) { return []; }
	},

	selectedCollectionIDs() {
		const zp = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
		if (!zp) return [];
		try {
			// Zotero 10 ou superior: várias coleções selecionadas
			if (zp.getSelectedCollections) return zp.getSelectedCollections(true) || [];
		}
		catch (e) { /* sem coleção */ }
		try {
			// Zotero 8 e 9
			const id = zp.getSelectedCollection && zp.getSelectedCollection(true);
			return id ? [id] : [];
		}
		catch (e) { /* sem coleção */ }
		return [];
	},
};
