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
		const messages = [];
		// Várias conversas por artigo, em separadores: convs[active] é a conversa à vista
		return { docs: [], allDocs: {}, nextDocNum: 1, messages, convs: [messages], active: 0 };
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

		// Seletor de PDFs para juntar à conversa (por exemplo, para comparar)
		this.pickerEl = this._el("div", "zia-picker");
		this.pickerEl.hidden = true;
		root.appendChild(this.pickerEl);

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

		// Pedido escolhido (ação à espera de ser enviada)
		this.pendingEl = this._el("div", "zia-pending");
		this.pendingEl.hidden = true;
		root.appendChild(this.pendingEl);

		// Entrada
		const input = this._el("div", "zia-input");
		this.textarea = this._el("textarea", "zia-textarea");
		this.textarea.setAttribute("rows", "2");
		this.textarea.setAttribute("placeholder", this.T("chat.placeholder"));
		this.textarea.addEventListener("keydown", ev => {
			if (ev.key === "Escape" && this.busy) {
				ev.preventDefault();
				this.stop();
			}
		});
		this.textarea.addEventListener("input", () => this._autoGrow());
		input.appendChild(this.textarea);
		this.sendBtn = this._button(this.T("chat.send"), "zia-send", () => (this.busy ? this.stop() : this.sendQuestion()));
		input.appendChild(this.sendBtn);
		root.appendChild(input);

		// Estado
		this.statusEl = this._el("div", "zia-status");
		root.appendChild(this.statusEl);

		// Separadores das conversas (Nova conversa abre outra sem apagar a anterior)
		this.convTabsEl = this._el("div", "zia-conv-tabs");
		this.convTabsEl.setAttribute("role", "tablist");
		root.appendChild(this.convTabsEl);

		// Respostas, por baixo da caixa de texto: a mais recente fica em cima
		this.messagesEl = this._el("div", "zia-messages");
		this.messagesEl.setAttribute("aria-live", "polite");
		root.appendChild(this.messagesEl);

		const tail = this._el("div", "zia-footer");
		this.newBtn = this._button(this.T("chat.new"), "zia-link-btn", () => this.newConversation(), this.T("chat.new.tip"));
		tail.appendChild(this.newBtn);
		if (this.mode === "section") {
			tail.appendChild(this._button(this.T("chat.openWindow"), "zia-link-btn", () => this.openInWindow(),
				this.T("chat.openWindow.tip")));
		}
		root.appendChild(tail);

		this.container.appendChild(root);
		this._renderPending();
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
		const main = this.core.MAIN_ENGINES || this.core.ENGINE_ORDER;
		for (const id of this.core.ENGINE_ORDER) {
			const ready = this.core.isEngineReady(id);
			if (!main.includes(id) && !ready && id !== this.engine) continue;
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
		const groups = this.L.ACTION_GROUPS;
		if (!groups.some(g => g.id === this.group)) this.group = groups[0].id;
		// No painel lateral, comparar faz-se só na janela grande: o separador leva lá
		const external = g => this.mode === "section" && g.id === "comparar";
		if (external({ id: this.group })) this.group = groups[0].id;
		for (const g of groups) {
			const t = this._button(g.label + (external(g) ? " ↗" : ""), "zia-tab" + (external(g) ? " zia-tab-external" : ""), () => {
				if (external(g)) {
					this.openInWindow({ group: "comparar" });
					return;
				}
				this.group = g.id;
				this.core.setPref("ui.group", g.id);
				this._renderTabs();
			}, external(g) ? this.T("chat.compareInWindow") : null);
			t.setAttribute("role", "tab");
			t.setAttribute("aria-selected", g.id === this.group ? "true" : "false");
			t.dataset.group = g.id;
			box.appendChild(t);
		}
		this._renderActions();
	}

	_renderActions() {
		const box = this.actionsEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		this.actionButtons = {};
		const list = this._actionsOfGroup(this.group);
		const custom = this.group === "meus";
		if (custom && !list.length && !this._customForm) {
			box.appendChild(this._el("div", "zia-meus-empty", this.T("chat.meus.empty")));
		}
		for (const a of list) {
			const b = this._button(a.label, "zia-action" + (custom && this._editCustom ? " zia-editing" : ""),
				() => (custom && this._editCustom ? this._openCustomForm(a) : this.selectAction(a.id)), a.hint);
			b.dataset.action = a.id;
			if (!(custom && this._editCustom)) this.actionButtons[a.id] = b;
			box.appendChild(b);
			// Ficha: botão "i" com a explicação do que é e dos campos
			if (a.id === "ficha") {
				const info = this._button("i", "zia-info-btn", () => {
					this._fichaInfoOpen = !this._fichaInfoOpen;
					this._renderActions();
				}, this.T("ficha.info.tip"));
				info.setAttribute("aria-expanded", this._fichaInfoOpen ? "true" : "false");
				box.appendChild(info);
			}
		}
		// Na janela, a lista das fichas aparece também em Comparar (onde se usam)
		if (this.mode === "window" && this.group === "comparar") {
			const fl = this._fichasListEl();
			if (fl) box.appendChild(fl);
		}
		if (this.group === "escrever") {
			if (this._fichaInfoOpen) box.appendChild(this._fichaInfoEl());
			const fl = this._fichasListEl();
			if (fl) box.appendChild(fl);
		}
		if (custom) {
			box.appendChild(this._button(this.T("chat.meus.new"), "zia-action zia-action-new", () => this._openCustomForm(null)));
			if (list.length) {
				box.appendChild(this._button(this.T(this._editCustom ? "chat.meus.doneEdit" : "chat.meus.edit"), "zia-btn-small zia-btn-quiet", () => {
					this._editCustom = !this._editCustom;
					this._customForm = null;
					this._renderActions();
					this._setStatus(this._editCustom ? this.T("chat.meus.pickToEdit") : "");
				}));
			}
			if (this._customForm) box.appendChild(this._customFormEl());
		}
		if (this.group !== "compreender" && !custom) {
			box.appendChild(this.fichasLabel);
			if (this.mode === "window" && this.group !== "escrever") {
				const info = this._button("i", "zia-info-btn", () => {
					this._fichaInfoOpen = !this._fichaInfoOpen;
					this._renderActions();
				}, this.T("ficha.info.tip"));
				info.setAttribute("aria-expanded", this._fichaInfoOpen ? "true" : "false");
				box.appendChild(info);
				if (this._fichaInfoOpen) box.appendChild(this._fichaInfoEl());
			}
		}
		this._updateButtons();
	}

	/** Explicação das fichas: o que são, onde ficam e os campos. */
	_fichaInfoEl() {
		const box = this._el("div", "zia-info-panel");
		box.setAttribute("role", "note");
		const close = this._button("×", "zia-info-close", () => { this._fichaInfoOpen = false; this._renderActions(); }, this.T("chat.dismiss"));
		box.appendChild(close);
		box.appendChild(this._el("div", "zia-info-title", this.T("ficha.info.title")));
		box.appendChild(this._el("p", null, this.T("ficha.info.what")));
		box.appendChild(this._el("p", null, this.T("ficha.info.where")));
		box.appendChild(this._el("div", "zia-info-sub", this.T("ficha.info.fieldsTitle")));
		const ul = this._el("ul", "zia-info-fields");
		for (const f of this.T("ficha.info.fields").split("|")) ul.appendChild(this._el("li", null, f.trim()));
		box.appendChild(ul);
		box.appendChild(this._el("p", "zia-muted", this.T("ficha.info.pages")));
		return box;
	}

	/** Fichas dos artigos da conversa: abrir as que existem (notas do Zotero) e criar as que faltam. */
	_fichasListEl() {
		const docs = this.state.docs.filter(d => d.parentID);
		if (!docs.length || !this.core.findFichaNote) return null;
		const box = this._el("div", "zia-fichas-list");
		box.appendChild(this._el("span", "zia-fichas-label", this.T("ficha.list.label")));
		for (const d of docs) {
			let note = null;
			try { note = this.core.findFichaNote(d.parentID); }
			catch (e) { /* sem acesso às notas */ }
			if (note) {
				box.appendChild(this._button("✓ " + d.shortRef, "zia-ficha-chip zia-ficha-ok", () => this._showNote(note.id), this.T("ficha.list.open")));
			}
			else {
				box.appendChild(this._button("+ " + d.shortRef, "zia-ficha-chip zia-ficha-missing", () => this._createFicha(d), this.T("ficha.list.create")));
			}
		}
		return box;
	}

	/** Cria a ficha de um artigo e guarda-a logo como nota (o registo fica no Zotero). */
	async _createFicha(d) {
		if (this.busy) return;
		if (!this._engineReady()) {
			this._showSetupInline();
			return;
		}
		const msg = await this._ask({
			promptText: this.L.actionPrompt("ficha", [d]),
			display: `${this._action("ficha").label}: ${d.id} ${d.shortRef}`,
			heading: `${this.L.fichaPrefix()} · ${d.shortRef}`,
			actionID: "ficha",
			docs: [d],
			noHistory: true,
			returnMessage: true,
		});
		if (!msg || msg.error) return;
		try {
			await this._saveMessageNote(msg, { quiet: true });
			this._renderMessage(msg);
			this._persist();
			this._setStatus(this.T("ficha.list.saved", { ref: d.shortRef }));
		}
		catch (e) {
			this._setStatus(this.T("chat.noteError", { e: e.message || e }), "error");
		}
		this._renderActions();
	}

	_openCustomForm(action) {
		if (this.busy) return;
		this._customForm = action ? { oldLabel: action.label, label: action.label, prompt: action.prompt } : { oldLabel: null, label: "", prompt: "" };
		if (this.selectedAction) this.selectAction(this.selectedAction);
		this._renderActions();
		const input = this.actionsEl.querySelector(".zia-custom-name");
		if (input) input.focus();
	}

	/** Formulário para criar ou editar uma ação própria (guardada na preferência custom.prompts). */
	_customFormEl() {
		const f = this._customForm;
		const form = this._el("div", "zia-custom-form");
		form.appendChild(this._el("div", "zia-custom-title", this.T(f.oldLabel ? "chat.meus.editTitle" : "chat.meus.newTitle")));
		const name = this._el("input", "zia-custom-name");
		name.setAttribute("type", "text");
		name.setAttribute("maxlength", "40");
		name.setAttribute("placeholder", this.T("chat.meus.namePh"));
		name.setAttribute("aria-label", this.T("chat.meus.name"));
		name.value = f.label;
		const instr = this._el("textarea", "zia-custom-prompt");
		instr.setAttribute("rows", "3");
		instr.setAttribute("placeholder", this.T("chat.meus.promptPh"));
		instr.setAttribute("aria-label", this.T("chat.meus.prompt"));
		instr.value = f.prompt;
		name.addEventListener("input", () => { f.label = name.value; });
		instr.addEventListener("input", () => { f.prompt = instr.value; });
		form.append(name, instr);
		const row = this._el("div", "zia-custom-btns");
		row.appendChild(this._button(this.T("chat.meus.save"), "zia-btn-small zia-btn-primary", () => {
			const c = this.L.cleanCustomPrompt(f.label, f.prompt);
			if (!c.label || !c.prompt) {
				this._setStatus(this.T("chat.meus.missing"), "warn");
				return;
			}
			const src = this.core.pref("custom.prompts") || "";
			const others = this._customActions().filter(a => a.label !== f.oldLabel);
			if (others.some(a => a.label.toLowerCase() === c.label.toLowerCase())) {
				this._setStatus(this.T("chat.meus.duplicate", { label: c.label }), "warn");
				return;
			}
			this.core.setPref("custom.prompts", this.L.setCustomPrompt(src, f.oldLabel, c.label, c.prompt));
			this._customForm = null;
			this._editCustom = false;
			this._renderActions();
			this._setStatus(this.T("chat.meus.saved", { label: c.label }));
		}));
		row.appendChild(this._button(this.T("chat.meus.cancel"), "zia-btn-small", () => {
			this._customForm = null;
			this._renderActions();
			this._setStatus("");
		}));
		if (f.oldLabel) {
			row.appendChild(this._button(this.T("chat.meus.delete"), "zia-btn-small zia-btn-danger", () => this._deleteCustom(f.oldLabel)));
		}
		form.appendChild(row);
		return form;
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
		this.historyKey = item && item.key ? `${item.libraryID}_${item.key}` : null;
		this.selectedAction = null;
		this._renderPending();
		const saved = key && this.core.sessions.get(key);
		this.state = saved || this._emptyState();
		if (!saved && item) {
			await this._addItems([item], { quiet: true });
			// Conversa guardada de uma sessão anterior do Zotero
			const old = this.core.loadConversation ? await this.core.loadConversation(this.historyKey) : null;
			if (old && old.convs && old.convs.some(c => c.length) && this.sessionKey === key) {
				this.state.convs = old.convs.map(c => c.map(m => Object.assign({}, m, { collapsed: m.role === "assistant" })));
				this.state.active = Math.min(Math.max(0, old.active || 0), this.state.convs.length - 1);
				this.state.messages = this.state.convs[this.state.active];
				const last = [...this.state.messages].reverse().find(m => m.role === "assistant");
				if (last) last.collapsed = false;
				this._setStatus(this.T("chat.historyLoaded", { n: this.state.messages.filter(m => m.role === "assistant").length }));
			}
		}
		this._renderDocs();
		this._renderMessages();
		this._updateButtons();
	}

	// ------------------------------------------------------------------
	// Várias conversas por artigo (separadores)
	// ------------------------------------------------------------------

	_ensureConvs() {
		if (!this.state.convs) {
			this.state.convs = [this.state.messages];
			this.state.active = 0;
		}
	}

	/** Título de uma conversa: a primeira ação pedida ou o início da primeira pergunta. */
	_convTitle(msgs) {
		const a = msgs.find(m => m.role === "assistant");
		if (a && a.actionLabel) return a.actionLabel.split(" · ")[0];
		const q = msgs.find(m => m.role === "user");
		if (q && q.display) return q.display.length > 28 ? q.display.slice(0, 26) + "…" : q.display;
		return this.T("chat.new");
	}

	_renderConvTabs() {
		this._ensureConvs();
		const box = this.convTabsEl;
		if (!box) return;
		while (box.firstChild) box.removeChild(box.firstChild);
		const convs = this.state.convs;
		box.hidden = convs.length < 2;
		if (box.hidden) return;
		convs.forEach((msgs, i) => {
			const tab = this._el("div", "zia-conv-tab" + (i === this.state.active ? " zia-conv-active" : ""));
			tab.setAttribute("role", "tab");
			tab.setAttribute("aria-selected", i === this.state.active ? "true" : "false");
			const label = this._button(this._convTitle(msgs), "zia-conv-label", () => this.switchConversation(i));
			label.title = this._convTitle(msgs);
			tab.appendChild(label);
			tab.appendChild(this._button("×", "zia-conv-close", () => this.closeConversation(i), this.T("chat.conv.close")));
			box.appendChild(tab);
		});
	}

	/** Nova conversa num separador novo; a anterior fica guardada no seu separador. */
	newConversation() {
		if (this.busy) return;
		this._ensureConvs();
		if (!this.state.messages.length) {
			this._setStatus(this.T("chat.conv.alreadyNew"));
			return;
		}
		const fresh = [];
		this.state.convs.push(fresh);
		if (this.state.convs.length > 10) this.state.convs.shift();
		this.state.active = this.state.convs.length - 1;
		this.state.messages = fresh;
		this._afterConvChange();
		this._setStatus(this.T("chat.conv.created"));
	}

	switchConversation(i) {
		if (this.busy || i === this.state.active || !this.state.convs[i]) return;
		this.state.active = i;
		this.state.messages = this.state.convs[i];
		this._afterConvChange();
	}

	/** Fecha um separador (as respostas guardadas como nota continuam no Zotero). */
	closeConversation(i) {
		if (this.busy) return;
		this._ensureConvs();
		const msgs = this.state.convs[i];
		if (!msgs) return;
		if (msgs.some(m => m.role === "assistant" && m.text && !m.noteID)) {
			if (!this.win.confirm(this.T("chat.conv.closeConfirm", { title: this._convTitle(msgs) }))) return;
		}
		this.state.convs.splice(i, 1);
		if (!this.state.convs.length) this.state.convs.push([]);
		if (this.state.active >= this.state.convs.length || i < this.state.active) this.state.active = Math.max(0, this.state.active - (i < this.state.active ? 1 : 0));
		this.state.active = Math.min(this.state.active, this.state.convs.length - 1);
		this.state.messages = this.state.convs[this.state.active];
		this._afterConvChange();
	}

	_afterConvChange() {
		this.selectedAction = null;
		this._renderPending();
		this._renderConvTabs();
		this._renderMessages();
		this._renderActions();
		this._persist();
		this._setStatus("");
	}

	_saveSession() {
		if (this.sessionKey && (this.state.messages.length || this.state.docs.length)) {
			this.core.sessions.set(this.sessionKey, this.state);
			if (this.core.sessions.size > 40) {
				this.core.sessions.delete(this.core.sessions.keys().next().value);
			}
		}
	}

	/** Título da nota: "Comparação: métodos · Silva 2021, García 2023, Chen 2024 e mais 5". */
	_heading(a, docs) {
		const refs = docs.map(d => d.shortRef);
		const list = refs.length > 3
			? this.T("heading.more", { list: refs.slice(0, 3).join(", "), n: refs.length - 3 })
			: refs.join(", ");
		return `${a.title} · ${list}`;
	}

	/** Abre a janela grande com a lista das coleções, para comparar os PDFs de uma coleção. */
	openCollectionWindow() {
		this.core.openWindow({ items: [], pickCollection: true });
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
		if (this.core.listCollections) return this._openCollectionPicker();
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
		this.collectionName = c.name;
		await this._addItems(c.items, {});
	}

	async _addItems(items, { quiet }) {
		const skipped = [];
		let added = 0;
		const before = this.state.docs.length;
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
		// Mesmo autor e ano em dois artigos: Silva et al., 2021a e 2021b
		this.L.disambiguateRefs(Object.values(this.state.allDocs));
		this._renderDocs();
		// Passou a haver vários PDFs: abre logo o separador Comparar (sem mudar uma ação já escolhida)
		if (!quiet && this.mode !== "section" && before < 2 && this.state.docs.length >= 2 && this.group !== "comparar"
			&& !(this.selectedAction && (this._action(this.selectedAction) || {}).group !== "comparar")) {
			this.group = "comparar";
			this._renderTabs();
		}
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
		// No painel, o cartão "Este registo não tem PDF" já explica: sem aviso repetido
		if (!this.state.docs.length && quiet && items.length && this.mode !== "section") {
			this._setStatus(this.T("chat.noPdf"), "warn");
		}
	}

	removeDoc(id) {
		if (this.busy) return;
		this.state.docs = this.state.docs.filter(d => d.id !== id);
		this._renderDocs();
		this._updateButtons();
	}

	/** Texto da caixa: singular com um PDF, plural com vários. */
	_updatePlaceholder() {
		const a = this.selectedAction && this._action(this.selectedAction);
		const key = a ? "chat.placeholder.action" : (this.state.docs.length === 1 ? "chat.placeholder.one" : "chat.placeholder");
		this.textarea.setAttribute("placeholder", this.T(key));
	}

	_renderDocs() {
		this._updatePlaceholder();
		const box = this.docsEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		if (!this.state.docs.length) {
			box.appendChild(this._el("span", "zia-muted",
				this.T(this.mode === "window" ? "chat.noDocs.window" : "chat.noDocs.section")));
			if (this.core.pickableItems && this.mode === "window") {
				box.appendChild(this._button(this.T("chat.addPdf"), "zia-chip-add", () => this._openPicker(), this.T("chat.addPdf.tip")));
			}
			return;
		}
		// Coleção juntada: fica indicada antes dos artigos
		if (this.collectionName && this.state.docs.length) {
			const col = this._el("span", "zia-chip zia-chip-col", this.T("chat.collectionChip", { name: this.collectionName }));
			col.title = this.T("chat.collectionChip.tip", { name: this.collectionName });
			box.appendChild(col);
		}
		for (const d of this.state.docs) {
			const chip = this._el("span", "zia-chip");
			chip.title = d.fullRef;
			chip.appendChild(this.doc.createTextNode(d.shortRef));
			if (this.mode === "window" || this.state.docs.length > 1) {
				const x = this._el("span", "zia-chip-x", "×");
				x.title = this.T("chat.removeDoc");
				x.setAttribute("role", "button");
				x.addEventListener("click", () => this.removeDoc(d.id));
				chip.appendChild(x);
			}
			box.appendChild(chip);
		}
		// Vários PDFs só na janela grande: o painel lateral é para o artigo selecionado
		if (this.core.pickableItems && this.mode === "window") {
			const add = this._button(this.T("chat.addPdf"), "zia-chip-add", () => this._openPicker(), this.T("chat.addPdf.tip"));
			box.appendChild(add);
		}
	}

	/** Mostra os artigos da lista do Zotero, para escolher os que se juntam à conversa. */
	async _openPicker(reason) {
		if (this.busy) return;
		const box = this.pickerEl;
		if (!box.hidden && !reason) {
			this._closePicker();
			return;
		}
		while (box.firstChild) box.removeChild(box.firstChild);
		box.hidden = false;
		box.appendChild(this._el("div", "zia-picker-title", reason || this.T("chat.picker.title")));
		box.appendChild(this._el("div", "zia-muted", this.T("chat.picker.loading")));
		let list = [];
		try { list = await this.core.pickableItems(); }
		catch (e) { this.core.log("pickableItems: " + e); }
		const inConv = new Set(this.state.docs.map(d => d.parentID || d.itemID));
		list = list.filter(x => !inConv.has(x.item.id));
		while (box.children.length > 1) box.removeChild(box.lastChild);
		if (!list.length) {
			box.appendChild(this._el("div", "zia-muted", this.T("chat.picker.empty")));
			box.appendChild(this._button(this.T("chat.meus.cancel"), "zia-btn-small", () => this._closePicker()));
			return;
		}
		const sortRow = this._el("div", "zia-picker-sort");
		sortRow.appendChild(this._el("span", "zia-muted", this.T("chat.picker.sort")));
		const sortSel = this._el("select", "zia-picker-sortsel");
		sortSel.setAttribute("aria-label", this.T("chat.picker.sort"));
		for (const k of ["added", "author", "date"]) {
			const o = this._el("option", null, this.T("chat.picker.sort." + k));
			o.setAttribute("value", k);
			sortSel.appendChild(o);
		}
		sortRow.appendChild(sortSel);
		box.appendChild(sortRow);
		const search = this._el("input", "zia-picker-search");
		search.setAttribute("type", "search");
		search.setAttribute("placeholder", this.T("chat.picker.search"));
		search.setAttribute("aria-label", this.T("chat.picker.search"));
		box.appendChild(search);
		const ul = this._el("div", "zia-picker-list");
		ul.setAttribute("role", "listbox");
		ul.setAttribute("aria-multiselectable", "true");
		const chosen = new Set();
		const addBtn = this._button(this.T("chat.picker.add", { n: 0 }), "zia-btn-small zia-btn-primary", async () => {
			const items = list.filter(x => chosen.has(x.item.id)).map(x => x.item);
			this._closePicker();
			if (!items.length) return;
			await this._addItems(items, {});
			const a = this.selectedAction && this._action(this.selectedAction);
			if (a && this.state.docs.length >= a.minDocs) this._setStatus(this.T("chat.picker.ready", { label: a.label }));
		});
		addBtn.disabled = true;
		const rows = [];
		const cmp = {
			added: (a, b) => (b.added || "").localeCompare(a.added || ""),
			author: (a, b) => (a.author || "").localeCompare(b.author || "", undefined, { sensitivity: "base" }) || (b.date || "").localeCompare(a.date || ""),
			date: (a, b) => (b.date || "").localeCompare(a.date || ""),
		};
		list.sort(cmp.added);
		for (const x of list) {
			const row = this._el("label", "zia-picker-row");
			const cb = this._el("input");
			cb.setAttribute("type", "checkbox");
			cb.addEventListener("change", () => {
				if (cb.checked) chosen.add(x.item.id);
				else chosen.delete(x.item.id);
				addBtn.textContent = this.T("chat.picker.add", { n: chosen.size });
				addBtn.disabled = !chosen.size;
			});
			row.append(cb, this._el("span", null, x.label));
			rows.push({ row, text: x.label.toLowerCase(), x });
			ul.appendChild(row);
		}
		sortSel.addEventListener("change", () => {
			rows.sort((r1, r2) => cmp[sortSel.value](r1.x, r2.x));
			for (const r of rows) ul.appendChild(r.row);
		});
		search.addEventListener("input", () => {
			const q = search.value.trim().toLowerCase();
			for (const r of rows) r.row.hidden = !!q && !r.text.includes(q);
		});
		box.appendChild(ul);
		const btns = this._el("div", "zia-custom-btns");
		btns.append(addBtn, this._button(this.T("chat.meus.cancel"), "zia-btn-small", () => this._closePicker()));
		box.appendChild(btns);
		search.focus();
	}

	/** Escolher uma coleção numa lista, sem ter de a selecionar antes no Zotero. */
	_openCollectionPicker() {
		if (this.busy) return;
		const box = this.pickerEl;
		if (!box.hidden && box.dataset.kind === "col") return this._closePicker();
		while (box.firstChild) box.removeChild(box.firstChild);
		box.hidden = false;
		box.dataset.kind = "col";
		box.appendChild(this._el("div", "zia-picker-title", this.T("chat.colPicker.title")));
		let cols = [];
		try { cols = this.core.listCollections(); }
		catch (e) { this.core.log("listCollections: " + e); }
		if (!cols.length) {
			box.appendChild(this._el("div", "zia-muted", this.T("chat.colPicker.empty")));
			box.appendChild(this._button(this.T("chat.meus.cancel"), "zia-btn-small", () => this._closePicker()));
			return;
		}
		const search = this._el("input", "zia-picker-search");
		search.setAttribute("type", "search");
		search.setAttribute("placeholder", this.T("chat.colPicker.search"));
		search.setAttribute("aria-label", this.T("chat.colPicker.search"));
		box.appendChild(search);
		const ul = this._el("div", "zia-picker-list");
		ul.setAttribute("role", "listbox");
		const rows = [];
		let lastLib = null;
		for (const c of cols) {
			if (c.library && c.library !== lastLib) {
				lastLib = c.library;
				ul.appendChild(this._el("div", "zia-picker-lib", c.library));
			}
			const row = this._button(c.name, "zia-picker-row zia-col-row" + (c.selected ? " zia-col-selected" : ""), async () => {
				this._closePicker();
				const r = this.core.collectionItems(c.id);
				if (!r.items.length) {
					this._setStatus(this.T("chat.emptyCollection", { name: r.name || c.name }), "warn");
					return;
				}
				this.collectionIDs = [c.id];
				this.collectionName = r.name || c.name;
				const before = this.state.docs.length;
				await this._addItems(r.items, {});
				this._setStatus(this.T("chat.collectionAdded", { name: this.collectionName, n: this.state.docs.length - before }));
			});
			row.style.paddingInlineStart = (8 + c.depth * 14) + "px";
			row.setAttribute("role", "option");
			rows.push({ row, text: String(c.name).toLowerCase() });
			ul.appendChild(row);
		}
		search.addEventListener("input", () => {
			const q = search.value.trim().toLowerCase();
			for (const r of rows) r.row.hidden = !!q && !r.text.includes(q);
		});
		box.appendChild(ul);
		const btns = this._el("div", "zia-custom-btns");
		btns.appendChild(this._button(this.T("chat.meus.cancel"), "zia-btn-small", () => this._closePicker()));
		box.appendChild(btns);
		search.focus();
	}

	_closePicker() {
		const box = this.pickerEl;
		box.hidden = true;
		delete box.dataset.kind;
		while (box.firstChild) box.removeChild(box.firstChild);
	}

	_updateButtons() {
		const n = this.state.docs.length;
		for (const [id, b] of Object.entries(this.actionButtons || {})) {
			const a = this._action(id);
			if (!a) continue;
			b.disabled = this.busy || (n < a.minDocs && !this.core.pickableItems);
			b.classList.toggle("zia-selected", this.selectedAction === id);
			b.setAttribute("aria-pressed", this.selectedAction === id ? "true" : "false");
			b.classList.toggle("zia-done", !!this._lastAnswerFor(id));
			if (a.minDocs > 1 && n < a.minDocs) {
				b.title = this.mode === "section"
					? this.T("chat.needDocs.section")
					: this.T("chat.needDocs.window", { n: a.minDocs });
			}
			else {
				b.title = a.hint || "";
			}
		}
		this.sendBtn.textContent = this.busy ? this.T("chat.stop") : this.T(this.selectedAction ? "chat.sendAction" : "chat.send");
		this.sendBtn.classList.toggle("zia-stop", this.busy);
		this.sendBtn.disabled = false;
		this.engineSel.disabled = this.busy;
		this.newBtn.disabled = this.busy;
		for (const t of this.tabsEl.querySelectorAll(".zia-tab")) t.disabled = this.busy && t.getAttribute("aria-selected") !== "true";
	}

	openInWindow({ group } = {}) {
		const items = this.state.docs
			.map(d => Zotero.Items.get(d.parentID || d.attachmentID))
			.filter(Boolean);
		this.core.openWindow({ items, collectionIDs: this.core.selectedCollectionIDs(), group });
	}

	// ------------------------------------------------------------------
	// Pedidos
	// ------------------------------------------------------------------

	_setStatus(text, kind, working) {
		const s = this.statusEl;
		while (s.firstChild) s.removeChild(s.firstChild);
		if (working) s.appendChild(this._el("span", "zia-spinner"));
		if (text) s.appendChild(this.doc.createTextNode(text));
		// Avisos e erros podem ser fechados
		if (text && (kind === "warn" || kind === "error")) {
			s.appendChild(this._button("×", "zia-status-x", () => this._setStatus(""), this.T("chat.dismiss")));
		}
		s.className = "zia-status" + (kind ? " zia-status-" + kind : "");
	}

	stop() {
		if (this.abort) {
			try { this.abort.abort(); } catch (e) { /* já terminado */ }
		}
	}

	_persist() {
		this._ensureConvs();
		this._renderConvTabs();
		if (this.historyKey && this.core.saveConversation) {
			this.core.saveConversation(this.historyKey, { convs: this.state.convs, active: this.state.active });
		}
	}

	clearConversation() {
		this.newConversation();
	}

	/** Escolhe uma ação (não a corre): o pedido segue com Enviar ou Enter. */
	selectAction(actionID) {
		if (this.busy) return;
		this.selectedAction = this.selectedAction === actionID ? null : actionID;
		const a = this.selectedAction && this._action(this.selectedAction);
		if (a && this.state.docs.length < a.minDocs) {
			// Faltam PDFs (por exemplo, para comparar): abre logo o seletor
			this._renderPending();
			this._updateButtons();
			this._openPicker(this.T("chat.picker.need", { label: a.label, n: a.minDocs - this.state.docs.length }));
			return;
		}
		if (a) {
			const prev = this._lastAnswerFor(a.id);
			if (prev) {
				// Já foi pedido: mostra a resposta anterior em vez de a repetir sem querer
				prev.collapsed = false;
				this._renderMessage(prev);
				this._applyCollapse();
				if (prev.el && prev.el.scrollIntoView) prev.el.scrollIntoView({ block: "start", behavior: "smooth" });
				if (prev.el) {
					prev.el.classList.add("zia-flash");
					setTimeout(() => prev.el && prev.el.classList.remove("zia-flash"), 1600);
				}
				this._setStatus(this.T("chat.alreadyAsked", { label: a.label }));
			}
			else {
				this._setStatus(this.T("chat.actionChosen", { label: a.label }));
			}
			this.textarea.focus();
		}
		else {
			this._setStatus("");
		}
		this._renderPending();
		this._updateButtons();
	}

	/** Apaga uma ação do separador Personalizado (depois de confirmar). */
	_deleteCustom(label) {
		const ok = this.win.confirm(this.T("chat.meus.deleteConfirm", { label }));
		if (!ok) return;
		this.core.setPref("custom.prompts", this.L.removeCustomPrompt(this.core.pref("custom.prompts") || "", label));
		const sel = this.selectedAction && this._action(this.selectedAction);
		if (sel && sel.custom && sel.label === label) this.selectedAction = null;
		this._customForm = null;
		this._editCustom = false;
		this._renderActions();
		this._renderPending();
		this._updateButtons();
		this._setStatus(this.T("chat.meus.deleted", { label }));
	}

	_renderPending() {
		const box = this.pendingEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		const a = this.selectedAction && this._action(this.selectedAction);
		box.hidden = !a;
		this._updatePlaceholder();
		if (!a) return;
		box.appendChild(this._el("span", "zia-pending-label", this.T("chat.pending")));
		const chip = this._el("span", "zia-pending-chip", a.label);
		const x = this._button("✕", "zia-chip-x", () => this.selectAction(a.id), this.T("chat.pending.cancel"));
		chip.appendChild(x);
		box.appendChild(chip);
		// Ações próprias: editar logo aqui (o formulário tem Guardar, Cancelar e Eliminar)
		if (a.custom) {
			box.appendChild(this._button(this.T("chat.meus.editOne"), "zia-btn-small", () => this._openCustomForm(a)));
		}
	}

	_lastAnswerFor(actionID) {
		const docIDs = this.state.docs.map(d => d.id).join(",");
		for (let i = this.state.messages.length - 1; i >= 0; i--) {
			const m = this.state.messages[i];
			if (m.role === "assistant" && m.actionID === actionID && !m.error && !m.pending && m.text
				&& (!m.docIDs || m.docIDs.join(",") === docIDs)) return m;
		}
		return null;
	}

	async sendQuestion(text) {
		if (this.busy) return;
		if (text == null && this.selectedAction) {
			const id = this.selectedAction;
			const extra = this.textarea.value.trim();
			this.selectedAction = null;
			this._renderPending();
			this.textarea.value = "";
			this._autoGrow();
			await this.runAction(id, { extra });
			return;
		}
		const q = (text != null ? text : this.textarea.value).trim();
		if (!q) {
			this._setStatus(this.T("chat.emptyQuestion"), "warn");
			this.textarea.focus();
			return;
		}
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

	async runAction(actionID, { extra } = {}) {
		if (this.busy) return;
		const base = this._action(actionID);
		if (!base) return;
		// Indicações escritas pelo utilizador juntam-se ao pedido da ação
		const a = extra ? Object.assign({}, base, {
			prompt: (base.prompt || "") + "\n\n" + this.T("chat.extraPrefix") + " " + extra,
			label: `${base.label} · ${extra.length > 80 ? extra.slice(0, 77) + "…" : extra}`,
		}) : base;
		const docs = this.state.docs.slice();
		if (docs.length < a.minDocs) {
			this._setStatus(this.T("chat.actionNeeds", { label: a.label, n: a.minDocs }), "warn");
			if (this.core.pickableItems) this._openPicker(this.T("chat.picker.need", { label: base.label, n: a.minDocs - docs.length }));
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
			heading: this._heading(a, docs),
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
			heading: this._heading(a, docs),
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
		// As ações são pedidos completos: não precisam do histórico. As perguntas livres levam
		// só as últimas trocas (ver selectHistory).
		const history = (noHistory || actionID) ? [] : this.L.selectHistory(this._historyPairs());
		const userMsg = { role: "user", promptText, display, docIDs: docs.map(d => d.id) };
		const action = actionID ? this._action(actionID) : null;
		const botMsg = {
			role: "assistant", text: "", pending: true, heading, actionID, engine,
			actionLabel: action ? action.label : null,
			docIDs: docs.map(d => d.id), request: { promptText, display, heading, actionID, docs, noHistory },
			asked: display, time: Date.now(),
		};
		// As respostas anteriores ficam recolhidas (só o título): a conversa não fica corrida
		for (const m of this.state.messages) {
			if (m.role === "assistant" && !m.pending && !m.collapsed) {
				m.collapsed = true;
				this._renderMessage(m);
			}
		}
		this.state.messages.push(userMsg, botMsg);
		this._appendMessage(userMsg);
		this._appendMessage(botMsg);
		this._applyCollapse();
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
				heavy: this.L.isHeavyTask({ actionID: actionID && String(actionID).split(":")[0] === "custom" ? null : actionID, docCount: docs.length }),
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
			// Verificação automática contra o texto dos PDFs: excertos, páginas e números
			try {
				const pool = {};
				for (const d of docs) {
					const src = d.pages ? d : this.state.allDocs[d.id];
					if (src && src.pages) pool[d.id] = { pages: src.pages };
				}
				botMsg.check = this.L.verifyAnswer(botMsg.text, pool);
			}
			catch (e) { this.core.log("Verificação: " + e); }
			botMsg.pending = false;
			this.core.setPref(engine + ".lastTest", "ok");
			const secs = Math.round((Date.now() - t0) / 1000);
			this._setStatus(this.T("chat.done", { s: secs, engine: this.core.engineLabel(engine) }) + (botMsg.usageNote ? ` ${botMsg.usageNote}.` : ""));
		}
		catch (e) {
			botMsg.pending = false;
			botMsg.error = (e && e.message) || String(e);
			botMsg.errorKind = (e && e.kind) || "other";
			botMsg.errorDetail = (e && e.detail) || null;
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
			this._persist();
			this._updateButtons();
			this._saveSession();
		}
		if (returnMessage) return botMsg;
		return !botMsg.error;
	}

	/** Pares pergunta e resposta já concluídos, pela ordem da conversa (sem erros). */
	_historyPairs() {
		const out = [];
		const list = this.state.messages;
		for (let i = 0; i + 1 < list.length; i++) {
			const q = list[i], a = list[i + 1];
			if (q.role !== "user" || a.role !== "assistant" || a.error || a.pending || !a.text) continue;
			out.push({ role: "user", text: q.promptText || q.display || "" }, { role: "assistant", text: a.text });
			i++;
		}
		return out;
	}

	/** Aviso antes de eliminar: com conteúdo por guardar, oferece guardar como nota primeiro. */
	_confirmDelEl(m) {
		const box = this._el("div", "zia-confirm-del");
		box.setAttribute("role", "alertdialog");
		const hasText = !!(m.text && String(m.text).trim());
		const unsaved = hasText && !m.noteID;
		const key = !hasText ? "chat.del.error" : m.noteID ? "chat.del.saved" : "chat.del.unsaved";
		box.appendChild(this._el("div", "zia-confirm-text", this.T(key)));
		const row = this._el("div", "zia-custom-btns");
		if (unsaved) {
			row.appendChild(this._button(this.T("chat.del.saveThenDelete"), "zia-btn-small zia-btn-primary", async () => {
				try {
					await this._saveMessageNote(m);
					this._removeMessage(m);
				}
				catch (e) {
					this._setStatus(this.T("chat.noteError", { e: e.message || e }), "error");
				}
			}));
		}
		row.appendChild(this._button(this.T("chat.del.confirm"), "zia-btn-small zia-btn-danger", () => this._removeMessage(m)));
		row.appendChild(this._button(this.T("chat.meus.cancel"), "zia-btn-small", () => {
			m.confirmDel = false;
			this._renderMessage(m);
		}));
		box.appendChild(row);
		box.addEventListener("click", ev => ev.stopPropagation());
		return box;
	}

	/** Retira uma resposta (e a pergunta que a originou) da conversa e do histórico. */
	_removeMessage(m) {
		if (this.busy) return;
		const list = this.state.messages;
		const i = list.indexOf(m);
		if (i < 0) return;
		const from = i > 0 && list[i - 1].role === "user" ? i - 1 : i;
		list.splice(from, i - from + 1);
		this._renderMessages();
		this._persist();
		this._setStatus(this.T(m.error && !(m.text && String(m.text).trim()) ? "chat.errorRemoved" : "chat.answerRemoved"));
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
		// Mesma ordem da lista de motores: Gemini (grátis, o mais fácil para começar), Claude, ChatGPT
		const providers = [
			{ id: "gemini", options: [
				{ engine: "gemini", label: "setup.btn.geminiKey" },
			] },
			{ id: "claude", options: [
				{ engine: "claude", label: "setup.btn.claudeCode", local: true },
				{ engine: "anthropic", label: "setup.btn.key" },
			] },
			{ id: "openai", options: [
				{ engine: "codex", label: "setup.btn.codex", local: true },
				{ engine: "openai", label: "setup.btn.key" },
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
			this.messagesEl.insertBefore(this._setupCard(), this.messagesEl.firstChild);
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
			this.messagesEl.insertBefore(card, this.messagesEl.firstChild);
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
		this._renderConvTabs();
		const box = this.messagesEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		if (!this.state.messages.length) {
			if (!this._engineReady()) {
				box.appendChild(this._setupCard());
				return;
			}
			// Registo sem PDF no painel: explica e oferece os caminhos possíveis
			if (this.mode === "section" && !this.state.docs.length) {
				const card = this._el("div", "zia-empty zia-nopdf");
				card.appendChild(this._el("div", "zia-nopdf-title", this.T("nopdf.title")));
				card.appendChild(this._el("p", null, this.T("nopdf.text")));
				const row = this._el("div", "zia-custom-btns");
				row.appendChild(this._button(this.T("nopdf.window"), "zia-btn-small zia-btn-primary", () => this.openInWindow()));
				card.appendChild(row);
				box.appendChild(card);
				return;
			}
			const help = this._el("div", "zia-empty");
			help.appendChild(this._el("p", null, this.T(this.mode === "window" ? "chat.empty.window" : "chat.empty.section")));
			if (this.state.docs.length) {
				const sug = this._el("div", "zia-suggestions");
				for (const q of this._suggestions()) {
					const s = this._button(q, "zia-suggestion", () => {
						this.textarea.value = q;
						this._autoGrow();
						this.textarea.focus();
						this._setStatus(this.T("chat.suggestionReady"));
					});
					sug.appendChild(s);
				}
				help.appendChild(sug);
			}
			help.appendChild(this._el("p", "zia-tip", this.T("chat.tip")));
			box.appendChild(help);
			return;
		}
		for (const m of this.state.messages) this._appendMessage(m);
		this._applyCollapse();
	}

	_appendMessage(m) {
		const empty = this.messagesEl.querySelector(".zia-empty, .zia-setup");
		if (empty) empty.remove();
		m.el = this._el("div", "zia-msg zia-msg-" + m.role);
		// A mais recente em cima (logo por baixo da caixa de texto). Cada resposta fica
		// imediatamente a seguir à sua pergunta.
		const list = this.state.messages;
		const prev = list[list.indexOf(m) - 1];
		if (m.role === "assistant" && prev && prev.role === "user" && prev.el && prev.el.parentNode === this.messagesEl) {
			prev.el.after(m.el);
		}
		else {
			const first = this.messagesEl.querySelector(".zia-msg");
			if (first) this.messagesEl.insertBefore(m.el, first);
			else this.messagesEl.appendChild(m.el);
		}
		this._renderMessage(m);
		this._scrollToEnd(true);
	}

	/** Esconde a pergunta de cada resposta recolhida (o título da resposta já diz o que foi pedido). */
	_applyCollapse() {
		const list = this.state.messages;
		for (let i = 0; i < list.length; i++) {
			const m = list[i];
			if (m.role !== "user" || !m.el) continue;
			const next = list[i + 1];
			m.el.hidden = !!(next && next.role === "assistant" && next.collapsed);
		}
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

	/** As respostas novas ficam em cima: volta ao topo quando chega uma. */
	_scrollToEnd(force) {
		if (force) this.messagesEl.scrollTop = 0;
	}

	_renderMessage(m) {
		if (!m.el) return;
		const el = m.el;
		while (el.firstChild) el.removeChild(el.firstChild);
		if (m.role === "user") {
			el.appendChild(this._el("div", "zia-user-text", m.display));
			return;
		}
		// Resposta: o título abre e fecha a resposta
		const head = this._el("div", "zia-msg-head");
		const canFold = !m.pending;
		el.classList.toggle("zia-collapsed", !!m.collapsed);
		if (canFold) {
			head.classList.add("zia-foldable");
			head.setAttribute("role", "button");
			head.setAttribute("tabindex", "0");
			head.setAttribute("aria-expanded", m.collapsed ? "false" : "true");
			head.title = this.T(m.collapsed ? "chat.expand" : "chat.collapse");
			const toggle = () => {
				m.collapsed = !m.collapsed;
				this._renderMessage(m);
				this._applyCollapse();
			};
			head.addEventListener("click", toggle);
			head.addEventListener("keydown", ev => {
				if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
			});
			head.appendChild(this._el("span", "zia-fold", m.collapsed ? "▸" : "▾"));
		}
		head.appendChild(this._el("span", "zia-action-tag", m.actionLabel || this.T("chat.question")));
		head.appendChild(this._el("span", "zia-engine-tag", this.core.engineLabel(m.engine) + (m.model ? ` · ${m.model}` : "")));
		if (canFold) head.appendChild(this._el("span", "zia-fold-hint", this.T(m.collapsed ? "chat.foldOpen" : "chat.foldClose")));
		// Qualquer resposta pode ser retirada da conversa, depois de confirmar
		if (!m.pending) {
			const del = this._button("×", "zia-msg-del", ev => {
				if (ev && ev.stopPropagation) ev.stopPropagation();
				m.confirmDel = true;
				this._renderMessage(m);
			}, this.T(m.error && !(m.text && String(m.text).trim()) ? "chat.removeError" : "chat.removeAnswer"));
			del.addEventListener("keydown", ev => ev.stopPropagation());
			head.appendChild(del);
		}
		el.appendChild(head);
		if (m.confirmDel) el.appendChild(this._confirmDelEl(m));
		if (m.collapsed) {
			// Também recolhida se pode guardar como nota
			if (!m.error && m.text) {
				const save = this._saveNoteButton(m, "zia-head-save");
				save.addEventListener("keydown", ev => ev.stopPropagation());
				head.insertBefore(save, head.querySelector(".zia-msg-del"));
			}
			const asked = !m.actionLabel && m.asked ? m.asked + ": " : "";
			const plain = String(m.error || m.text || "").replace(/\[D\d+[^\]]*\]/g, "").replace(/[#*_>`|]/g, "").replace(/\s+/g, " ").trim();
			el.appendChild(this._el("div", "zia-preview" + (m.error ? " zia-preview-error" : ""),
				(asked + plain).slice(0, 150) + ((asked + plain).length > 150 ? "…" : "")));
			return;
		}
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
			const errBox = this._el("div", "zia-error");
			errBox.setAttribute("role", "alert");
			errBox.appendChild(this._el("div", "zia-error-text", m.error));
			if (m.errorDetail) {
				const det = this._el("details", "zia-error-detail");
				det.appendChild(this._el("summary", null, this.T("err.details")));
				det.appendChild(this._el("div", null, m.errorDetail));
				errBox.appendChild(det);
			}
			el.appendChild(errBox);
			const row = this._el("div", "zia-msg-tools");
			if (m.engine === "claude" && (m.errorKind === "notfound" || m.errorKind === "auth")) {
				row.appendChild(this._button(this.T("chat.claudeSetup"), "zia-btn-small zia-btn-primary", () => this._setupClaude()));
			}
			if (m.errorKind !== "notconfigured" && m.request) {
				row.appendChild(this._button(this.T("chat.retry"), "zia-btn-small", () => this._retry(m, m.engine)));
			}
			for (const other of (m.request ? this._otherReadyEngines(m.engine) : [])) {
				row.appendChild(this._button(this.T("chat.retryWith", { engine: this.core.engineLabel(other) }), "zia-btn-small", () => this._retry(m, other)));
			}
			if (["notfound", "auth", "model", "version", "billing", "notconfigured"].includes(m.errorKind)) {
				row.appendChild(this._button(this.T("chat.settings"), "zia-btn-small", () => this._openPrefs()));
			}
			el.appendChild(row);
		}
		else if (!m.pending && m.text) {
			// Copiar, Guardar como nota e os outros botões ficam por cima do texto
			el.insertBefore(this._messageTools(m), body);
			if (m.check) el.appendChild(this._checkBox(m.check));
			if (m.tags && m.tags.length) el.appendChild(this._tagsRow(m));
		}
	}

	/** Resultado da verificação automática: tudo confirmado, ou o que não foi encontrado nos PDFs. */
	_checkBox(c) {
		const dm = this._docsMap();
		const ref = cite => {
			if (!cite) return "";
			const cs = this.L.parseCiteGroup(cite);
			return cs.length ? " (" + cs.map(x => this.L.citeLabel(x, dm)).join("; ") + ")" : "";
		};
		if (!c.problems) {
			if (!c.quotes && !c.numbers) return this._el("div", "zia-check zia-check-ok", this.T("check.okNoQuotes"));
			return this._el("div", "zia-check zia-check-ok", this.T(c.calcs ? "check.okCalc" : "check.ok", { q: c.quotesOK, n: c.numbers, c: c.calcs }));
		}
		const box = this._el("div", "zia-check zia-check-warn");
		box.setAttribute("role", "note");
		box.appendChild(this._el("div", "zia-check-title", this.T("check.warn", { n: c.problems })));
		const ul = this._el("ul");
		const add = t => ul.appendChild(this._el("li", null, t));
		for (const q of c.badQuotes.slice(0, 4)) add(this.T("check.badQuote", { q: q.quote }) + ref(q.cite));
		for (const q of (c.changedQuotes || []).slice(0, 3)) add(this.T("check.changedQuote", { q: q.quote }) + ref(q.cite));
		for (const q of c.wrongPage.slice(0, 3)) add(this.T("check.wrongPage", { q: q.quote }) + ref(q.cite));
		for (const b of c.badCites.slice(0, 3)) add(this.T("check.badCite", { c: this.L.citeLabel(b, dm) }));
		for (const e of (c.badCalcs || []).slice(0, 3)) add(this.T("check.badCalc", { e }));
		if (c.unknownNumbers.length) add(this.T("check.numbers", { n: c.unknownNumbers.slice(0, 8).join(", ") }));
		box.appendChild(ul);
		box.appendChild(this._el("div", "zia-check-foot", this.T("check.foot")));
		return box;
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

	/** Botão "Guardar como nota" (ou "Nota guardada", que mostra a nota). */
	_saveNoteButton(m, cls) {
		const b = this._button(this.T(m.noteID ? "chat.noteSaved" : "chat.saveNote"), cls, async () => {
			if (m.noteID) {
				this._showNote(m.noteID);
				return;
			}
			try {
				await this._saveMessageNote(m);
				this._renderMessage(m);
				this._persist();
			}
			catch (e) {
				this._setStatus(this.T("chat.noteError", { e: e.message || e }), "error");
			}
		});
		b.title = this.T(m.noteID ? "chat.noteSaved.tip" : "chat.saveNote.tip");
		return b;
	}

	_messageTools(m) {
		const row = this._el("div", "zia-msg-tools");
		row.appendChild(this._button(this.T("chat.copy"), "zia-btn-small", () => {
			this.core.copyToClipboard(this.L.citesToText(m.text, this._docsMap()));
			this._setStatus(this.T("chat.copied"));
		}, this.T("chat.copy.tip")));
		row.appendChild(this._saveNoteButton(m, "zia-btn-small"));
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
		if (this.group === "escrever") this._renderActions();
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
