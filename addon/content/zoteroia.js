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
	ENGINE_ORDER: ["gemini", "claude", "codex", "anthropic", "openai"],
	// Motores que aparecem sempre na lista do painel. Os outros (chaves de API) só quando
	// estão configurados ou escolhidos.
	MAIN_ENGINES: ["gemini", "claude", "codex"],

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
		// Citações no estilo escolhido no Zotero (se não houver estilo, usa o formato simples)
		this.lib.setCiteFormatter((cites, docsMap) => this.formatCitesWithStyle(cites, docsMap));
		// Migra chaves antigas guardadas sem encriptação
		this.migrateSecrets().catch(e => this.log("Migração de chaves: " + e));
		// Uma vez: Gemini 3.5 Flash-Lite como modelo por omissão
		try {
			if (!this.pref("gemini.defaultApplied")) {
				this.setPref("gemini.model", this.lib.GEMINI_DEFAULT);
				this.setPref("gemini.defaultApplied", true);
				this._geminiSwap = null;
			}
		}
		catch (e) { this.log("Modelo Gemini: " + e); }
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

	error(kind, message, extra) {
		const e = new Error(message);
		e.kind = kind;
		if (extra) Object.assign(e, extra);
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

	/**
	 * Todas as coleções das bibliotecas, em árvore (com profundidade), para escolher na janela
	 * sem ter de selecionar antes a coleção no Zotero. A coleção selecionada vem marcada.
	 */
	listCollections() {
		const out = [];
		let sel = null;
		try {
			const zp = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
			const c = zp && zp.getSelectedCollection && zp.getSelectedCollection();
			if (c) sel = c.id;
		}
		catch (e) { /* sem coleção */ }
		const walk = (cols, depth, lib) => {
			cols = (cols || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
			for (const c of cols) {
				out.push({ id: c.id, name: c.name, depth, library: lib, selected: c.id === sel });
				let kids = [];
				try { kids = c.getChildCollections(false) || []; }
				catch (e) { /* sem subcoleções */ }
				walk(kids, depth + 1, lib);
			}
		};
		let libs = [];
		try { libs = Zotero.Libraries.getAll().filter(l => l.libraryType === "user" || l.libraryType === "group"); }
		catch (e) { this.log("Bibliotecas: " + e); }
		for (const l of libs) {
			let top = [];
			try { top = Zotero.Collections.getByLibrary(l.libraryID) || []; }
			catch (e) { continue; }
			walk(top, 0, libs.length > 1 ? l.name : null);
		}
		return out;
	},

	// ------------------------------------------------------------------
	// Citações no estilo escolhido no Zotero (APA, Chicago, ABNT, ...)
	// ------------------------------------------------------------------

	/** Estilos instalados no Zotero, por ordem alfabética: [{ id, title }]. */
	citationStyles() {
		try {
			return Zotero.Styles.getVisible()
				.map(st => ({ id: st.styleID, title: st.title }))
				.sort((a, b) => String(a.title).localeCompare(String(b.title)));
		}
		catch (e) {
			this.log("Estilos: " + e);
			return [];
		}
	},

	/** Estilo escolhido nas definições ("" = formato simples do addon). */
	citeStyleID() {
		const id = String(this.pref("cite.style") || "").trim();
		if (!id) return "";
		try { return Zotero.Styles.get(id) ? id : ""; }
		catch (e) { return ""; }
	},

	/** Motor de citações (citeproc) do estilo, guardado para não o recriar a cada resposta. */
	_citeEngine(styleID) {
		const locale = this.lib.I18N.getLang() === "en" ? "en-US" : "pt-PT";
		const key = styleID + "|" + locale;
		this._citeEngines = this._citeEngines || new Map();
		let engine = this._citeEngines.get(key);
		if (!engine) {
			const style = Zotero.Styles.get(styleID);
			if (!style) return null;
			engine = style.getCiteProc(locale, "text");
			this._citeEngines.set(key, engine);
			if (this._citeEngines.size > 6) this._citeEngines.delete(this._citeEngines.keys().next().value);
		}
		return engine;
	},

	/**
	 * Formata um grupo de citações [{ doc, page, pageEnd }] no estilo escolhido, num só
	 * parêntesis (ou nota de rodapé, nos estilos de notas). Devolve null se não for possível
	 * (sem estilo escolhido, artigo sem item no Zotero, erro do estilo): o chamador usa o formato simples.
	 */
	formatCitesWithStyle(cites, docsMap, { single } = {}) {
		const styleID = this.citeStyleID();
		if (!styleID || !cites || !cites.length) return null;
		try {
			const engine = this._citeEngine(styleID);
			if (!engine) return null;
			// Todos os artigos da conversa, pela ordem D1, D2...: a desambiguação (2021a, 2021b)
			// e a numeração dos estilos numéricos dependem do conjunto completo
			const all = Object.keys(docsMap || {}).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
			const itemOf = id => {
				const d = docsMap[id];
				const it = d && d.parentID ? Zotero.Items.get(d.parentID) : null;
				return it && it.isRegularItem && it.isRegularItem() ? it : null;
			};
			const regular = all.filter(id => itemOf(id));
			// Estado limpo a cada pedido (o motor fica guardado, o estado não)
			engine.rebuildProcessorState([], "text", []);
			engine.setOutputFormat("text");
			engine.updateItems(regular.map(id => itemOf(id).id));
			const order = [];
			const byDoc = new Map();
			for (const c of cites) {
				if (!itemOf(c.doc)) return null;
				if (!byDoc.has(c.doc)) { byDoc.set(c.doc, []); order.push(c.doc); }
				byDoc.get(c.doc).push(c);
			}
			const citationItems = order.map(id => {
				const pages = byDoc.get(id).filter(c => c.page != null)
					.map(c => (c.pageEnd && c.pageEnd !== c.page ? `${c.page}-${c.pageEnd}` : String(c.page)));
				const item = { id: itemOf(id).id };
				if (pages.length) { item.locator = pages.join(", "); item.label = "page"; }
				return item;
			});
			// Primeiro uma citação escondida com todos os artigos: só assim o motor distingue
			// Silva et al., 2021a e 2021b (a desambiguação só vale para o que foi citado)
			const prime = { citationID: "zia-all", citationItems: regular.map(id => ({ id: itemOf(id).id })), properties: { noteIndex: 1 } };
			engine.processCitationCluster(prime, [], []);
			const mine = { citationID: "zia-cite", citationItems, properties: { noteIndex: 2 } };
			const res = engine.processCitationCluster(mine, [["zia-all", 1]], []);
			const hit = (res[1] || []).find(r => r[2] === "zia-cite");
			return hit ? String(hit[1]).replace(/\s+/g, " ").trim() || null : null;
		}
		catch (e) {
			this.log("Citações no estilo " + styleID + ": " + e);
			return null;
		}
	},

	/** Itens com PDF de uma coleção (por id). */
	collectionItems(id) {
		const col = Zotero.Collections.get(id);
		if (!col) return { name: null, items: [] };
		let items = [];
		try { items = col.getChildItems(false) || []; }
		catch (e) { this.log("getChildItems: " + e); }
		return { name: col.name, id: col.id, items: items.filter(i => i.isRegularItem() || (i.isAttachment() && i.isPDFAttachment())) };
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
	// Atualizações: o Zotero consulta o update_url do manifest.json (releases do GitHub)
	// ------------------------------------------------------------------

	/** Procura já uma versão nova e instala-a. Devolve { status: "installed"|"none"|"failed"|"error", version }. */
	async checkForUpdates() {
		const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
		const addon = await AddonManager.getAddonByID(this.id);
		if (!addon) return { status: "error" };
		return new Promise(resolve => {
			addon.findUpdates({
				onUpdateAvailable: (a, install) => {
					install.addListener({
						onInstallEnded: () => resolve({ status: "installed", version: install.version }),
						onInstallFailed: () => resolve({ status: "failed", version: install.version }),
						onDownloadFailed: () => resolve({ status: "failed", version: install.version }),
					});
					install.install();
				},
				onNoUpdateAvailable: () => resolve({ status: "none" }),
				onUpdateFinished: (a, error) => { if (error) resolve({ status: "error" }); },
			}, AddonManager.UPDATE_WHEN_USER_REQUESTED);
		});
	},

	// ------------------------------------------------------------------
	// Histórico das conversas por artigo (ficheiros JSON na pasta de dados do Zotero)
	// ------------------------------------------------------------------

	HISTORY_MAX: 60,

	_conversationPath(key) {
		const dir = PathUtils.join(Zotero.DataDirectory.dir, "zoteroia", "conversas");
		return { dir, file: PathUtils.join(dir, String(key).replace(/[^\w.-]/g, "_") + ".json") };
	},

	async loadConversation(key) {
		if (!key || this.pref("history.save") === false) return null;
		try {
			const { file } = this._conversationPath(key);
			if (!(await IOUtils.exists(file))) return null;
			const j = JSON.parse(await IOUtils.readUTF8(file));
			// Versão 2: várias conversas (separadores). Versão 1: uma só conversa
			if (Array.isArray(j.conversations)) {
				return { convs: j.conversations.map(c => (Array.isArray(c.messages) ? c.messages : [])), active: j.active || 0 };
			}
			return Array.isArray(j.messages) ? { convs: [j.messages], active: 0 } : null;
		}
		catch (e) {
			this.log("Histórico: " + e);
			return null;
		}
	},

	/** Guarda as conversas de um artigo. data: { convs: [[mensagens]], active } (ou uma lista de mensagens). */
	async saveConversation(key, data) {
		if (!key) return;
		const { dir, file } = this._conversationPath(key);
		const convs = Array.isArray(data) ? [data] : ((data && data.convs) || []);
		let active = Array.isArray(data) ? 0 : ((data && data.active) || 0);
		try {
			const keep = ["role", "display", "promptText", "text", "actionID", "actionLabel", "engine", "model",
				"heading", "error", "errorKind", "errorDetail", "asked", "time", "docIDs", "usageNote", "noteID", "check"];
			const clean = msgs => msgs.filter(m => !m.pending).slice(-this.HISTORY_MAX)
				.map(m => Object.fromEntries(keep.filter(k => m[k] != null).map(k => [k, m[k]])));
			const conversations = [];
			convs.forEach((c, i) => {
				const messages = clean(c || []);
				if (messages.length) conversations.push({ messages });
				else if (i < active) active--;
			});
			if (!conversations.length || this.pref("history.save") === false) {
				if (await IOUtils.exists(file)) await IOUtils.remove(file);
				return;
			}
			active = Math.min(Math.max(0, active), conversations.length - 1);
			await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
			await IOUtils.writeUTF8(file, JSON.stringify({ version: 2, saved: Date.now(), active, conversations }));
		}
		catch (e) {
			this.log("Histórico: " + e);
		}
	},

	async clearAllConversations() {
		const { dir } = this._conversationPath("x");
		if (await IOUtils.exists(dir)) await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
	},

	/**
	 * Artigos com PDF que o utilizador está a ver na lista central do Zotero (coleção, pesquisa
	 * ou biblioteca), para os juntar à conversa. Devolve { item, label } pela ordem da lista.
	 */
	async pickableItems(limit = 400) {
		const zp = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
		let items = [];
		try { items = (zp && zp.getSortedItems && zp.getSortedItems()) || []; }
		catch (e) { this.log("getSortedItems: " + e); }
		const out = [];
		for (const it of items) {
			if (out.length >= limit) break;
			let ok = false;
			if (it.isRegularItem && it.isRegularItem()) {
				ok = (it.getAttachments ? it.getAttachments() : []).some(id => {
					const a = Zotero.Items.get(id);
					return a && a.isPDFAttachment && a.isPDFAttachment();
				});
			}
			else if (it.isAttachment && it.isAttachment() && it.isPDFAttachment() && !it.parentItemID) {
				ok = true;
			}
			if (!ok) continue;
			const creators = it.getCreators ? it.getCreators() : [];
			const label = `${this.lib.shortAuthor(creators)} ${this.lib.yearFrom(it.getField("date"))} · ${it.getField("title") || this.t("ref.noTitle")}`;
			const first = creators[0] || {};
			out.push({
				item: it, label,
				added: it.dateAdded || "",
				author: (first.lastName || first.name || "").toLowerCase(),
				date: String(it.getField("date") || ""),
			});
		}
		return out;
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

	// Comandos oficiais de instalação (code.claude.com/docs/en/setup). Fixos: nunca vêm de fora.
	CLAUDE_INSTALL_WIN: "irm https://claude.ai/install.ps1 | iex",
	CLAUDE_INSTALL_UNIX: "curl -fsSL https://claude.ai/install.sh | bash",

	/** Comando para instalar à mão, mostrado como alternativa nas definições. */
	claudeInstallCommand() {
		return Zotero.isWin ? this.CLAUDE_INSTALL_WIN : this.CLAUDE_INSTALL_UNIX;
	},

	/** Conteúdo do script que instala o Claude Code (se faltar) e abre o início de sessão. */
	claudeSetupScript(platform, existing, home) {
		const msg = k => this.t(k);
		if (platform === "win") {
			// Em .cmd, o texto de echo não pode ter caracteres especiais sem escape
			const echo = s => "echo " + String(s).replace(/[\^&|<>%]/g, c => (c === "%" ? "%%" : "^" + c));
			const exe = existing && !/["%]/.test(existing) ? existing : "%USERPROFILE%\\.local\\bin\\claude.exe";
			return [
				"@echo off",
				"chcp 65001 >nul",
				"title Claude Code",
				`set "CLAUDE_EXE=${exe}"`,
				"if exist \"%CLAUDE_EXE%\" goto login",
				echo(msg("setup.script.installing")),
				"echo.",
				`powershell -NoProfile -ExecutionPolicy Bypass -Command "${this.CLAUDE_INSTALL_WIN}"`,
				"if exist \"%CLAUDE_EXE%\" goto login",
				"echo.",
				echo(msg("setup.script.failed")),
				"pause",
				"exit /b 1",
				":login",
				"echo.",
				echo(msg("setup.script.login")),
				"echo.",
				"call \"%CLAUDE_EXE%\"",
				"",
			].join("\r\n");
		}
		const say = s => "printf '%s\\n' '" + String(s).replace(/'/g, "'\\''") + "'";
		const exe = existing && !/["$`\\]/.test(existing) ? existing : `${home}/.local/bin/claude`;
		return [
			"#!/bin/bash",
			"clear",
			`CLAUDE_EXE="${exe.replace(/["$`\\]/g, "")}"`,
			"if [ ! -x \"$CLAUDE_EXE\" ]; then",
			"  " + say(msg("setup.script.installing")),
			"  " + this.CLAUDE_INSTALL_UNIX,
			"fi",
			"if [ ! -x \"$CLAUDE_EXE\" ]; then",
			"  " + say(msg("setup.script.failed")),
			"  read -r",
			"  exit 1",
			"fi",
			say(msg("setup.script.login")),
			"\"$CLAUDE_EXE\"",
			"",
		].join("\n");
	},

	/**
	 * Abre uma janela visível (PowerShell/cmd no Windows, Terminal no Mac) que instala o
	 * Claude Code a partir do site oficial, se ainda não estiver instalado, e inicia a sessão.
	 * Devolve { opened: true } ou { opened: false } quando o sistema não é suportado (Linux).
	 */
	async openClaudeSetup() {
		if (!Zotero.isWin && !Zotero.isMac) return { opened: false };
		let existing = null;
		try { existing = await this.findClaudeExecutable(); }
		catch (e) { /* ainda não instalado */ }
		const dir = await this.workDir();
		if (Zotero.isWin) {
			const script = PathUtils.join(dir, "claude-code-setup.cmd");
			await IOUtils.writeUTF8(script, this.claudeSetupScript("win", existing));
			let comspec = "";
			try { comspec = Services.env.get("COMSPEC"); }
			catch (e) { /* sem variável */ }
			const cmd = comspec || "C:\\Windows\\System32\\cmd.exe";
			// start abre sempre uma janela nova e visível. O título evita que o caminho seja lido como título.
			await this.runProcess(cmd, ["/c", "start", "Claude Code", script], { timeoutMs: 15000 });
		}
		else {
			const script = PathUtils.join(dir, "claude-code-setup.command");
			await IOUtils.writeUTF8(script, this.claudeSetupScript("unix", existing, this.homeDir()));
			await IOUtils.setPermissions(script, 0o755);
			await this.runProcess("/usr/bin/open", ["-a", "Terminal", script], { timeoutMs: 15000 });
		}
		this._toolCache.claude = null;
		this.setPref("claude.lastTest", "");
		return { opened: true, installed: !!existing };
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
		return String(this.pref("gemini.model") || this.lib.GEMINI_DEFAULT).replace(/^models\//, "").trim();
	},

	// Esperas entre tentativas no modelo escolhido quando a Google está sobrecarregada
	GEMINI_RETRY_MS: [3000, 8000, 15000],
	GEMINI_ALT_PAUSE_MS: 2000,

	_sleep(ms, signal) {
		return new Promise(resolve => {
			const timer = setTimeout(resolve, ms);
			if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
		});
	},

	/**
	 * Gemini com tolerância a sobrecarga (erros 500 a 504): repete o pedido com esperas
	 * crescentes e, se o modelo continuar indisponível, tenta até três modelos alternativos
	 * da conta (primeiro os "lite", que costumam ter menos procura). Avisa na conversa.
	 */
	async runGemini(opts0) {
		let { system, prompt, model, onDelta, onInfo, signal, win } = opts0;
		const key = await this.getSecret("gemini");
		if (!key) {
			throw this.error("auth", this.t("err.noKey", { label: this.t("key.gemini") }));
		}
		model = String(model || this.geminiModel()).replace(/^models\//, "");
		const notify = (k, vars) => { if (onInfo) onInfo({ notice: this.t(k, vars) }); };
		// Quota diária do modelo escolhido já esgotada hoje: vai direto ao modelo que respondeu
		const today = new Date().toDateString();
		const swap = this._geminiSwap;
		if (swap && swap.day === today && swap.from === model && !(opts0.noLite && /lite/i.test(swap.to))) {
			const original = model;
			model = swap.to;
			notify("chat.geminiAltQuota", { model, original });
			try {
				const r = await this.runGemini({ system, prompt, model, onDelta, onInfo, signal, win, noLite: opts0.noLite });
				r.notice = r.notice || this.t("chat.geminiUsedAltQuota", { model, original });
				return r;
			}
			catch (e) {
				if (e.kind !== "limit" && e.kind !== "busy") throw e;
				this._geminiSwap = null;
				model = original;
			}
		}
		let streamed = false;
		const opts = { system, prompt, signal, win, key, onDelta: (d, all) => { streamed = true; if (onDelta) onDelta(d, all); } };
		const aborted = () => !!(signal && signal.aborted);
		const stop = () => { if (aborted()) throw this.error("aborted", this.t("err.aborted")); };
		let firstErr;
		let waitedMinute = false;
		for (let i = 0; i <= this.GEMINI_RETRY_MS.length; i++) {
			try { return await this._geminiOnce(model, opts); }
			catch (e) {
				if (streamed || aborted() || !["busy", "limit", "model"].includes(e.kind)) throw e;
				firstErr = e;
				const q = e.quota || {};
				// Limite por minuto com espera curta: espera o tempo indicado pela Google e repete
				if (e.kind === "limit" && q.period === "minute" && !waitedMinute && q.retrySec > 0 && q.retrySec <= 40) {
					waitedMinute = true;
					notify("chat.geminiWaitMinute", { model, s: q.retrySec });
					await this._sleep(q.retrySec * 1000, signal);
					stop();
					continue;
				}
				// Quota esgotada (diária ou sem pormenores): este modelo não vai responder, passa aos outros
				if (e.kind === "limit") break;
				if (e.kind === "model") break;
				if (i < this.GEMINI_RETRY_MS.length) {
					const ms = this.GEMINI_RETRY_MS[i];
					this.log(`Gemini ${model} sobrecarregado, nova tentativa em ${ms} ms`);
					notify("chat.geminiRetry", { model, s: Math.round(ms / 1000), n: i + 1, total: this.GEMINI_RETRY_MS.length });
					await this._sleep(ms, signal);
					stop();
				}
			}
		}
		let alternatives = [];
		try {
			alternatives = this.lib.geminiFallbacks(model, await this.geminiModels(win), opts0.noLite ? 6 : 3);
			if (opts0.noLite) alternatives = alternatives.filter(n => !/lite/i.test(n)).slice(0, 3);
		}
		catch (e) { this.log("Lista de modelos Gemini: " + e); }
		const tried = [];
		for (const alt of alternatives) {
			stop();
			const why = firstErr.kind === "limit" ? "Quota" : firstErr.kind === "model" ? "Model" : "";
			notify("chat.geminiAlt" + why, { model: alt, original: model });
			tried.push(alt);
			try {
				this.log(`Gemini: a tentar o modelo alternativo ${alt}`);
				const r = await this._geminiOnce(alt, opts);
				r.notice = this.t("chat.geminiUsedAlt" + why, { model: alt, original: model });
				if (firstErr.kind === "limit" && (firstErr.quota || {}).period !== "minute") {
					this._geminiSwap = { day: new Date().toDateString(), from: model, to: alt };
				}
				return r;
			}
			catch (e) {
				// Um alternativo sem quota, inexistente ou também sobrecarregado: passa ao seguinte
				if (streamed || aborted() || !["busy", "limit", "model"].includes(e.kind)) throw e;
				await this._sleep(this.GEMINI_ALT_PAUSE_MS, signal);
			}
		}
		if (tried.length) firstErr.message += "\n" + this.t("err.gemini.triedOthers", { models: tried.join(", ") });
		throw firstErr;
	},

	// Modelo de análise sobrecarregado ou sem quota: não volta a ser tentado durante este tempo
	GEMINI_BUSY_MEMORY_MS: 15 * 60 * 1000,

	/** Lista de modelos da conta, guardada durante uma hora (evita um pedido extra a cada falha). */
	async geminiModels(win) {
		const c = this._geminiListCache;
		if (c && Date.now() - c.at < 3600 * 1000) return c.models;
		const models = await this.listGeminiModels(win);
		this._geminiListCache = { at: Date.now(), models };
		return models;
	},

	_geminiAvoid(model) {
		const m = this._geminiBusyUntil || {};
		return (m[model] || 0) > Date.now();
	},

	_geminiMarkBusy(model, err) {
		this._geminiBusyUntil = this._geminiBusyUntil || {};
		const q = (err && err.quota) || {};
		let until = Date.now() + this.GEMINI_BUSY_MEMORY_MS;
		if (err && err.kind === "limit" && q.period !== "minute") {
			const end = new Date();
			end.setHours(23, 59, 59, 999);
			until = end.getTime();
		}
		this._geminiBusyUntil[model] = until;
	},

	/**
	 * Tarefas exigentes: tenta primeiro o modelo de análise (por omissão os flash mais recentes),
	 * uma única vez e sem esperas. Se estiver sobrecarregado ou sem quota, passa logo ao modelo
	 * principal (normalmente o Flash-Lite, que quase sempre responde) e fica a saber disso durante
	 * 15 minutos, para os pedidos seguintes não perderem tempo.
	 */
	async runGeminiHeavy(opts) {
		const { signal, win, onInfo, onDelta } = opts;
		const main = String(opts.model || this.geminiModel()).replace(/^models\//, "");
		const key = await this.getSecret("gemini");
		if (!key) throw this.error("auth", this.t("err.noKey", { label: this.t("key.gemini") }));
		let cands = [];
		try { cands = this.lib.geminiStrongCandidates(main, await this.geminiModels(win), this.pref("gemini.modelStrong")); }
		catch (e) { this.log("Modelos Gemini para análise: " + e); }
		const notify = (k, vars) => { if (onInfo) onInfo({ notice: this.t(k, vars) }); };
		let streamed = false;
		const once = { system: opts.system, prompt: opts.prompt, signal, win, key, onDelta: (d, all) => { streamed = true; if (onDelta) onDelta(d, all); } };
		let skipped = null;
		for (const m of cands) {
			if (this._geminiAvoid(m)) { skipped = skipped || m; continue; }
			try { return await this._geminiOnce(m, once); }
			catch (e) {
				if (streamed || (signal && signal.aborted) || !["busy", "limit", "model"].includes(e.kind)) throw e;
				this._geminiMarkBusy(m, e);
				skipped = skipped || m;
				this.log(`Gemini ${m} indisponível (${e.kind}), a passar ao seguinte`);
				notify("chat.geminiStrongBusy", { model: m });
			}
		}
		// Comparar: nunca os modelos "lite". Usa o melhor flash completo, com as tentativas normais
		if (opts.noLite) {
			let list = [];
			try { list = await this.geminiModels(win); }
			catch (e) { /* sem lista */ }
			const full = cands[0] || (/lite/i.test(main) ? this.lib.geminiStrongCandidates(main, list, "auto")[0] : main);
			if (!full) throw this.error("model", this.t("err.geminiNoFull"));
			if (this._geminiBusyUntil) delete this._geminiBusyUntil[full];
			return this.runGemini(Object.assign({}, opts, { model: full }));
		}
		const r = await this.runGemini(Object.assign({}, opts, { model: main }));
		if (skipped && !r.notice) r.notice = this.t("chat.geminiUsedFast", { model: r.model, strong: skipped });
		return r;
	},

	/**
	 * Teste rápido de vários modelos Gemini ao mesmo tempo, com um pedido mínimo a cada um.
	 * Devolve [{ model, state: ok|busy|limit|minute|model|error, ms }]. Cada teste gasta um pedido da quota.
	 */
	async probeGeminiModels(win, models) {
		const key = await this.getSecret("gemini");
		if (!key) throw this.error("auth", this.t("err.saveKeyFirst", { label: this.t("key.gemini") }));
		const probe = async model => {
			const t0 = Date.now();
			const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
			let res, cleanup;
			try {
				({ res, cleanup } = await this._fetch(win, url, {
					method: "POST",
					headers: { "Content-Type": "application/json", "x-goog-api-key": key },
					body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "OK" }] }], generationConfig: { maxOutputTokens: 16 } }),
				}));
			}
			catch (e) {
				return { model, state: "error", message: String(e && e.message || e), ms: Date.now() - t0 };
			}
			try {
				const text = await res.text();
				const r = this.lib.geminiProbeState(res.status, text);
				r.model = model;
				r.ms = Date.now() - t0;
				if (r.state === "ok") { if (this._geminiBusyUntil) delete this._geminiBusyUntil[model]; }
				else if (["busy", "limit", "model"].includes(r.state)) this._geminiMarkBusy(model, { kind: r.state, quota: {} });
				return r;
			}
			finally { cleanup(); }
		};
		return Promise.all(models.map(probe));
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
				throw this.error(c.kind, c.message, { detail: c.detail, quota: c.quota });
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
				throw this.error(c.kind, c.message, { detail: c.detail, quota: c.quota });
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
	// Sonnet 5.5 por omissão: mesmo preço do Sonnet 5 (2 $ / 10 $ por milhão de tokens), mais
	// recente, e metade do preço do Opus 5.5, cuja vantagem pouco se nota em resumos e perguntas.
	ANTHROPIC_MODELS: [
		{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "recommended" },
		{ id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "best" },
		{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "fast" },
	],

	anthropicModel() {
		const m = String(this.pref("anthropic.model") || "claude-sonnet-5-5").trim();
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
		// Ler e resumir artigos não precisa de raciocínio longo: esforço médio gasta menos tokens
		if (/^claude-(sonnet|opus)-5/.test(model)) body.output_config = { effort: "medium" };
		const headers = this._anthropicHeaders(key);
		// Nos modelos com classificadores de segurança, uma recusa passa para outro modelo
		let useFallbacks = /^claude-(opus-5|sonnet-5-5|fable)/.test(model);
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
	async testEngine(engine, win, onInfo) {
		if (engine === "claude") return this.testClaude();
		if (engine === "codex") return this.testCodex();
		const r = await this.runEngine(engine, { system: this.t("test.reply"), prompt: this.t("test.prompt"), win, onInfo });
		return { model: r.model, reply: (r.text || "").trim().slice(0, 80) };
	},

	maxCharsFor(engine) {
		const v = this.pref((this.ENGINES[engine] ? engine : "claude") + ".maxChars");
		return Math.max(20000, parseInt(v, 10) || 400000);
	},

	async runEngine(engine, opts) {
		switch (engine) {
			case "gemini": {
				const o = Object.assign({ model: this.geminiModel() }, opts);
				return o.heavy ? this.runGeminiHeavy(o) : this.runGemini(o);
			}
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
		const parent = single && single.parentID ? Zotero.Items.get(single.parentID) : null;
		// A biblioteca tem de ser definida antes de tudo: o Zotero precisa dela para ler o item-pai
		note.libraryID = parent ? parent.libraryID : docs[0].libraryID;
		const asChild = !!parent;
		if (asChild) {
			note.parentID = parent.id;
		}
		else {
			if (collectionIDs && collectionIDs.length) {
				note.setCollections(collectionIDs.filter(id => {
					const c = Zotero.Collections.get(id);
					return c && c.libraryID === note.libraryID;
				}));
			}
		}
		note.setNote(html);
		if (!asChild) {
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

	openWindow({ items = [], collectionIDs = [], autoAction = null, pickCollection = false, collectionName = null, group = null } = {}) {
		const win = Zotero.getMainWindow();
		const args = { items, collectionIDs, autoAction, pickCollection, collectionName, group };
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
