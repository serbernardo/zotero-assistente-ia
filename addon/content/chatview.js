/*
 * Assistente IA para Zotero
 * chatview.js: componente de conversa, usado no painel lateral e na janela.
 */

/* global Zotero, ZIALib, Services, setTimeout, clearTimeout */

var ZIAChatView = class {
	/**
	 * @param {object} o
	 * @param {Document} o.doc
	 * @param {Window} o.win
	 * @param {Element} o.container
	 * @param {'section'|'window'} o.mode
	 * @param {object} o.core   ZoteroIA
	 */
	constructor({ doc, win, container, mode, core }) {
		this.doc = doc;
		this.win = win;
		this.container = container;
		this.mode = mode || "window";
		this.core = core;
		this.L = core.lib;
		this.state = this._emptyState();
		this.engine = core.defaultEngine();
		this.group = core.pref("ui.group") || "compreender";
		this.collectionIDs = [];
		this.busy = false;
		this.abort = null;
		this.sessionKey = null;
		this._renderTimer = null;
		this._pendingPrivacy = null;
		this._build();
		this._observePrefs();
	}

	/** Texto da interface na língua escolhida. */
	T(key, vars) {
		return this.core.t(key, vars);
	}

	_emptyState() {
		return { docs: [], allDocs: {}, nextDocNum: 1, messages: [] };
	}

	// ------------------------------------------------------------------
	// Construção da interface
	// ------------------------------------------------------------------

	_el(tag, cls, text) {
		const e = this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	_button(label, cls, onClick, title) {
		const b = this._el("button", "zia-btn " + (cls || ""), label);
		b.setAttribute("type", "button");
		if (title) b.title = title;
		b.addEventListener("click", ev => {
			ev.preventDefault();
			ev.stopPropagation();
			onClick(ev);
		});
		return b;
	}

	_build() {
		const root = this._el("div", `zia-root zia-mode-${this.mode}`);
		this.root = root;

		// Barra superior: documentos, motor e definições
		const bar = this._el("div", "zia-bar");
		this.docsEl = this._el("div", "zia-docs");
		bar.appendChild(this.docsEl);
		const tools = this._el("div", "zia-bar-tools");
		if (this.mode === "window") {
			tools.appendChild(this._button(this.T("chat.addSelected"), "zia-btn-small", () => this.addSelected(),
				this.T("chat.addSelected.tip")));
			tools.appendChild(this._button(this.T("chat.addCollection"), "zia-btn-small", () => this.addCollection(),
				this.T("chat.addCollection.tip")));
		}
		this.engineSel = this._el("select", "zia-engine");
		this.engineSel.title = this.T("chat.engine.tip");
		this.engineSel.addEventListener("change", () => this._setEngine(this.engineSel.value));
		tools.appendChild(this.engineSel);
		tools.appendChild(this._button("⚙", "zia-btn-small zia-btn-icon", () => this._openPrefs(), this.T("chat.settings.tip")));
		bar.appendChild(tools);
		root.appendChild(bar);

		// Separadores de ações
		this.tabsEl = this._el("div", "zia-tabs");
		this.tabsEl.setAttribute("role", "tablist");
		root.appendChild(this.tabsEl);
		this.actionsEl = this._el("div", "zia-actions");
		root.appendChild(this.actionsEl);
		const fichasLabel = this._el("label", "zia-fichas-toggle");
		this.useFichas = this._el("input");
		this.useFichas.setAttribute("type", "checkbox");
		fichasLabel.appendChild(this.useFichas);
		fichasLabel.appendChild(this.doc.createTextNode(this.T("chat.fichas")));
		fichasLabel.title = this.T("chat.fichas.tip");
		this.fichasLabel = fichasLabel;

		// Mensagens
		this.messagesEl = this._el("div", "zia-messages");
		this.messagesEl.setAttribute("aria-live", "polite");
		root.appendChild(this.messagesEl);

		// Estado
		this.statusEl = this._el("div", "zia-status");
		root.appendChild(this.statusEl);

		// Entrada
		const input = this._el("div", "zia-input");
		this.textarea = this._el("textarea", "zia-textarea");
		this.textarea.setAttribute("rows", "2");
		this.textarea.setAttribute("placeholder", this.T("chat.placeholder"));
		this.textarea.addEventListener("keydown", ev => {
			if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
				ev.preventDefault();
				this.sendQuestion();
			}
			else if (ev.key === "Escape" && this.busy) {
				ev.preventDefault();
				this.stop();
			}
		});
		this.textarea.addEventListener("input", () => this._autoGrow());
		input.appendChild(this.textarea);
		this.sendBtn = this._button(this.T("chat.send"), "zia-send", () => (this.busy ? this.stop() : this.sendQuestion()));
		input.appendChild(this.sendBtn);
		root.appendChild(input);

		const tail = this._el("div", "zia-footer");
		this.newBtn = this._button(this.T("chat.new"), "zia-link-btn", () => this.clearConversation());
		tail.appendChild(this.newBtn);
		if (this.mode === "section") {
			tail.appendChild(this._button(this.T("chat.openWindow"), "zia-link-btn", () => this.openInWindow(),
				this.T("chat.openWindow.tip")));
		}
		root.appendChild(tail);

		this.container.appendChild(root);
		this._renderEngines();
		this._renderTabs();
		this._renderDocs();
		this._renderMessages();
		this._updateButtons();
	}

	_autoGrow() {
		const t = this.textarea;
		t.style.height = "auto";
		t.style.height = Math.min(t.scrollHeight + 2, 200) + "px";
	}

	/** Atualiza a interface quando as definições mudam noutra janela. */
	_observePrefs() {
		this._prefObservers = [];
		const P = Zotero.Prefs;
		if (!P || !P.registerObserver) return;
		const keys = ["engine", "anthropic.key", "openai.key", "gemini.key", "claude.enabled", "codex.enabled", "custom.prompts", "ui.lang"];
		for (const k of keys) {
			try {
				this._prefObservers.push(P.registerObserver(this.core.PREF_BRANCH + k, () => this._onPrefsChanged(k), true));
			}
			catch (e) {
				this.core.log("registerObserver: " + e);
			}
		}
	}

	_onPrefsChanged(key) {
		if (!this.root) return;
		if (key === "ui.lang") {
			this.core.applyLanguage();
			this._rebuild();
			return;
		}
		if (key === "engine" && !this.busy) {
			const e = this.core.defaultEngine();
			if (e) this.engine = e;
		}
		this._renderEngines();
		if (key === "custom.prompts") this._renderTabs();
		if (!this.state.messages.length) this._renderMessages();
		this._updateButtons();
	}

	/** Volta a construir a interface (por exemplo, depois de mudar a língua), mantendo a conversa. */
	_rebuild() {
		if (!this.root || this.busy) return;
		const parent = this.root.parentNode;
		if (parent) parent.removeChild(this.root);
		for (const m of this.state.messages) m.el = null;
		this._build();
		this._renderMessages();
	}

	destroy() {
		this.stop();
		this._saveSession();
		if (this._pendingPrivacy) this._pendingPrivacy(false);
		const P = Zotero.Prefs;
		for (const id of this._prefObservers || []) {
			try { P.unregisterObserver(id); } catch (e) { /* já removido */ }
		}
		this._prefObservers = [];
		if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
		this.root = null;
	}

	// ------------------------------------------------------------------
	// Motores
	// ------------------------------------------------------------------

	_renderEngines() {
		const sel = this.engineSel;
		while (sel.firstChild) sel.removeChild(sel.firstChild);
		if (!this.engine) {
			const o = this._el("option", null, this.T("chat.engine.choose"));
			o.value = "";
			sel.appendChild(o);
		}
		for (const id of this.core.ENGINE_ORDER) {
			const ready = this.core.isEngineReady(id);
			const o = this._el("option", null, this.core.engineLabel(id) + (ready ? "" : this.T("chat.engine.notReady")));
			o.value = id;
			sel.appendChild(o);
		}
		sel.value = this.engine || "";
	}

	_setEngine(engine) {
		if (this.busy) return;
		this.engine = engine || "";
		if (this.engine && this.core.isEngineReady(this.engine)) this.core.setPref("engine", this.engine);
		this._renderEngines();
		if (!this.state.messages.length) this._renderMessages();
		else if (!this._engineReady()) this._showSetupInline();
		this._updateButtons();
	}

	_engineReady() {
		return !!this.engine && this.core.isEngineReady(this.engine);
	}

	_otherReadyEngines(engine) {
		return this.core.readyEngines().filter(e => e !== engine);
	}

	// ------------------------------------------------------------------
	// Ações e separadores
	// ------------------------------------------------------------------

	_customActions() {
		return this.L.parseCustomPrompts(this.core.pref("custom.prompts") || "");
	}

	_action(id) {
		if (this.L.ACTIONS[id]) return Object.assign({ id }, this.L.ACTIONS[id]);
		const c = this._customActions().find(a => a.id === id);
		return c || null;
	}

	_actionsOfGroup(group) {
		if (group === "meus") return this._customActions();
		return this.L.ACTION_ORDER
			.filter(id => this.L.ACTIONS[id].group === group)
			.map(id => Object.assign({ id }, this.L.ACTIONS[id]));
	}

	_renderTabs() {
		const box = this.tabsEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		const groups = this.L.ACTION_GROUPS.filter(g => g.id !== "meus" || this._customActions().length);
		if (!groups.some(g => g.id === this.group)) this.group = groups[0].id;
		for (const g of groups) {
			const t = this._button(g.label, "zia-tab", () => {
				this.group = g.id;
				this.core.setPref("ui.group", g.id);
				this._renderTabs();
			});
			t.setAttribute("role", "tab");
			t.setAttribute("aria-selected", g.id === this.group ? "true" : "false");
			t.dataset.group = g.id;
			box.appendChild(t);
		}
		box.appendChild(this._button("+", "zia-tab zia-tab-add", () => this._openPrefs(),
			this.T("chat.addPrompts.tip")));
		this._renderActions();
	}

	_renderActions() {
		const box = this.actionsEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		this.actionButtons = {};
		for (const a of this._actionsOfGroup(this.group)) {
			const b = this._button(a.label, "zia-action", () => this.runAction(a.id), a.hint);
			b.dataset.action = a.id;
			this.actionButtons[a.id] = b;
			box.appendChild(b);
		}
		if (this.group !== "compreender") box.appendChild(this.fichasLabel);
		this._updateButtons();
	}

	// ------------------------------------------------------------------
	// Documentos no contexto
	// ------------------------------------------------------------------

	/** Painel lateral: mostra a conversa do item atual (guardada em memória na sessão). */
	async showItem(item) {
		const key = item ? `item:${item.id}` : null;
		if (key === this.sessionKey) return;
		this._saveSession();
		this.stop();
		if (this._pendingPrivacy) this._pendingPrivacy(false);
		this.sessionKey = key;
		const saved = key && this.core.sessions.get(key);
		this.state = saved || this._emptyState();
		if (!saved && item) {
			await this._addItems([item], { quiet: true });
		}
		this._renderDocs();
		this._renderMessages();
		this._updateButtons();
	}

	_saveSession() {
		if (this.sessionKey && (this.state.messages.length || this.state.docs.length)) {
			this.core.sessions.set(this.sessionKey, this.state);
			if (this.core.sessions.size > 40) {
				this.core.sessions.delete(this.core.sessions.keys().next().value);
			}
		}
	}

	async setItems(items, { collectionIDs } = {}) {
		if (collectionIDs) this.collectionIDs = collectionIDs;
		await this._addItems(items || [], {});
	}

	async addSelected() {
		const items = this.core.selectedItems();
		if (!items.length) {
			this._setStatus(this.T("chat.noSelection"), "warn");
			return;
		}
		const cols = this.core.selectedCollectionIDs();
		if (cols.length) this.collectionIDs = cols;
		await this._addItems(items, {});
	}

	async addCollection() {
		const c = this.core.selectedCollectionItems ? this.core.selectedCollectionItems() : { items: [] };
		if (!c.name) {
			this._setStatus(this.T("chat.noCollection"), "warn");
			return;
		}
		if (!c.items.length) {
			this._setStatus(this.T("chat.emptyCollection", { name: c.name }), "warn");
			return;
		}
		if (c.id) this.collectionIDs = [c.id];
		await this._addItems(c.items, {});
	}

	async _addItems(items, { quiet }) {
		const skipped = [];
		let added = 0;
		for (const item of items) {
			let d = null;
			try {
				d = await this.core.describeItem(item);
			}
			catch (e) {
				this.core.log("describeItem: " + e);
			}
			if (!d) {
				const t = item && item.getDisplayTitle ? item.getDisplayTitle() : "item";
				skipped.push(t);
				continue;
			}
			if (this.state.docs.some(x => x.attachmentID === d.attachmentID)) continue;
			d.id = "D" + this.state.nextDocNum++;
			this.state.docs.push(d);
			this.state.allDocs[d.id] = d;
			added++;
		}
		this._renderDocs();
		this._updateButtons();
		if (this.state.docs.length >= 6 && !this.useFichas.checked) {
			this.useFichas.checked = true;
			this._setStatus(this.T("chat.fichasAuto", { n: this.state.docs.length }));
			return;
		}
		if (skipped.length && !quiet) {
			this._setStatus(this.T("chat.skipped", { list: skipped.slice(0, 3).join(", ") + (skipped.length > 3 ? "…" : "") }), "warn");
		}
		else if (added && !quiet) {
			this._setStatus(this.T("chat.inContext", { n: this.state.docs.length }));
		}
		if (!this.state.docs.length && quiet && items.length) {
			this._setStatus(this.T("chat.noPdf"), "warn");
		}
	}

	removeDoc(id) {
		if (this.busy) return;
		this.state.docs = this.state.docs.filter(d => d.id !== id);
		this._renderDocs();
		this._updateButtons();
	}

	_renderDocs() {
		const box = this.docsEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		if (!this.state.docs.length) {
			box.appendChild(this._el("span", "zia-muted",
				this.T(this.mode === "window" ? "chat.noDocs.window" : "chat.noDocs.section")));
			return;
		}
		for (const d of this.state.docs) {
			const chip = this._el("span", "zia-chip");
			chip.title = d.fullRef;
			chip.appendChild(this._el("b", null, d.id));
			chip.appendChild(this.doc.createTextNode(" " + d.shortRef));
			if (this.mode === "window" || this.state.docs.length > 1) {
				const x = this._el("span", "zia-chip-x", "×");
				x.title = this.T("chat.removeDoc");
				x.setAttribute("role", "button");
				x.addEventListener("click", () => this.removeDoc(d.id));
				chip.appendChild(x);
			}
			box.appendChild(chip);
		}
	}

	_updateButtons() {
		const n = this.state.docs.length;
		for (const [id, b] of Object.entries(this.actionButtons || {})) {
			const a = this._action(id);
			if (!a) continue;
			b.disabled = this.busy || n < a.minDocs;
			if (a.minDocs > 1 && n < a.minDocs) {
				b.title = this.mode === "section"
					? this.T("chat.needDocs.section")
					: this.T("chat.needDocs.window", { n: a.minDocs });
			}
			else {
				b.title = a.hint || "";
			}
		}
		this.sendBtn.textContent = this.busy ? this.T("chat.stop") : this.T("chat.send");
		this.sendBtn.classList.toggle("zia-stop", this.busy);
		this.sendBtn.disabled = !this.busy && !n;
		this.engineSel.disabled = this.busy;
		this.newBtn.disabled = this.busy;
		for (const t of this.tabsEl.querySelectorAll(".zia-tab")) t.disabled = this.busy && t.getAttribute("aria-selected") !== "true";
	}

	openInWindow() {
		const items = this.state.docs
			.map(d => Zotero.Items.get(d.parentID || d.attachmentID))
			.filter(Boolean);
		this.core.openWindow({ items, collectionIDs: this.core.selectedCollectionIDs() });
	}

	// ------------------------------------------------------------------
	// Pedidos
	// ------------------------------------------------------------------

	_setStatus(text, kind, working) {
		const s = this.statusEl;
		while (s.firstChild) s.removeChild(s.firstChild);
		if (working) s.appendChild(this._el("span", "zia-spinner"));
		if (text) s.appendChild(this.doc.createTextNode(text));
		s.className = "zia-status" + (kind ? " zia-status-" + kind : "");
	}

	stop() {
		if (this.abort) {
			try { this.abort.abort(); } catch (e) { /* já terminado */ }
		}
	}

	clearConversation() {
		if (this.busy) return;
		this.state.messages = [];
		this._renderMessages();
		this._setStatus("");
	}

	async sendQuestion(text) {
		const q = (text != null ? text : this.textarea.value).trim();
		if (!q || this.busy) return;
		if (!this.state.docs.length) {
			this._setStatus(this.T("chat.addOne"), "warn");
			return;
		}
		if (!this._engineReady()) {
			this._showSetupInline();
			return;
		}
		this.textarea.value = "";
		this._autoGrow();
		await this._ask({
			promptText: q,
			display: q,
			heading: this.T("chat.question") + " · " + (q.length > 60 ? q.slice(0, 57) + "…" : q),
			docs: this.state.docs.slice(),
		});
	}

	async runAction(actionID) {
		if (this.busy) return;
		const a = this._action(actionID);
		if (!a) return;
		const docs = this.state.docs.slice();
		if (docs.length < a.minDocs) {
			this._setStatus(this.T("chat.actionNeeds", { label: a.label, n: a.minDocs }), "warn");
			return;
		}
		if (!this._engineReady()) {
			this._showSetupInline();
			return;
		}
		// Um pedido por documento (cada resposta fica numa nota própria)
		if (a.perDoc) {
			for (const d of docs) {
				const ok = await this._ask({
					promptText: this.L.actionPrompt(a, [d]),
					display: `${a.label}: ${d.id} ${d.shortRef}`,
					heading: actionID === "ficha" ? `${this.L.fichaPrefix()} · ${d.shortRef}` : `${a.title} · ${d.shortRef}`,
					actionID,
					docs: [d],
					noHistory: true,
				});
				if (!ok) break;
			}
			return;
		}
		if (a.fichasOK && docs.length > 1 && this.useFichas.checked) {
			await this._runWithFichas(a, docs);
			return;
		}
		await this._ask({
			promptText: this.L.actionPrompt(a, docs),
			display: `${a.label}${docs.length > 1 ? ` (${docs.map(d => d.id).join(", ")})` : ""}`,
			heading: `${a.title} · ${docs.map(d => d.shortRef).join(", ").slice(0, 120)}`,
			actionID,
			docs,
		});
	}

	/** Ação sobre fichas: reutiliza notas "Ficha IA" e cria as que faltam. */
	async _runWithFichas(a, docs) {
		const fichaDocs = [];
		const autoSave = this.core.pref("fichas.autoSave") !== false;
		let reused = 0, created = 0;
		for (const d of docs) {
			const note = this.core.findFichaNote(d.parentID);
			if (note) {
				fichaDocs.push(Object.assign({}, d, { kind: "ficha", fichaText: this.core.noteToText(note) }));
				reused++;
				continue;
			}
			const msg = await this._ask({
				promptText: this.L.actionPrompt("ficha", [d]),
				display: this.T("chat.fichaFor", { doc: `${d.id} ${d.shortRef}`, action: a.label.toLowerCase() }),
				heading: `${this.L.fichaPrefix()} · ${d.shortRef}`,
				actionID: "ficha",
				docs: [d],
				noHistory: true,
				returnMessage: true,
			});
			if (!msg || msg.error) return;
			created++;
			if (autoSave && d.parentID) {
				try {
					await this._saveMessageNote(msg, { quiet: true });
				}
				catch (e) {
					this.core.log("Falha ao guardar ficha: " + e);
				}
			}
			fichaDocs.push(Object.assign({}, d, { kind: "ficha", fichaText: msg.text }));
		}
		this._setStatus(this.T("chat.fichasDone", { reused, created }));
		await this._ask({
			promptText: this.L.actionPrompt(a, docs) + "\n\nTrabalha sobre as fichas de extração fornecidas.",
			display: this.T("chat.viaFichas", { label: a.label, docs: docs.map(d => d.id).join(", ") }),
			heading: `${a.title} · ${docs.map(d => d.shortRef).join(", ").slice(0, 120)}`,
			actionID: a.id,
			docs: fichaDocs,
		});
	}

	/**
	 * Envia um pedido e mostra a resposta em fluxo.
	 * Devolve true/false (ou a mensagem, se returnMessage).
	 */
	async _ask({ promptText, display, heading, actionID, docs, noHistory, returnMessage, engine }) {
		if (this.busy) return false;
		engine = engine || this.engine;
		if (!this.core.isEngineReady(engine)) {
			this._showSetupInline();
			return false;
		}
		if (!(await this._ensurePrivacy(engine))) {
			this._setStatus(this.T("chat.notSent"));
			return false;
		}
		if (this.busy) return false;
		const history = noHistory ? [] : this.state.messages
			.filter(m => !m.error && m.text && !m.pending)
			.map(m => ({ role: m.role, text: m.role === "user" ? m.promptText : m.text }));
		const userMsg = { role: "user", promptText, display, docIDs: docs.map(d => d.id) };
		const action = actionID ? this._action(actionID) : null;
		const botMsg = {
			role: "assistant", text: "", pending: true, heading, actionID, engine,
			actionLabel: action ? action.label : null,
			docIDs: docs.map(d => d.id), request: { promptText, display, heading, actionID, docs, noHistory },
		};
		this.state.messages.push(userMsg, botMsg);
		this._appendMessage(userMsg);
		this._appendMessage(botMsg);
		this.busy = true;
		this.abort = new this.win.AbortController();
		this._updateButtons();
		const t0 = Date.now();
		try {
			// 1. Texto dos PDFs
			const pdfDocs = docs.filter(d => d.kind !== "ficha" && !d.pages);
			for (let i = 0; i < pdfDocs.length; i++) {
				if (this.abort.signal.aborted) throw Object.assign(new Error(this.T("err.aborted")), { kind: "aborted" });
				this._setStatus(this.T("chat.reading", { i: i + 1, n: pdfDocs.length, ref: pdfDocs[i].shortRef }), null, true);
				await this.core.loadText(pdfDocs[i]);
				// guarda o texto também no documento original do contexto
				const orig = this.state.allDocs[pdfDocs[i].id];
				if (orig && orig !== pdfDocs[i]) Object.assign(orig, { pages: pdfDocs[i].pages, pagesReliable: pdfDocs[i].pagesReliable, chars: pdfDocs[i].chars });
			}
			for (const d of docs) {
				if (d.kind !== "ficha" && !d.pages) {
					const orig = this.state.allDocs[d.id];
					if (orig && orig.pages) Object.assign(d, { pages: orig.pages, pagesReliable: orig.pagesReliable });
				}
			}
			// Anotações do utilizador (opcional)
			const withAnn = !!this.core.pref("context.annotations");
			for (const d of docs) {
				if (d.kind === "ficha") continue;
				d.annotations = withAnn && this.core.loadAnnotations ? this.core.loadAnnotations(d) : null;
			}
			// 2. Ajuste de tamanho
			const fitted = this.L.fitDocuments(docs, this.core.maxCharsFor(engine));
			botMsg.warnings = fitted.warnings.slice();
			if (fitted.warnings.length && docs.length > 1 && !docs.some(d => d.kind === "ficha")) {
				botMsg.warnings.push(this.T("chat.fichasTip"));
			}
			const promptParts = this.L.buildRequestParts({ fitted, history, userText: promptText });
			const prompt = promptParts.docs + "\n\n" + promptParts.rest;
			const kchars = Math.round(prompt.length / 1000);
			this._setStatus(this.T("chat.analysing", { engine: this.core.engineLabel(engine), n: docs.length, k: kchars }), null, true);
			this._renderMessage(botMsg);
			// 3. Motor
			const res = await this.core.runEngine(engine, {
				system: this.L.buildSystemPrompt(this.core.pref("answerLang")),
				prompt,
				promptParts,
				win: this.win,
				signal: this.abort.signal,
				onDelta: (d, all) => {
					botMsg.text = all;
					this._scheduleRender(botMsg);
				},
				onInfo: info => {
					if (info && info.notice) this._setStatus(info.notice, "warn");
					const rl = this.L.formatRateLimit(info && info.rateLimit);
					if (rl) botMsg.usageNote = rl;
				},
			});
			botMsg.text = res.text || botMsg.text;
			botMsg.model = res.model || null;
			if (res.rateLimit) botMsg.usageNote = this.L.formatRateLimit(res.rateLimit) || botMsg.usageNote;
			if (res.notice) botMsg.usageNote = res.notice;
			botMsg.tokensNote = this.L.formatUsage(res.usage, engine);
			if (actionID === "etiquetas") {
				botMsg.tags = this.L.parseTagLine(botMsg.text);
				if (botMsg.tags.length) botMsg.text = this.L.removeTagLine(botMsg.text);
			}
			botMsg.pending = false;
			this.core.setPref(engine + ".lastTest", "ok");
			const secs = Math.round((Date.now() - t0) / 1000);
			this._setStatus(this.T("chat.done", { s: secs, engine: this.core.engineLabel(engine) }) + (botMsg.usageNote ? ` ${botMsg.usageNote}.` : ""));
		}
		catch (e) {
			botMsg.pending = false;
			botMsg.error = (e && e.message) || String(e);
			botMsg.errorKind = (e && e.kind) || "other";
			if (botMsg.errorKind === "aborted") {
				botMsg.error = this.T("err.aborted");
			}
			// Estado nas definições: o motor não está a funcionar (falta programa, chave ou sessão)
			if (botMsg.errorKind === "notfound" || botMsg.errorKind === "auth") this.core.setPref(engine + ".lastTest", "fail");
			this.core.log("Erro: " + botMsg.error);
			this._setStatus(this.T(botMsg.errorKind === "aborted" ? "chat.cancelled" : "chat.error"), botMsg.errorKind === "aborted" ? null : "error");
		}
		finally {
			this.busy = false;
			this.abort = null;
			this._cancelRender();
			this._renderMessage(botMsg);
			this._updateButtons();
			this._saveSession();
		}
		if (returnMessage) return botMsg;
		return !botMsg.error;
	}

	async _retry(msg, engine) {
		if (this.busy || !msg.request) return;
		if (!this.core.isEngineReady(engine)) {
			this._setEngine(engine);
			return;
		}
		// retira o par pergunta/resposta e repete
		const idx = this.state.messages.indexOf(msg);
		if (idx > 0) this.state.messages.splice(idx - 1, 2);
		this._renderMessages();
		await this._ask(Object.assign({}, msg.request, { engine }));
	}

	// ------------------------------------------------------------------
	// Configuração inicial e privacidade
	// ------------------------------------------------------------------

	_setupCard() {
		const card = this._el("div", "zia-card zia-setup");
		card.appendChild(this._el("div", "zia-card-title", this.T("setup.title")));
		card.appendChild(this._el("p", "zia-card-text", this.T("setup.text")));
		// Um fornecedor por linha, com as formas de ligação disponíveis
		const providers = [
			{ id: "claude", options: [
				{ engine: "anthropic", label: "setup.btn.key" },
				{ engine: "claude", label: "setup.btn.claudeCode", local: true },
			] },
			{ id: "openai", options: [
				{ engine: "codex", label: "setup.btn.codex", local: true },
				{ engine: "openai", label: "setup.btn.key" },
			] },
			{ id: "gemini", options: [
				{ engine: "gemini", label: "setup.btn.geminiKey" },
			] },
		];
		for (const p of providers) {
			const row = this._el("div", "zia-option");
			const txt = this._el("div", "zia-option-text");
			const title = this._el("div", "zia-option-title", this.T(`setup.${p.id}.title`));
			if (p.options.some(o => this.core.isEngineReady(o.engine))) title.appendChild(this._el("span", "zia-ok", this.T("setup.configured")));
			txt.appendChild(title);
			txt.appendChild(this._el("div", "zia-option-desc", this.T(`setup.${p.id}.text`)));
			row.appendChild(txt);
			const btns = this._el("div", "zia-option-btns");
			for (const o of p.options) {
				const ready = this.core.isEngineReady(o.engine);
				const label = ready ? `${this.T("setup.use")} ${this.core.engineLabel(o.engine)}` : this.T(o.label);
				const b = this._button(label, "zia-btn-small" + (ready ? " zia-btn-primary" : ""), () => {
					if (ready) this._setEngine(o.engine);
					else if (o.local) this._enableLocal(o.engine);
					else this._openPrefs();
				});
				b.dataset.engine = o.engine;
				btns.appendChild(b);
			}
			row.appendChild(btns);
			card.appendChild(row);
		}
		return card;
	}

	/** Claude Code ou Codex: ativa o motor local (a ligação é testada no primeiro pedido). */
	_enableLocal(engine) {
		this.core.setPref(engine + ".enabled", true);
		this.core.setPref("engine", engine);
		this.engine = engine;
		this._renderEngines();
		this._renderMessages();
		this._updateButtons();
		this._setStatus(this.T(engine === "codex" ? "chat.codexChosen" : "chat.claudeChosen"));
	}

	/** Mostra o cartão de configuração no fim da conversa (sem apagar mensagens). */
	_showSetupInline() {
		const old = this.messagesEl.querySelector(".zia-setup");
		if (old) old.remove();
		if (!this.state.messages.length) {
			this._renderMessages();
		}
		else {
			this.messagesEl.appendChild(this._setupCard());
			this._scrollToEnd(true);
		}
		this._setStatus(this.engine ? this.T("chat.setupMissing", { engine: this.core.engineLabel(this.engine) }) : this.T("chat.chooseEngine"), "warn");
	}

	_privacyText(engine) {
		return this.T("privacy." + engine);
	}

	/** Na primeira vez com cada motor, explica o que é enviado e pede confirmação. */
	_ensurePrivacy(engine) {
		const key = "privacy.ack." + engine;
		if (this.core.pref(key)) return Promise.resolve(true);
		if (this._pendingPrivacy) this._pendingPrivacy(false);
		const provider = (this.core.ENGINES[engine] || {}).provider || this.T("privacy.provider");
		return new Promise(resolve => {
			const card = this._el("div", "zia-card zia-privacy");
			const done = ok => {
				if (this._pendingPrivacy !== done) return;
				this._pendingPrivacy = null;
				card.remove();
				if (ok) this.core.setPref(key, true);
				if (!this.state.messages.length) this._renderMessages();
				resolve(ok);
			};
			this._pendingPrivacy = done;
			card.appendChild(this._el("div", "zia-card-title", this.T("privacy.title", { engine: this.core.engineLabel(engine) })));
			card.appendChild(this._el("p", "zia-card-text", this.T("privacy.sent", { provider })));
			card.appendChild(this._el("p", "zia-card-text", this._privacyText(engine)));
			card.appendChild(this._el("p", "zia-card-text", this.T("privacy.warning")));
			const row = this._el("div", "zia-msg-tools");
			row.appendChild(this._button(this.T("privacy.accept"), "zia-btn-small zia-btn-primary", () => done(true)));
			row.appendChild(this._button(this.T("privacy.cancel"), "zia-btn-small", () => done(false)));
			card.appendChild(row);
			const empty = this.messagesEl.querySelector(".zia-empty");
			if (empty) empty.remove();
			this.messagesEl.appendChild(card);
			this._scrollToEnd(true);
		});
	}

	// ------------------------------------------------------------------
	// Mensagens
	// ------------------------------------------------------------------

	_docsMap() {
		return this.state.allDocs;
	}

	_suggestions() {
		const kind = this.state.docs.length > 1 ? "multi" : "one";
		return [1, 2, 3, 4].map(i => this.T(`chat.sug.${kind}.${i}`));
	}

	_renderMessages() {
		const box = this.messagesEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		if (!this.state.messages.length) {
			if (!this._engineReady()) {
				box.appendChild(this._setupCard());
				return;
			}
			const help = this._el("div", "zia-empty");
			help.appendChild(this._el("p", null, this.T(this.mode === "window" ? "chat.empty.window" : "chat.empty.section")));
			if (this.state.docs.length) {
				const sug = this._el("div", "zia-suggestions");
				for (const q of this._suggestions()) {
					const s = this._button(q, "zia-suggestion", () => this.sendQuestion(q));
					sug.appendChild(s);
				}
				help.appendChild(sug);
			}
			help.appendChild(this._el("p", "zia-tip", this.T("chat.tip")));
			box.appendChild(help);
			return;
		}
		for (const m of this.state.messages) this._appendMessage(m);
	}

	_appendMessage(m) {
		const empty = this.messagesEl.querySelector(".zia-empty, .zia-setup");
		if (empty) empty.remove();
		m.el = this._el("div", "zia-msg zia-msg-" + m.role);
		const privacy = this.messagesEl.querySelector(".zia-privacy");
		if (privacy) this.messagesEl.insertBefore(m.el, privacy);
		else this.messagesEl.appendChild(m.el);
		this._renderMessage(m);
		this._scrollToEnd(true);
	}

	_scheduleRender(m) {
		if (this._renderTimer) return;
		this._renderTimer = setTimeout(() => {
			this._renderTimer = null;
			this._renderMessage(m);
		}, 180);
	}

	_cancelRender() {
		if (this._renderTimer) {
			clearTimeout(this._renderTimer);
			this._renderTimer = null;
		}
	}

	_nearBottom() {
		const b = this.messagesEl;
		return b.scrollHeight - b.scrollTop - b.clientHeight < 80;
	}

	_scrollToEnd(force) {
		const b = this.messagesEl;
		if (force || this._nearBottom()) b.scrollTop = b.scrollHeight;
	}

	_renderMessage(m) {
		if (!m.el) return;
		const stick = this._nearBottom();
		const el = m.el;
		while (el.firstChild) el.removeChild(el.firstChild);
		if (m.role === "user") {
			el.appendChild(this._el("div", "zia-user-text", m.display));
			return;
		}
		// Resposta
		const head = this._el("div", "zia-msg-head");
		if (m.actionLabel) head.appendChild(this._el("span", "zia-action-tag", m.actionLabel));
		head.appendChild(this._el("span", "zia-engine-tag", this.core.engineLabel(m.engine) + (m.model ? ` · ${m.model}` : "")));
		el.appendChild(head);
		if (m.warnings && m.warnings.length) {
			const w = this._el("div", "zia-warn");
			for (const t of m.warnings) w.appendChild(this._el("div", null, t));
			el.appendChild(w);
		}
		const body = this._el("div", "zia-md");
		const ctx = {
			docsMap: this._docsMap(),
			onCite: c => this._openCite(c),
			onLink: href => this._openLink(href),
		};
		if (m.text) {
			try {
				this.L.renderMarkdownInto(this.doc, body, m.text, ctx);
			}
			catch (e) {
				body.textContent = m.text;
			}
		}
		if (m.pending) {
			body.appendChild(this._el("span", "zia-typing", m.text ? " ▍" : this.T("chat.preparing")));
		}
		el.appendChild(body);
		if (m.error) {
			el.appendChild(this._el("div", "zia-error", m.error));
			const row = this._el("div", "zia-msg-tools");
			if (m.engine === "claude" && (m.errorKind === "notfound" || m.errorKind === "auth")) {
				row.appendChild(this._button(this.T("chat.claudeSetup"), "zia-btn-small zia-btn-primary", () => this._setupClaude()));
			}
			if (m.errorKind !== "notconfigured") {
				row.appendChild(this._button(this.T("chat.retry"), "zia-btn-small", () => this._retry(m, m.engine)));
			}
			for (const other of this._otherReadyEngines(m.engine)) {
				row.appendChild(this._button(this.T("chat.retryWith", { engine: this.core.engineLabel(other) }), "zia-btn-small", () => this._retry(m, other)));
			}
			if (["notfound", "auth", "model", "version", "billing", "notconfigured"].includes(m.errorKind)) {
				row.appendChild(this._button(this.T("chat.settings"), "zia-btn-small", () => this._openPrefs()));
			}
			el.appendChild(row);
		}
		else if (!m.pending && m.text) {
			if (m.tags && m.tags.length) el.appendChild(this._tagsRow(m));
			el.appendChild(this._messageTools(m));
		}
		if (stick || m.pending) this._scrollToEnd(false);
	}

	_tagsRow(m) {
		const row = this._el("div", "zia-tags");
		for (const t of m.tags) row.appendChild(this._el("span", "zia-tag", t));
		const d = (m.docIDs || []).map(id => this._docsMap()[id]).find(Boolean);
		const target = d && (d.parentID || d.attachmentID);
		if (target) {
			const b = this._button(this.T(m.tagsAdded ? "chat.tagsAdded" : "chat.tagsAdd"), "zia-btn-small zia-btn-primary", async () => {
				if (m.tagsAdded) return;
				try {
					const n = await this.core.addTags(target, m.tags);
					m.tagsAdded = true;
					this._setStatus(n ? this.T("chat.tagsAddedN", { n, ref: d.shortRef }) : this.T("chat.tagsAlready"));
					this._renderMessage(m);
				}
				catch (e) {
					this._setStatus(this.T("chat.tagsError", { e: e.message || e }), "error");
				}
			}, this.T("chat.tagsAdd.tip"));
			b.disabled = !!m.tagsAdded;
			row.appendChild(b);
		}
		return row;
	}

	_messageTools(m) {
		const row = this._el("div", "zia-msg-tools");
		row.appendChild(this._button(this.T("chat.copy"), "zia-btn-small", () => {
			this.core.copyToClipboard(this.L.citesToText(m.text, this._docsMap()));
			this._setStatus(this.T("chat.copied"));
		}, this.T("chat.copy.tip")));
		const saveBtn = this._button(this.T(m.noteID ? "chat.noteSaved" : "chat.saveNote"), "zia-btn-small", async () => {
			if (m.noteID) {
				this._showNote(m.noteID);
				return;
			}
			try {
				await this._saveMessageNote(m);
				this._renderMessage(m);
			}
			catch (e) {
				this._setStatus(this.T("chat.noteError", { e: e.message || e }), "error");
			}
		});
		saveBtn.title = this.T(m.noteID ? "chat.noteSaved.tip" : "chat.saveNote.tip");
		row.appendChild(saveBtn);
		if (this.L.extractTables(m.text).length) {
			row.appendChild(this._button(this.T("chat.exportCsv"), "zia-btn-small", async () => {
				const csv = this.L.tablesToCSV(m.text, { docsMap: this._docsMap() });
				try {
					const path = await this.core.saveCSV(this.win, csv, m.heading || "tabela");
					if (path) this._setStatus(this.T("chat.exported", { path }));
				}
				catch (e) {
					this._setStatus(this.T("chat.exportError", { e: e.message || e }), "error");
				}
			}, this.T("chat.exportCsv.tip")));
		}
		for (const other of this._otherReadyEngines(m.engine).slice(0, 2)) {
			row.appendChild(this._button(this.T("chat.retryWith", { engine: this.core.engineLabel(other) }), "zia-btn-small zia-btn-quiet", () => this._retry(m, other)));
		}
		const notes = [m.usageNote, m.tokensNote].filter(Boolean);
		if (notes.length) row.appendChild(this._el("span", "zia-usage", notes.join(" · ")));
		return row;
	}

	async _saveMessageNote(m, { quiet } = {}) {
		const docsMap = this._docsMap();
		const docs = (m.docIDs || []).map(id => docsMap[id]).filter(Boolean);
		if (!docs.length) throw new Error("sem documentos associados");
		const note = await this.core.saveNote({
			markdown: m.text,
			heading: m.heading || this.T("note.defaultHeading"),
			docs,
			docsMap,
			engine: m.engine,
			collectionIDs: this.collectionIDs.length ? this.collectionIDs : this.core.selectedCollectionIDs(),
		});
		m.noteID = note.id;
		if (!quiet) {
			this._setStatus(this.T(note.parentID ? "chat.noteSavedChild" : "chat.noteSavedStandalone"));
		}
		return note;
	}

	_showNote(noteID) {
		const win = Zotero.getMainWindow();
		if (!win) return;
		try {
			if (win.Zotero_Tabs) win.Zotero_Tabs.select("zotero-pane");
			win.ZoteroPane.selectItem(noteID);
			win.focus();
		}
		catch (e) {
			this.core.log("selectItem: " + e);
		}
	}

	_openCite(c) {
		const d = this._docsMap()[c.doc];
		if (!d) {
			this._setStatus(this.T("chat.docMissing", { doc: c.doc }), "warn");
			return;
		}
		this.core.openAtPage(d, c.page).catch(e => this._setStatus(this.T("chat.openError", { e }), "error"));
	}

	/** Ligações escritas pela IA: só http(s), abertas no navegador do sistema. */
	_openLink(href) {
		if (!/^https?:\/\//i.test(String(href || ""))) return;
		Zotero.launchURL(href);
	}

	/** Instala o Claude Code (se faltar) e abre o início de sessão numa janela visível. */
	async _setupClaude() {
		const msg = this.T("prefs.claude.installConfirm");
		const ok = (typeof Services !== "undefined" && Services.prompt)
			? Services.prompt.confirm(this.win, this.T("chat.claudeSetup"), msg)
			: this.win.confirm(msg);
		if (!ok) return;
		try {
			const r = await this.core.openClaudeSetup();
			if (r.opened) this._setStatus(this.T("chat.claudeSetupOpened"));
			else this._openPrefs();
		}
		catch (e) {
			this._setStatus(e.message || String(e), "error");
		}
	}

	_openPrefs() {
		try {
			Zotero.Utilities.Internal.openPreferences(this.core.PREFS_PANE_ID);
		}
		catch (e) {
			this.core.log("openPreferences: " + e);
		}
	}
};
