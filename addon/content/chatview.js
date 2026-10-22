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
	/** Acima deste número de artigos, a lista de cima encolhe (senão enche a janela). */
	DOCS_INLINE = 12;

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
		this.simple = this.mode === "section" && (core.pref("ui.mode") || "simple") !== "advanced";
		this.collectionIDs = [];
		this.busy = false;
		this.abort = null;
		this.sessionKey = null;
		this._renderTimer = null;
		this._pendingPrivacy = null;
		// Com mais artigos do que isto, a lista fica encolhida numa linha com a contagem
		this._docsOpen = false;
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

	/**
	 * Lista de escolha. No painel é um select normal. Na janela do assistente (uma janela XUL própria)
	 * os select nativos não abrem, por isso a lista é feita com botões. As duas têm addOption,
	 * clearOptions, value, disabled e o evento "change".
	 */
	_select(cls, label) {
		if (this.mode !== "window") {
			const sel = this._el("select", cls);
			if (label) sel.setAttribute("aria-label", label);
			sel.addOption = (value, text) => {
				const o = this._el("option", null, text);
				o.setAttribute("value", value);
				sel.appendChild(o);
			};
			sel.clearOptions = () => { while (sel.firstChild) sel.removeChild(sel.firstChild); };
			return sel;
		}
		const root = this._el("div", "zia-dd " + (cls || ""));
		const btn = this._el("button", "zia-dd-btn");
		btn.setAttribute("type", "button");
		btn.setAttribute("aria-haspopup", "listbox");
		if (label) btn.setAttribute("aria-label", label);
		const text = this._el("span", "zia-dd-text");
		btn.append(text, this._el("span", "zia-dd-caret", "▾"));
		const list = this._el("div", "zia-dd-list");
		list.setAttribute("role", "listbox");
		list.hidden = true;
		root.append(btn, list);
		const opts = [];
		let value = "", disabled = false;
		const show = () => {
			const o = opts.find(x => x.value === value) || opts[0];
			text.textContent = o ? o.text : "";
			for (const it of list.children) it.classList.toggle("on", it.dataset.value === value);
		};
		const onDoc = ev => { if (!root.contains(ev.target)) close(); };
		const close = () => {
			list.hidden = true;
			root.classList.remove("zia-dd-open");
			btn.setAttribute("aria-expanded", "false");
			this.doc.removeEventListener("mousedown", onDoc, true);
		};
		btn.addEventListener("click", ev => {
			ev.preventDefault();
			ev.stopPropagation();
			if (disabled) return;
			if (!list.hidden) return close();
			list.hidden = false;
			root.classList.add("zia-dd-open");
			btn.setAttribute("aria-expanded", "true");
			this.doc.addEventListener("mousedown", onDoc, true);
			const on = list.querySelector(".on");
			if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
		});
		root.addEventListener("keydown", ev => { if (ev.key === "Escape" && !list.hidden) { ev.stopPropagation(); close(); btn.focus(); } });
		root.addOption = (v, t) => {
			opts.push({ value: v, text: t });
			const it = this._button(t, "zia-dd-item", () => {
				close();
				if (value === v) return;
				value = v;
				show();
				root.dispatchEvent(new this.win.Event("change"));
			});
			it.dataset.value = v;
			it.setAttribute("role", "option");
			list.appendChild(it);
			if (opts.length === 1 && !value) value = v;
			show();
		};
		root.clearOptions = () => {
			opts.length = 0;
			while (list.firstChild) list.removeChild(list.firstChild);
			value = "";
			show();
		};
		Object.defineProperty(root, "value", { get: () => value, set: v => { value = v; show(); } });
		Object.defineProperty(root, "disabled", { get: () => disabled, set: v => { disabled = !!v; btn.disabled = disabled; if (disabled) close(); } });
		return root;
	}

	/** Ícones em linha fina (SVG desenhado aqui, sem ficheiros nem bibliotecas), na cor do texto. */
	_icon(name, cls) {
		const P = {
			spark: [["path", { d: "M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8 6.5 6.5Z", fill: "currentColor", stroke: "none" }]],
			sliders: [["path", { d: "M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" }], ["circle", { cx: 10, cy: 4.5, r: 1.6 }], ["circle", { cx: 6, cy: 11.5, r: 1.6 }]],
			docs: [["rect", { x: 5, y: 1.8, width: 8.5, height: 10.5, rx: 1.6 }], ["path", { d: "M2.5 5v8a1.7 1.7 0 0 0 1.7 1.7H10" }], ["path", { d: "M7.3 5.3h4M7.3 7.8h4M7.3 10.2h2.4" }]],
			chevron: [["path", { d: "M6 3.5 10.5 8 6 12.5" }]],
			sum: [["path", { d: "M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5" }]],
			list: [["circle", { cx: 3.2, cy: 4, r: 0.9, fill: "currentColor" }], ["circle", { cx: 3.2, cy: 8, r: 0.9, fill: "currentColor" }], ["circle", { cx: 3.2, cy: 12, r: 0.9, fill: "currentColor" }], ["path", { d: "M6 4h7.5M6 8h7.5M6 12h7.5" }]],
			bulb: [["path", { d: "M6 12.5h4M6.5 14.5h3M8 1.8a4.4 4.4 0 0 0-2.6 8c.4.3.6.8.6 1.3v.4h4v-.4c0-.5.2-1 .6-1.3A4.4 4.4 0 0 0 8 1.8Z" }]],
			key: [["circle", { cx: 5.5, cy: 10.5, r: 3 }], ["path", { d: "M7.6 8.4 13.5 2.5M11.2 4.8l1.8 1.8M9.6 6.4l1.4 1.4" }]],
			map: [["circle", { cx: 3.5, cy: 8, r: 1.8 }], ["circle", { cx: 12.5, cy: 3.5, r: 1.6 }], ["circle", { cx: 12.5, cy: 8, r: 1.6 }], ["circle", { cx: 12.5, cy: 12.5, r: 1.6 }], ["path", { d: "M5.3 8h5.6M5 7c2-3 3.5-3.5 5.9-3.5M5 9c2 3 3.5 3.5 5.9 3.5" }]],
			quiz: [["circle", { cx: 8, cy: 8, r: 6.2 }], ["path", { d: "M6.2 6.3a1.9 1.9 0 0 1 3.7.5c0 1.2-1.9 1.5-1.9 2.6M8 11.6h.01" }]],
			target: [["circle", { cx: 8, cy: 8, r: 6.2 }], ["circle", { cx: 8, cy: 8, r: 3.4 }], ["circle", { cx: 8, cy: 8, r: 0.8, fill: "currentColor" }]],
			outline: [["path", { d: "M2.5 3.5h11M5 7h8.5M7.5 10.5h6M5 14h8.5" }]],
			highlight: [["path", { d: "m9.5 2.8 3.7 3.7-6.4 6.4H3.1V9.2Z" }], ["path", { d: "M2 14.5h12" }]],
			shield: [["path", { d: "M8 1.8 13 3.6v4c0 3-2.2 5.5-5 6.6-2.8-1.1-5-3.6-5-6.6v-4Z" }], ["path", { d: "m5.6 8 1.7 1.7 3.2-3.4" }]],
			flask: [["path", { d: "M6 1.8h4M6.6 1.8v4.3L2.8 12.6a1.1 1.1 0 0 0 1 1.6h8.4a1.1 1.1 0 0 0 1-1.6L9.4 6.1V1.8M4.6 9.6h6.8" }]],
			scale: [["path", { d: "M8 2v12M4.5 14h7M3 4.5h10M3 4.5 1.4 8.5a1.8 1.8 0 0 0 3.2 0ZM13 4.5l-1.6 4a1.8 1.8 0 0 0 3.2 0Z" }]],
			card: [["rect", { x: 2, y: 3, width: 12, height: 10, rx: 1.6 }], ["path", { d: "M5 6.5h6M5 9h6M5 11.5h3" }]],
			quote: [["path", { d: "M3 9.5c0-2.5 1-4 3-5M3 9.5h3V13H3ZM9 9.5c0-2.5 1-4 3-5M9 9.5h3V13H9Z" }]],
			tag: [["path", { d: "M2.5 2.5h5.3l6 6-5.3 5.3-6-6Z" }], ["circle", { cx: 5.3, cy: 5.3, r: 0.9, fill: "currentColor" }]],
			search: [["circle", { cx: 7, cy: 7, r: 4.5 }], ["path", { d: "m10.3 10.3 3.2 3.2" }]],
			book: [["path", { d: "M2.5 3.2c2-.8 3.8-.6 5.5.6 1.7-1.2 3.5-1.4 5.5-.6v9.6c-2-.8-3.8-.6-5.5.6-1.7-1.2-3.5-1.4-5.5-.6ZM8 3.8v9.6" }]],
			arrow: [["path", { d: "M4 12 12 4M6 4h6v6" }]],
			star: [["path", { d: "M8 2.5 9.5 5.8l3.6.4-2.7 2.4.8 3.5L8 10.3l-3.2 1.8.8-3.5-2.7-2.4 3.6-.4Z" }]],
			cols: [["rect", { x: 2, y: 2.5, width: 12, height: 11, rx: 1.6 }], ["path", { d: "M6 2.5v11M10 2.5v11M2 6h12" }]],
			chat: [["path", { d: "M2.5 4.2c0-1 .8-1.7 1.7-1.7h7.6c1 0 1.7.8 1.7 1.7v5.1c0 1-.8 1.7-1.7 1.7H7l-3 2.5V11h.2c-1 0-1.7-.8-1.7-1.7Z" }], ["path", { d: "M5.5 6.6h5" }]],
			constellation: [["circle", { cx: 8, cy: 8, r: 2 }], ["circle", { cx: 3, cy: 3.5, r: 1.4 }], ["circle", { cx: 13, cy: 4, r: 1.4 }], ["circle", { cx: 3.5, cy: 12.5, r: 1.4 }], ["circle", { cx: 12.5, cy: 12.5, r: 1.4 }], ["path", { d: "M6.4 6.8 4.1 4.5M9.6 6.8l2.3-2M6.5 9.3l-2 2.2M9.5 9.3l2 2.2" }]],
			review: [["path", { d: "M4 1.8h5.5L12.5 5v9.2H4Z" }], ["path", { d: "M9.5 1.8V5h3M6 8h4.5M6 10.5h4.5M6 13h2.5" }]],
			funnel: [["path", { d: "M2.5 3h11L9.2 8.3v4.2l-2.4 1.2V8.3Z" }]],
			shelf: [["rect", { x: 2.5, y: 3, width: 3, height: 10, rx: 0.8 }], ["rect", { x: 6.5, y: 3, width: 3, height: 10, rx: 0.8 }], ["path", { d: "m10.9 4.4 2.5-.7 2 8.4-2.5.7Z" }]],
			folder: [["path", { d: "M2 4.3c0-.7.6-1.3 1.3-1.3h3l1.5 1.7h4.9c.7 0 1.3.6 1.3 1.3v6.2c0 .7-.6 1.3-1.3 1.3H3.3c-.7 0-1.3-.6-1.3-1.3Z" }]],
			sort: [["path", { d: "M5 3v10M2.8 10.8 5 13l2.2-2.2M11 13V3M8.8 5.2 11 3l2.2 2.2" }]],
		}[name] || [];
		const svg = this._svg("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round", class: "zia-icon " + (cls || ""), "aria-hidden": "true" });
		for (const [tag, attrs] of P) this._svg(tag, attrs, svg);
		return svg;
	}

	/** Ícone e cor de cada ação (os mesmos no Simples, no Avançado e na janela). */
	_actionIcon(id) {
		const MAP = {
			resumo: ["sum", "blue"], pontos: ["list", "rose"], simples: ["bulb", "amber"], conceitos: ["key", "violet"],
			estudo: ["quiz", "orange"], esquema: ["outline", "slate"], mapa: ["map", "green"], destaques: ["highlight", "yellow"],
			relevancia: ["target", "teal"], critica: ["shield", "green"], metodos: ["flask", "violet"], conclusoes: ["scale", "amber"],
			ficha: ["card", "blue"], excertos: ["quote", "rose"], etiquetas: ["tag", "orange"],
			lacunas: ["search", "teal"], referencias: ["book", "violet"], perguntas: ["arrow", "amber"],
			compare: ["cols", "blue"], pergunta: ["chat", "teal"], temas: ["constellation", "green"], cmp_sintese: ["review", "violet"], triagem: ["funnel", "orange"],
		};
		const [icon, color] = MAP[id] || (String(id).startsWith("custom:") ? ["star", "slate"] : null) || [];
		if (!icon) return null;
		const tile = this._el("span", "zia-ic zia-k-" + color);
		tile.appendChild(this._icon(icon));
		return tile;
	}

	/** Botão só com ícone (com a dica para quem passa o rato e para leitores de ecrã). */
	_iconButton(name, cls, onClick, title) {
		const b = this._button("", "zia-btn-small zia-btn-icon " + (cls || ""), onClick, title);
		b.setAttribute("aria-label", title || name);
		b.appendChild(this._icon(name));
		return b;
	}

	_build() {
		this.simple = this.mode === "section" && (this.core.pref("ui.mode") || "simple") !== "advanced";
		const root = this._el("div", `zia-root zia-mode-${this.mode}` + (this.simple ? " zia-simple" : ""));
		this.root = root;
		this._modeSwitch = null;

		// Painel lateral: língua (PT/EN) e definições à direita, e a faixa "Vários artigos"
		if (this.mode === "section") {
			const top = this._el("div", "zia-top");
			// Sem título: o Zotero já mostra "Assistente IA" no cabeçalho da secção
			top.appendChild(this._el("span", "zia-top-title"));
			const lang = this._el("div", "zia-langswitch");
			lang.setAttribute("role", "group");
			lang.title = this.T("ui.lang.tip");
			const cur = this.L.I18N.getLang() === "en" ? "en" : "pt-PT";
			for (const [code, label] of [["pt-PT", "PT"], ["en", "EN"]]) {
				const on = code === cur;
				const b = this._button(label, "zia-mode-btn" + (on ? " on" : ""), () => {
					if (this.busy || on) return;
					this.core.setPref("ui.lang", code);
					this.core.applyLanguage();
					this._rebuild();
				});
				b.dataset.lang = code;
				b.setAttribute("aria-pressed", on ? "true" : "false");
				lang.appendChild(b);
			}
			top.appendChild(lang);
			top.appendChild(this._iconButton("sliders", "", () => this._openPrefs(), this.T("chat.settings.tip")));
			root.appendChild(top);
			const strip = this._button("", "zia-multi-strip", () => this.openInWindow(), this.T("multi.tip"));
			const ic = this._el("span", "zia-multi-icon");
			ic.appendChild(this._icon("docs"));
			strip.appendChild(ic);
			const txt = this._el("span", "zia-multi-text");
			txt.appendChild(this._el("b", null, this.T("multi.title")));
			txt.appendChild(this._el("small", null, this.T("multi.sub")));
			strip.appendChild(txt);
			const go = this._el("span", "zia-multi-go");
			go.appendChild(this._icon("chevron"));
			strip.appendChild(go);
			root.appendChild(strip);
		}

		// Simples / Avançado (só no painel lateral: a janela é sempre avançada)
		if (this.mode === "section") {
			const sw = this._el("div", "zia-modeswitch");
			sw.setAttribute("role", "group");
			sw.title = this.T("ui.mode.tip");
			for (const m of ["simple", "advanced"]) {
				const on = (m === "simple") === this.simple;
				const b = this._button(this.T("ui.mode." + m), "zia-mode-btn" + (on ? " on" : ""), () => {
					if (this.busy || on) return;
					this.core.setPref("ui.mode", m);
					this._rebuild();
				});
				b.dataset.uimode = m;
				b.setAttribute("aria-pressed", on ? "true" : "false");
				sw.appendChild(b);
			}
			// O interruptor fica na barra de baixo do título (com o motor no Avançado, com o artigo no Simples)
			this._modeSwitch = sw;
		}

		// Barra superior: documentos, motor e definições
		const bar = this._el("div", "zia-bar");
		this.docsEl = this._el("div", "zia-docs");
		bar.appendChild(this.docsEl);
		const tools = this._el("div", "zia-bar-tools");
		if (this.mode === "window") {
			tools.appendChild(this._button(this.T("chat.addPdf"), "zia-btn-small", () => this._openPicker(),
				this.T("chat.addPdf.tip")));
		}
		this.engineSel = this._select("zia-engine", this.T("chat.engine.tip"));
		this.engineSel.title = this.T("chat.engine.tip");
		this.engineSel.addEventListener("change", () => this._setEngine(this.engineSel.value));
		// No painel (Simples e Avançado) usa-se o motor escolhido nas definições
		this.engineSel.hidden = this.mode === "section";
		tools.appendChild(this.engineSel);
		// No painel o ⚙ está na linha do título
		if (this.mode === "window") tools.appendChild(this._iconButton("sliders", "", () => this._openPrefs(), this.T("chat.settings.tip")));
		if (this._modeSwitch) tools.appendChild(this._modeSwitch);
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
		// Painel Avançado: indicações para a próxima ação (abrem com "+ indicações") e "ou" antes da pergunta
		this.hintsEl = this._el("div", "zia-hints");
		this.hintsEl.hidden = true;
		this.hintsInput = null;
		root.appendChild(this.hintsEl);
		if (this._isAdv()) root.appendChild(this._el("div", "zia-or", this.T("chat.or")));
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
		this.inputEl = input;
		this.textarea = this._el("textarea", "zia-textarea");
		this.textarea.setAttribute("rows", "2");
		this.textarea.setAttribute("placeholder", this.T(this.simple ? "simple.placeholder" : "chat.placeholder"));
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
		const coffee = this.core.coffeeButton && this.core.coffeeButton(this.doc);
		if (coffee) tail.appendChild(coffee);
		// Sem "Nova conversa": cada pergunta e cada ação abrem o seu separador
		this.newBtn = this._button(this.T("chat.new"), "zia-link-btn", () => this.newConversation(), this.T("chat.new.tip"));
		// No painel, a janela abre-se pela faixa "Vários artigos" do topo
		if (tail.firstChild) root.appendChild(tail);

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
		const keys = ["engine", "anthropic.key", "openai.key", "gemini.key", "iaedu.key", "iaedu.endpoint", "iaedu.channel", "claude.enabled", "codex.enabled", "custom.prompts", "ui.lang", "ui.mode"];
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
		if (key === "ui.mode") {
			// Só o painel lateral tem modo simples, e só muda se o modo pedido for outro
			const simple = this.mode === "section" && (this.core.pref("ui.mode") || "simple") !== "advanced";
			if (simple !== this.simple) this._rebuild();
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
		if (!this.root) return;
		// A meio de uma resposta não se mexe na interface: fica para quando a resposta terminar
		if (this.busy) {
			this._rebuildLater = true;
			return;
		}
		this._rebuildLater = false;
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
		sel.clearOptions();
		if (!this.engine) sel.addOption("", this.T("chat.engine.choose"));
		const main = this.core.MAIN_ENGINES || this.core.ENGINE_ORDER;
		for (const id of this.core.ENGINE_ORDER) {
			const ready = this.core.isEngineReady(id);
			if (!main.includes(id) && !ready && id !== this.engine) continue;
			sel.addOption(id, this.core.engineLabel(id) + (ready ? "" : this.T("chat.engine.notReady")));
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

	/** Outros motores para "Repetir com": só os que já funcionaram (estado "Pronto" nas definições). */
	_otherReadyEngines(engine) {
		return this.core.readyEngines().filter(e => e !== engine && this.core.pref(e + ".lastTest") === "ok");
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
		// A janela é só para comparar (as outras ações estão no painel lateral)
		// No painel lateral, comparar faz-se só na janela grande: o atalho está no rodapé, não nos separadores
		const groups = this.mode === "window" ? this.L.ACTION_GROUPS.filter(g => g.id === "comparar")
			: this.L.ACTION_GROUPS.filter(g => g.id !== "comparar");
		box.hidden = this.mode === "window" || this.simple;
		if (!groups.some(g => g.id === this.group)) this.group = groups[0].id;
		for (const g of groups) {
			// Nome curto no separador (cabe numa linha), o nome completo aparece ao passar o rato
			const short = this.T("group." + g.id + ".tab");
			const t = this._button(short && short !== "group." + g.id + ".tab" ? short : g.label, "zia-tab", () => {
				this.group = g.id;
				this.core.setPref("ui.group", g.id);
				this._renderTabs();
			}, g.label);
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
		if (this.simple) return this._renderSimpleActions();
		if (this.mode === "window") return this._renderWindowActions();
		const list = this._actionsOfGroup(this.group).filter(a => !a.needsHighlights || this._hasHighlights());
		const custom = this.group === "meus";
		if (custom && !list.length && !this._customForm) {
			box.appendChild(this._el("div", "zia-meus-empty", this.T("chat.meus.empty")));
		}
		for (const a of list) {
			const b = this._button(a.button || a.label, "zia-action" + (custom && this._editCustom ? " zia-editing" : ""),
				() => (custom && this._editCustom ? this._openCustomForm(a) : this._isAdv() ? this._runAdvanced(a.id) : this.selectAction(a.id)), a.hint);
			b.dataset.action = a.id;
			const ic = this._actionIcon(a.id);
			if (ic) { b.insertBefore(ic, b.firstChild); b.classList.add("zia-has-ic"); }
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
			// Triagem: botão "i" com o que faz e como se usa
			if (a.id === "triagem") {
				const info = this._button("i", "zia-info-btn zia-triagem-info", () => {
					this._triagemInfoOpen = !this._triagemInfoOpen;
					this._renderActions();
				}, this.T("triagem.info.tip"));
				info.setAttribute("aria-expanded", this._triagemInfoOpen ? "true" : "false");
				box.appendChild(info);
			}
		}
		if (this.group === "comparar" && this._triagemInfoOpen) box.appendChild(this._triagemInfoEl());
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
			// Perguntas de exemplo: um clique escreve a pergunta na caixa
			if (!this._customForm && !this._editCustom && this.state.docs.length) {
				const ex = this._el("div", "zia-examples");
				ex.appendChild(this._el("div", "zia-examples-title", this.T("chat.meus.examples")));
				for (const q of this._suggestions()) {
					ex.appendChild(this._button(q, "zia-suggestion", () => {
						this.textarea.value = q;
						this._autoGrow();
						this.textarea.focus();
						this._setStatus(this.T("chat.suggestionReady"));
					}));
				}
				box.appendChild(ex);
			}
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

	/** Explicação da triagem: para que serve, os passos e os cuidados. */
	_triagemInfoEl() {
		const box = this._el("div", "zia-info-panel zia-triagem-panel");
		box.setAttribute("role", "note");
		box.appendChild(this._button("×", "zia-info-close", () => { this._triagemInfoOpen = false; this._renderActions(); }, this.T("chat.dismiss")));
		box.appendChild(this._el("div", "zia-info-title", this.T("triagem.info.title")));
		box.appendChild(this._el("p", null, this.T("triagem.info.what")));
		const ol = this._el("ol", "zia-info-fields");
		for (const f of this.T("triagem.info.steps").split("|")) ol.appendChild(this._el("li", null, f.trim()));
		box.appendChild(ol);
		box.appendChild(this._el("p", "zia-muted", this.T("triagem.info.note")));
		return box;
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
		// Com muitos artigos a lista das fichas também encolhe, pelo mesmo motivo
		if (docs.length > this.DOCS_INLINE) {
			box.appendChild(this._el("span", "zia-docs-count", this.T("ficha.list.count", { n: docs.length })));
			box.appendChild(this._button(this.T(this._fichasOpen ? "chat.docsHide" : "chat.docsShow"), "zia-link-btn zia-fichas-toggle-list", () => {
				this._fichasOpen = !this._fichasOpen;
				this._renderActions();
			}));
			if (!this._fichasOpen) return box;
			box.classList.add("zia-fichas-scroll");
		}
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
			display: `${this._action("ficha").label}: ${d.shortRef}`,
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
		const picked = item;
		if (item && this.core.conversationItem) item = await this.core.conversationItem(item);
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
			let old = this.core.loadConversation ? await this.core.loadConversation(this.historyKey) : null;
			// Conversa guardada antes com o PDF selecionado: junta-se à do registo, uma só vez
			if (picked && picked !== item && picked.key && this.core.loadConversation) {
				const oldKey = `${picked.libraryID}_${picked.key}`;
				const fromPdf = await this.core.loadConversation(oldKey);
				if (fromPdf && fromPdf.convs && fromPdf.convs.some(c => c.length)) {
					old = { convs: [...((old && old.convs) || []), ...fromPdf.convs], active: old ? old.active : 0 };
					await this.core.saveConversation(this.historyKey, old);
					await this.core.saveConversation(oldKey, { convs: [] });
				}
			}
			if (old && old.convs && old.convs.some(c => c.length) && this.sessionKey === key) {
				let convs = old.convs.map(c => c.map(m => Object.assign({}, m, { collapsed: m.role === "assistant" })));
				// Conversas antigas (tudo junto): um separador por ação e por pergunta
				if (convs.length === 1) convs = this._splitByAction(convs[0]);
				this.state.convs = convs;
				this.state.active = Math.min(Math.max(0, old.active || 0), this.state.convs.length - 1);
				// Nunca abre num separador sem respostas quando há outro com respostas
				if (!this.state.convs[this.state.active].some(m => m.role === "assistant")) {
					const withAnswer = this.state.convs.map((c, i) => (c.some(m => m.role === "assistant") ? i : -1)).filter(i => i >= 0);
					if (withAnswer.length) this.state.active = withAnswer[withAnswer.length - 1];
				}
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

	_splitByAction(msgs) {
		const out = [];
		const byAction = new Map();
		for (let i = 0; i < msgs.length; i++) {
			const q = msgs[i], a = msgs[i + 1];
			const pair = q.role === "user" && a && a.role === "assistant" ? [q, a] : [q];
			if (pair.length === 2) i++;
			const act = pair[pair.length - 1].actionID;
			if (act && byAction.has(act)) byAction.get(act).push(...pair);
			else {
				const c = pair.slice();
				out.push(c);
				if (act) byAction.set(act, c);
			}
		}
		return out.length ? out : [[]];
	}

	_ensureConvs() {
		if (!this.state.convs) {
			this.state.convs = [this.state.messages];
			this.state.active = 0;
		}
	}

	/** Nome da ação de uma resposta na língua atual (o gravado fica na língua em que foi pedida). */
	_actionTitle(m) {
		if (!m || !m.actionLabel) return null;
		if (m.actionID === "triagem" && !m.engine) return this.T("triagem.summary.title");
		const a = m.actionID && this._action(m.actionID);
		return a ? a.label : m.actionLabel;
	}

	/** Título de uma conversa: a primeira ação pedida ou o início da primeira pergunta. */
	_convTitle(msgs, full) {
		const a = msgs.find(m => m.role === "assistant");
		if (a && a.actionLabel) return this._actionTitle(a);
		const q = msgs.find(m => m.role === "user");
		if (q && q.display) return (!full && q.display.length > 28) ? q.display.slice(0, 26) + "…" : q.display;
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
			label.title = this._convTitle(msgs, true);
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
		if (msgs.length) {
			const unsaved = msgs.some(m => m.role === "assistant" && m.text && !m.noteID);
			const key = unsaved ? "chat.conv.closeConfirm" : "chat.conv.closeConfirmSaved";
			if (!this.win.confirm(this.T(key, { title: this._convTitle(msgs) }))) return;
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
	/** Na janela, a caixa de texto e o Enviar só aparecem depois de escolher o que fazer. */
	_syncInput() {
		if (this.inputEl) this.inputEl.hidden = this.mode === "window" && !this.selectedAction && !this.busy;
	}

	_updatePlaceholder() {
		this._syncInput();
		const a = this.selectedAction && this._action(this.selectedAction);
		// Triagem e relevância precisam de texto escrito: a caixa diz o que escrever
		const key = a && a.needsCriteria ? (a.needsMsg || "chat.triagem.needCriteria")
			: a && a.metaOnly ? "temas.placeholder"
				: a ? "chat.placeholder.action" : this.simple || this._isAdv() ? "simple.placeholder"
					: this.mode === "window" ? "win.chooseFirst" : (this.state.docs.length === 1 ? "chat.placeholder.one" : "chat.placeholder");
		this.textarea.setAttribute("placeholder", this.T(key));
	}

	/** O PDF tem destaques do utilizador? (o botão "Explicar os meus destaques" só aparece nesse caso) */
	_hasHighlights() {
		if (!this.core.loadAnnotations) return false;
		try {
			return this.state.docs.some(d => d.kind !== "ficha" && this.core.loadAnnotations(d).some(a => a.text));
		}
		catch (e) {
			return false;
		}
	}

	/** O registo do artigo tem mais do que um PDF? */
	_recordHasManyPdfs(d) {
		try {
			const parent = d.parentID && Zotero.Items.get(d.parentID);
			if (!parent || !parent.getAttachments) return false;
			return parent.getAttachments().map(id => Zotero.Items.get(id)).filter(a => a && a.isPDFAttachment && a.isPDFAttachment()).length > 1;
		}
		catch (e) {
			return false;
		}
	}

	_renderDocs() {
		this._updatePlaceholder();
		const box = this.docsEl;
		while (box.firstChild) box.removeChild(box.firstChild);
		box.hidden = false;
		if (!this.state.docs.length) {
			box.appendChild(this._el("span", "zia-muted",
				this.T(this.mode === "window" ? "chat.noDocs.window" : "chat.noDocs.section")));
			return;
		}
		// Coleção juntada: fica indicada antes dos artigos
		if (this.collectionName && this.state.docs.length) {
			const col = this._el("span", "zia-chip zia-chip-col", this.T("chat.collectionChip", { name: this.collectionName }));
			col.title = this.T("chat.collectionChip.tip", { name: this.collectionName });
			box.appendChild(col);
		}
		// Painel Avançado com um só artigo: o Zotero já mostra qual é. O chip só aparece se o registo tem vários PDFs
		if (this.mode === "section" && !this.simple && this.state.docs.length === 1 && !this._recordHasManyPdfs(this.state.docs[0])) {
			box.hidden = true;
		}
		else box.hidden = false;
		// Muitos artigos: a lista encolhe para uma linha com a contagem, senão enche a janela
		// e empurra a caixa de texto para fora do ecrã
		const muitos = !box.hidden && this.state.docs.length > this.DOCS_INLINE;
		if (muitos) {
			const n = this._el("span", "zia-docs-count", this.T("chat.docsCount", { n: this.state.docs.length }));
			box.appendChild(n);
			box.appendChild(this._button(this.T(this._docsOpen ? "chat.docsHide" : "chat.docsShow"), "zia-link-btn zia-docs-toggle", () => {
				this._docsOpen = !this._docsOpen;
				this._renderDocs();
			}));
			box.classList.toggle("zia-docs-many", !this._docsOpen);
			if (!this._docsOpen) return;
		}
		else box.classList.remove("zia-docs-many");
		for (const d of box.hidden ? [] : this.state.docs) {
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
		if (this.actionsEl && this._lastHL !== this._hasHighlights()) {
			this._lastHL = this._hasHighlights();
			this._renderActions();
		}
	}

	/** Mostra os artigos da lista do Zotero, para escolher os que se juntam à conversa. */
	async _openPicker(reason) {
		if (this.busy) return;
		const box = this.pickerEl;
		if (!box.hidden && !reason && box.dataset.kind === "items") {
			this._closePicker();
			return;
		}
		while (box.firstChild) box.removeChild(box.firstChild);
		box.hidden = false;
		box.dataset.kind = "items";
		box.appendChild(this._el("div", "zia-picker-title", reason || this.T("chat.picker.title")));
		const inConv = new Set(this.state.docs.map(d => d.parentID || d.itemID));
		// Os artigos escolhidos ficam marcados ao mudar de coleção: pode juntar-se de várias de uma vez
		const chosen = new Map();
		let cols = [];
		try { cols = this.core.listCollections ? this.core.listCollections() : []; }
		catch (e) { this.core.log("listCollections: " + e); }
		let source = "library";

		// Pesquisa (com lupa)
		const sbox = this._el("div", "zia-picker-searchbox");
		sbox.appendChild(this._icon("search"));
		const search = this._el("input", "zia-picker-search");
		search.setAttribute("type", "search");
		search.setAttribute("placeholder", this.T("chat.picker.search"));
		search.setAttribute("aria-label", this.T("chat.picker.search"));
		sbox.appendChild(search);
		box.appendChild(sbox);

		// Onde procurar (toda a biblioteca ou uma coleção) e ordenar, numa só linha
		const bar = this._el("div", "zia-picker-bar");
		const seg = this._el("div", "zia-picker-seg");
		const libBtn = this._button("", "zia-picker-segbtn on", () => setSource("library"));
		libBtn.append(this._icon("shelf"), this.doc.createTextNode(this.T("chat.picker.source.library")));
		seg.appendChild(libBtn);
		const colBtn = this._button("", "zia-picker-segbtn", () => setSource("col:" + (colSel.value || "")));
		colBtn.append(this._icon("folder"), this.doc.createTextNode(this.T("chat.picker.collection")));
		seg.appendChild(colBtn);
		bar.appendChild(seg);
		const colSel = this._select("zia-picker-colsel", this.T("chat.picker.collection"));
		for (const c of cols) colSel.addOption(String(c.id), "  ".repeat(c.depth) + c.name);
		const preferred = cols.find(c => c.selected) || cols[0];
		if (preferred) colSel.value = String(preferred.id);
		colSel.hidden = true;
		bar.appendChild(colSel);
		const sortWrap = this._el("div", "zia-picker-sortwrap");
		sortWrap.title = this.T("chat.picker.sort");
		sortWrap.appendChild(this._icon("sort"));
		const sortSel = this._select("zia-picker-sortsel", this.T("chat.picker.sort"));
		for (const k of ["added", "author", "date", "title"]) sortSel.addOption(k, this.T("chat.picker.sort." + k));
		sortWrap.appendChild(sortSel);
		bar.appendChild(sortWrap);
		box.appendChild(bar);

		// Lista: a caixa "Marcar todos" fica por cima do primeiro artigo
		const head = this._el("label", "zia-picker-all");
		const allCb = this._el("input");
		allCb.setAttribute("type", "checkbox");
		const allTxt = this._el("span", null, "");
		head.append(allCb, allTxt);
		head.hidden = true;
		box.appendChild(head);
		const ul = this._el("div", "zia-picker-list");
		ul.setAttribute("role", "listbox");
		ul.setAttribute("aria-multiselectable", "true");
		box.appendChild(ul);
		const many = this._el("div", "zia-picker-many");
		many.hidden = true;
		box.appendChild(many);

		// Rodapé: contagem, juntar a coleção toda, Cancelar e Juntar
		const foot = this._el("div", "zia-picker-foot");
		const cnt = this._el("span", "zia-picker-count", "");
		const wholeBtn = this._button("", "zia-link-btn zia-picker-whole", () => {
			const c = cols.find(x => "col:" + x.id === source);
			if (c) this._addWholeCollection(c);
		});
		wholeBtn.hidden = true;
		// Junta os artigos marcados (usado por Juntar e por Enviar com o seletor aberto)
		this._pickerCommit = async () => {
			const items = [...chosen.values()];
			if (!items.length) return false;
			this._closePicker();
			await this._addItems(items, {});
			return true;
		};
		const addBtn = this._button(this.T("chat.picker.add", { n: 0 }), "zia-btn-small zia-btn-primary", async () => {
			if (!this._pickerCommit || !(await this._pickerCommit())) return this._closePicker();
			const a = this.selectedAction && this._action(this.selectedAction);
			if (a && this.state.docs.length >= a.minDocs) this._setStatus(this.T("chat.picker.ready", { label: a.label }));
		});
		addBtn.disabled = true;
		foot.append(cnt, wholeBtn, this._el("span", "zia-picker-spacer"), this._button(this.T("chat.meus.cancel"), "zia-btn-small", () => this._closePicker()), addBtn);
		box.appendChild(foot);

		const cmp = {
			added: (a, b) => (b.added || "").localeCompare(a.added || ""),
			author: (a, b) => (a.author || "").localeCompare(b.author || "", undefined, { sensitivity: "base" }) || (b.date || "").localeCompare(a.date || ""),
			date: (a, b) => (b.date || "").localeCompare(a.date || ""),
			title: (a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }),
		};
		let rows = [];
		// Os artigos que já estão na conversa aparecem marcados e não se podem desmarcar aqui
		const visible = () => rows.filter(r => !r.row.hidden && !r.inConv);
		// Estado da caixa "Marcar todos": marcada se todos os visíveis estão escolhidos, mista se só alguns
		const refresh = () => {
			const vis = visible();
			const n = vis.filter(r => chosen.has(r.x.item.id)).length;
			head.hidden = !vis.length;
			allCb.checked = vis.length > 0 && n === vis.length;
			allCb.indeterminate = n > 0 && n < vis.length;
			allTxt.textContent = this.T("chat.picker.selectAll", { n: vis.length });
			cnt.textContent = this.T("chat.picker.chosen", { n: chosen.size });
			addBtn.textContent = this.T("chat.picker.add", { n: chosen.size });
			addBtn.disabled = !chosen.size;
			many.hidden = chosen.size <= 50;
			many.textContent = this.T("chat.picker.many", { n: chosen.size });
		};
		allCb.addEventListener("change", () => {
			for (const r of visible()) {
				r.cb.checked = allCb.checked;
				if (allCb.checked) chosen.set(r.x.item.id, r.x.item);
				else chosen.delete(r.x.item.id);
				r.row.classList.toggle("on", allCb.checked);
			}
			refresh();
		});
		const filter = () => {
			const q = search.value.trim().toLowerCase();
			for (const r of rows) r.row.hidden = !!q && !r.text.includes(q);
			refresh();
		};
		let loadID = 0;
		const load = async () => {
			const my = ++loadID;
			while (ul.firstChild) ul.removeChild(ul.firstChild);
			ul.appendChild(this._el("div", "zia-muted zia-picker-msg", this.T("chat.picker.loading")));
			let list = [];
			try { list = await this.core.pickableItems(400, source.startsWith("col:") ? Number(source.slice(4)) : source); }
			catch (e) { this.core.log("pickableItems: " + e); }
			if (my !== loadID) return;
			while (ul.firstChild) ul.removeChild(ul.firstChild);
			wholeBtn.hidden = !source.startsWith("col:") || !list.some(x => !inConv.has(x.item.id));
			wholeBtn.textContent = this.T("chat.picker.whole", { n: list.length });
			if (!list.length) {
				const noCols = source.startsWith("col:") && !cols.length;
				ul.appendChild(this._el("div", "zia-muted zia-picker-none", this.T(noCols ? "chat.picker.noCols" : "chat.picker.empty")));
			}
			list.sort(cmp[sortSel.value]);
			rows = [];
			for (const x of list) {
				const already = inConv.has(x.item.id);
				const row = this._el("label", "zia-picker-row" + (chosen.has(x.item.id) || already ? " on" : "") + (already ? " zia-picker-in" : ""));
				const cb = this._el("input");
				cb.setAttribute("type", "checkbox");
				cb.checked = already || chosen.has(x.item.id);
				if (already) cb.disabled = true;
				cb.addEventListener("change", () => {
					if (cb.checked) chosen.set(x.item.id, x.item);
					else chosen.delete(x.item.id);
					row.classList.toggle("on", cb.checked);
					refresh();
				});
				const meta = this._el("span", "zia-picker-meta");
				const refEl = this._el("span", "zia-picker-ref", x.ref || x.label);
				if (already) refEl.appendChild(this._el("span", "zia-picker-badge", this.T("chat.picker.inConv")));
				meta.appendChild(refEl);
				if (x.title) meta.appendChild(this._el("span", "zia-picker-ttl", x.title));
				row.append(cb, meta);
				row.title = x.label;
				rows.push({ row, cb, text: x.label.toLowerCase(), x, inConv: already });
				ul.appendChild(row);
			}
			filter();
		};
		const setSource = v => {
			source = v;
			libBtn.classList.toggle("on", v === "library");
			colBtn.classList.toggle("on", v !== "library");
			colSel.hidden = v === "library" || !cols.length;
			load();
		};
		colSel.addEventListener("change", () => setSource("col:" + colSel.value));
		sortSel.addEventListener("change", () => {
			rows.sort((r1, r2) => cmp[sortSel.value](r1.x, r2.x));
			for (const r of rows) ul.appendChild(r.row);
		});
		search.addEventListener("input", filter);
		refresh();
		await load();
		search.focus();
	}

	/** Junta todos os artigos de uma coleção e indica-a como "Coleção: X". */
	async _addWholeCollection(c) {
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
			const row = this._button(c.name, "zia-picker-row zia-col-row" + (c.selected ? " zia-col-selected" : ""), () => this._addWholeCollection(c));
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
		this._pickerCommit = null;
		const box = this.pickerEl;
		box.hidden = true;
		delete box.dataset.kind;
		while (box.firstChild) box.removeChild(box.firstChild);
	}

	_updateButtons() {
		this._syncInput();
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
		this.sendBtn.textContent = this.busy ? this.T("chat.stop") : this.T("chat.send");
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

	/** Resumo da triagem: tabela feita pela app com a decisão sugerida para cada artigo. */
	_addScreeningSummary(rows, criteria, docs) {
		const m = {
			role: "assistant",
			text: this.L.screeningSummary(rows, criteria),
			actionID: "triagem",
			actionLabel: this.T("triagem.summary.title"),
			heading: this._heading({ title: this.T("triagem.summary.title") }, docs),
			docIDs: docs.map(d => d.id),
			time: Date.now(),
		};
		this.state.messages.push(m);
		this._appendMessage(m);
		this._hideRepeatedAsks();
		this._persist();
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

	/**
	 * Janela (vários artigos): 5 botões grandes. "Comparar artigos" junta os modelos prontos e as colunas
	 * do utilizador. Escolhe-se primeiro e depois envia-se com o que estiver escrito na caixa.
	 */
	_renderWindowActions() {
		const box = this.actionsEl;
		const COMPARE = ["comparar", "cmp_metodos", "cmp_resultados", "cmp_conceitos", "cmp_tabela"];
		const sel = this.selectedAction;
		const pick = id => {
			if (this.busy) return;
			if (this.selectedAction !== id) this.selectAction(id);
			this._renderActions();
		};
		box.appendChild(this._el("div", "zia-simple-ask", this.T("win.ask")));
		const grid = this._el("div", "zia-simple-grid zia-win-grid");
		const cards = [["compare", this.T("win.compare"), this.T("win.compare.desc")]]
			.concat(["pergunta", "temas", "cmp_sintese", "triagem"].map(id => [id, this._action(id).label, this.T(`win.${id}.desc`)]));
		for (const [id, label, desc] of cards) {
			const on = id === "compare" ? COMPARE.includes(sel) : sel === id;
			const b = this._button("", "zia-simple-btn" + (on ? " zia-selected" : ""),
				() => pick(id === "compare" ? (COMPARE.includes(sel) ? sel : "comparar") : id));
			const ic = this._actionIcon(id);
			if (ic) { b.appendChild(ic); b.classList.add("zia-has-ic"); }
			b.appendChild(this._el("span", "zia-simple-label", label));
			b.appendChild(this._el("span", "zia-simple-desc", desc));
			b.setAttribute("aria-pressed", on ? "true" : "false");
			if (id === "compare") b.dataset.card = "compare";
			else b.dataset.action = id;
			if (this._lastAnswerFor(id === "compare" ? "comparar" : id)) b.classList.add("zia-done");
			grid.appendChild(b);
		}
		box.appendChild(grid);
		const a = sel && this._action(sel);
		if (!a) return this._updateButtons();
		const detail = this._el("div", "zia-win-detail");
		// Comparar artigos: modelos prontos ou as colunas do utilizador
		if (COMPARE.includes(sel)) {
			const row = this._el("div", "zia-presets");
			for (const id of COMPARE) {
				const p = this._button(this.T("win.preset." + id), "zia-preset" + (id === sel ? " on" : ""), () => pick(id), this._action(id).hint);
				p.dataset.action = id;
				p.setAttribute("aria-pressed", id === sel ? "true" : "false");
				row.appendChild(p);
			}
			detail.appendChild(row);
		}
		if (sel === "triagem") {
			const info = this._button("i", "zia-info-btn zia-triagem-info", () => {
				this._triagemInfoOpen = !this._triagemInfoOpen;
				this._renderActions();
			}, this.T("triagem.info.tip"));
			info.setAttribute("aria-expanded", this._triagemInfoOpen ? "true" : "false");
			detail.appendChild(info);
			if (this._triagemInfoOpen) detail.appendChild(this._triagemInfoEl());
		}
		// "Usar fichas" só onde faz diferença
		if (a.fichasOK) {
			const row = this._el("div", "zia-win-fichas");
			row.appendChild(this.fichasLabel);
			const info = this._button("i", "zia-info-btn", () => {
				this._fichaInfoOpen = !this._fichaInfoOpen;
				this._renderActions();
			}, this.T("ficha.info.tip"));
			info.setAttribute("aria-expanded", this._fichaInfoOpen ? "true" : "false");
			row.appendChild(info);
			detail.appendChild(row);
			if (this._fichaInfoOpen) detail.appendChild(this._fichaInfoEl());
			const fl = this._fichasListEl();
			if (fl) detail.appendChild(fl);
		}
		if (detail.firstChild) box.appendChild(detail);
		this._updateButtons();
	}

	/** Modo simples: ações mais úteis para estudar, em botões grandes. Um clique envia logo. */
	_renderSimpleActions() {
		const box = this.actionsEl;
		box.appendChild(this._el("div", "zia-simple-ask", this.T("simple.ask")));
		const grid = this._el("div", "zia-simple-grid");
		// Ficha de leitura e Explicar os meus destaques ficam só no Avançado
		for (const id of ["resumo", "simples", "conceitos", "mapa", "estudo", "relevancia"]) {
			const a = this._action(id);
			if (!a || (a.needsHighlights && !this._hasHighlights())) continue;
			const b = this._button("", "zia-simple-btn", () => this._runSimple(id));
			const ic = this._actionIcon(id);
			if (ic) { b.appendChild(ic); b.classList.add("zia-has-ic"); }
			b.appendChild(this._el("span", "zia-simple-label", a.button || a.label));
			b.appendChild(this._el("span", "zia-simple-desc", this.T("simple." + id + ".desc")));
			b.dataset.action = id;
			this.actionButtons[id] = b;
			grid.appendChild(b);
		}
		box.appendChild(grid);
		this._updateButtons();
	}

	/** Painel Avançado (não o Simples nem a janela). */
	_isAdv() {
		return this.mode === "section" && !this.simple;
	}

	/** Campo das indicações do painel Avançado (o texto fica ao mudar de separador). */
	_renderHints() {
		const box = this.hintsEl;
		if (!box) return;
		const a = this._hintsFor && this._action(this._hintsFor);
		// Só a Relevância abre este campo (precisa do tema)
		const open = this._isAdv() && !!a;
		box.hidden = !open;
		while (box.firstChild) box.removeChild(box.firstChild);
		if (!open) return;
		if (!this.hintsInput) {
			this.hintsInput = this._el("textarea", "zia-textarea zia-hints-input");
			this.hintsInput.setAttribute("rows", "1");
		}
		this.hintsInput.setAttribute("placeholder", this.T(a ? (a.needsMsg || "chat.triagem.needCriteria") : "chat.hints.placeholder"));
		box.appendChild(this.hintsInput);
		// A relevância precisa do tema: o pedido segue com este botão
		if (a) box.appendChild(this._button(this.T("chat.hints.run", { label: a.label }), "zia-send zia-hints-run", () => this._runAdvanced(a.id)));
	}

	/** Painel Avançado: um clique numa ação envia logo (com as indicações, se houver). */
	_runAdvanced(id) {
		if (this.busy) return;
		const a = this._action(id);
		if (!a) return;
		const extra = this.hintsInput && this._hintsFor === id ? this.hintsInput.value.trim() : "";
		if (a.needsCriteria && !extra) {
			this._hintsFor = id;
			this._renderHints();
			this._renderActions();
			this._setStatus(this.T(a.needsMsg || "chat.triagem.needCriteria"), "warn");
			if (this.hintsInput) this.hintsInput.focus();
			return;
		}
		if (!extra && this._lastAnswerFor(id)) {
			// Já foi pedido: mostra a resposta que existe, sem gastar outro pedido
			this.selectedAction = null;
			this.selectAction(id);
			this.selectedAction = null;
			this._renderPending();
			this._updateButtons();
			return;
		}
		if (this._engineReady() && this.hintsInput) this.hintsInput.value = "";
		this._hintsFor = null;
		this._renderHints();
		this._renderActions();
		this.runAction(id, { extra });
	}

	_runSimple(id) {
		if (this.busy) return;
		const a = this._action(id);
		// A relevância precisa do tema, escrito na caixa de texto (pode repetir-se com outro tema)
		if (a && a.needsCriteria) {
			const extra = this.textarea.value.trim();
			if (!extra) {
				this._setStatus(this.T(a.needsMsg || "chat.triagem.needCriteria"), "warn");
				this.textarea.focus();
				return;
			}
			this.selectedAction = null;
			if (this._engineReady()) {
				this.textarea.value = "";
				this._autoGrow();
			}
			this.runAction(id, { extra });
			return;
		}
		if (this._lastAnswerFor(id)) {
			// Já foi pedido: mostra a resposta que existe, sem gastar outro pedido
			this.selectedAction = null;
			this.selectAction(id);
			this.selectedAction = null;
			this._renderPending();
			this._updateButtons();
			return;
		}
		this.selectedAction = null;
		this.runAction(id);
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
				// Já foi pedido: abre o separador dessa ação e mostra a resposta, sem repetir o pedido
				const ci = this.state.convs.findIndex(msgs => msgs.includes(prev));
				if (ci >= 0 && ci !== this.state.active) this._switchTo(ci);
				prev.collapsed = false;
				this._renderMessage(prev);
				this._hideRepeatedAsks();
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
		// Painel Avançado: uma linha a explicar o que a ação faz
		if (this.mode === "section" && !this.simple && a.hint) box.appendChild(this._el("div", "zia-pending-desc", a.hint));
		// Ações próprias: editar logo aqui (o formulário tem Guardar, Cancelar e Eliminar)
		if (a.custom) {
			box.appendChild(this._button(this.T("chat.meus.editOne"), "zia-btn-small", () => this._openCustomForm(a)));
		}
	}

	/** Última resposta válida de uma ação, em qualquer separador. */
	_lastAnswerFor(actionID) {
		this._ensureConvs();
		const docIDs = this.state.docs.map(d => d.id).join(",");
		for (const msgs of this.state.convs) {
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m.role === "assistant" && m.actionID === actionID && !m.error && !m.pending && m.text
					&& (!m.docIDs || m.docIDs.join(",") === docIDs)) return m;
			}
		}
		return null;
	}

	/** Separador de uma ação (cada ação tem o seu), ou -1. */
	_findConvFor(actionID) {
		this._ensureConvs();
		return this.state.convs.findIndex(msgs => msgs.some(m => m.role === "assistant" && m.actionID === actionID));
	}

	/**
	 * Cada ação e cada pergunta têm o seu separador: a ação vai para o separador dela (ou um novo),
	 * a pergunta abre um novo. Um separador vazio é aproveitado.
	 */
	_routeConversation(actionID) {
		this._ensureConvs();
		if (actionID) {
			const i = this._findConvFor(actionID);
			if (i >= 0) {
				if (i !== this.state.active) this._switchTo(i);
				return;
			}
		}
		if (this.state.messages.length) {
			const fresh = [];
			this.state.convs.push(fresh);
			this._switchTo(this.state.convs.length - 1);
		}
	}

	_switchTo(i) {
		this.state.active = i;
		this.state.messages = this.state.convs[i];
		this._renderConvTabs();
		this._renderMessages();
	}

	async sendQuestion(text) {
		if (this.busy) return;
		if (text == null && this.selectedAction) {
			const id = this.selectedAction;
			const extra = this.textarea.value.trim();
			// Sem os critérios, a ação continua escolhida: basta escrevê-los e enviar outra vez
			const chosen = this._action(id);
			if (chosen && chosen.needsCriteria && !extra) {
				this._setStatus(this.T(chosen.needsMsg || "chat.triagem.needCriteria"), "warn");
				this.textarea.focus();
				return;
			}
			this.selectedAction = null;
			this._renderPending();
			if (this.mode === "window") this._renderActions();
			this.textarea.value = "";
			this._autoGrow();
			await this.runAction(id, { extra });
			return;
		}
		// Na janela não há pergunta livre: "Perguntar à coleção" faz esse papel
		if (text == null && this.mode === "window") {
			this._setStatus(this.T("win.chooseFirst"), "warn");
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
		// A triagem precisa dos critérios do utilizador, escritos na caixa de texto
		if (base.needsCriteria && !(extra && extra.trim())) {
			this._setStatus(this.T(base.needsMsg || "chat.triagem.needCriteria"), "warn");
			this.textarea.focus();
			return;
		}
		let docs = this.state.docs.slice();
		// Artigos marcados no seletor ainda aberto: juntam-se logo (Enviar faz o mesmo que Juntar e pedir)
		if (docs.length < a.minDocs && this._pickerCommit && await this._pickerCommit()) docs = this.state.docs.slice();
		if (docs.length < a.minDocs) {
			this._setStatus(this.T("chat.actionNeeds", { label: base.label, n: a.minDocs - docs.length }), "warn");
			// A ação fica escolhida (na janela, a caixa e o Enviar continuam à vista)
			if (this.mode === "window") {
				this.selectedAction = actionID;
				this._renderActions();
				this._renderPending();
			}
			if (this.core.pickableItems && this.pickerEl.hidden) this._openPicker(this.T("chat.picker.need", { label: base.label, n: a.minDocs - docs.length }));
			return;
		}
		if (!this._engineReady()) {
			this._showSetupInline();
			return;
		}
		// Um pedido por documento (cada resposta fica numa nota própria)
		if (a.perDoc) {
			const rows = [];
			const falhados = [];
			for (const d of docs) {
				const msg = await this._ask({
					promptText: this.L.actionPrompt(a, [d]),
					display: `${a.label}: ${d.shortRef}`,
					heading: actionID === "ficha" ? `${this.L.fichaPrefix()} · ${d.shortRef}` : `${a.title} · ${d.shortRef}`,
					actionID,
					docs: [d],
					noHistory: true,
					returnMessage: true,
				});
				if (!msg) break;
				rows.push({ ref: d.ref || d.shortRef, decision: msg.screening || null });
				// Um problema com este PDF (não está no computador, sem texto, com senha) salta o
				// artigo e segue para o seguinte. Um problema do motor pára: ia repetir-se em todos
				if (msg.error && !this._skippableError(msg)) break;
				if (msg.error) falhados.push(d.shortRef);
			}
			if (falhados.length) this._setStatus(this.T("chat.skipped", { n: falhados.length, list: falhados.join(", ") }), "warn");
			// Triagem: no fim, uma tabela com a decisão sugerida para cada artigo (os que ficaram por fazer aparecem sem resposta)
			if (actionID === "triagem" && rows.length) {
				for (const d of docs.slice(rows.length)) rows.push({ ref: d.ref || d.shortRef, decision: null });
				this._addScreeningSummary(rows, extra, docs);
			}
			return;
		}
		if (a.metaOnly) {
			const metaDocs = [];
			for (const d of docs) {
				const text = this.core.itemMetaText ? await this.core.itemMetaText(d) : (d.fullRef || d.ref);
				metaDocs.push(Object.assign({}, d, { kind: "ficha", fichaText: text }));
			}
			const msg = await this._ask({
				promptText: this.L.actionPrompt(a, metaDocs),
				display: a.label,
				heading: this._heading(a, docs),
				actionID,
				docs: metaDocs,
				returnMessage: true,
			});
			if (msg && !msg.error && msg.text) {
				const cited = new Set((msg.text.match(/\bD\d+\b/g) || []));
				const missing = docs.filter(d => !cited.has(d.id)).map(d => d.shortRef);
				if (missing.length) {
					msg.warnings = (msg.warnings || []).concat(this.T("temas.missing", { list: missing.join(", ") }));
					this._renderMessage(msg);
					this._persist();
				}
			}
			return;
		}
		if (a.fichasOK && docs.length > 1 && this.useFichas.checked) {
			await this._runWithFichas(a, docs);
			return;
		}
		await this._ask({
			promptText: this.L.actionPrompt(a, docs),
			display: a.label,
			heading: this._heading(a, docs),
			actionID,
			docs,
		});
	}

	/** Ação sobre fichas: reutiliza notas "Ficha IA" e cria as que faltam. */
	/** Erro só deste PDF (não está no computador, sem texto, com senha): salta e segue. */
	_skippableError(msg) {
		return msg && msg.errorKind === "doc";
	}

	async _runWithFichas(a, docs) {
		const fichaDocs = [];
		const falhadas = [];
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
				display: this.T("chat.fichaFor", { doc: d.shortRef, action: a.label.toLowerCase() }),
				heading: `${this.L.fichaPrefix()} · ${d.shortRef}`,
				actionID: "ficha",
				docs: [d],
				noHistory: true,
				returnMessage: true,
			});
			// Um PDF com problema salta, para a comparação poder seguir com os outros
			if (!msg) return;
			if (msg.error) {
				if (!this._skippableError(msg)) return;
				falhadas.push(d.shortRef);
				continue;
			}
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
		// A comparação segue só com os artigos que correram bem
		const ok = docs.filter(d => fichaDocs.some(f => f.id === d.id));
		if (falhadas.length) {
			if (!ok.length) {
				this._setStatus(this.T("chat.skippedAll", { list: falhadas.join(", ") }), "error");
				return;
			}
			this._setStatus(this.T("chat.skipped", { n: falhadas.length, list: falhadas.join(", ") }), "warn");
		}
		else this._setStatus(this.T("chat.fichasDone", { reused, created }));
		await this._ask({
			promptText: this.L.actionPrompt(a, fichaDocs) + "\n\nTrabalha sobre as fichas de extração fornecidas.",
			display: this.T("chat.viaFichas", { label: a.label, docs: ok.map(d => d.shortRef).join(", ") }),
			heading: this._heading(a, ok),
			actionID: a.id,
			docs: fichaDocs,
		});
	}

	/**
	 * Envia um pedido e mostra a resposta em fluxo.
	 * Devolve true/false (ou a mensagem, se returnMessage).
	 */
	async _ask({ promptText, display, heading, actionID, docs, noHistory, returnMessage, engine, stay }) {
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
		if (!stay) this._routeConversation(actionID);
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
		// Pergunta e resposta entram juntas na conversa
		this.state.messages.push(userMsg, botMsg);
		this._appendMessage(userMsg);
		this._appendMessage(botMsg);
		this._hideRepeatedAsks();
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
				d.annotations = (withAnn || (action && action.useAnnotations)) && this.core.loadAnnotations ? this.core.loadAnnotations(d) : null;
			}
			// 2. Ajuste de tamanho
			const fitted = this.L.fitDocuments(docs, this.core.maxCharsFor(engine), { keepRefs: !!(action && action.keepRefs) });
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
			let writing = false;
			const res = await this.core.runEngine(engine, {
				system: this.L.buildSystemPrompt("ui"),
				prompt,
				promptParts,
				heavy: this.L.isHeavyTask({ actionID: actionID && String(actionID).split(":")[0] === "custom" ? null : actionID, docCount: docs.length }),
				// Comparar exige um modelo completo: nunca os "lite"
				noLite: !!(actionID && this.L.ACTIONS[actionID] && this.L.ACTIONS[actionID].group === "comparar"),
				win: this.win,
				signal: this.abort.signal,
				onDelta: (d, all) => {
					botMsg.text = all;
					// A resposta começou: o aviso de "modelo ocupado" já não vale, a pessoa vê o texto a chegar
					if (!writing) {
						writing = true;
						this._setStatus(this.T("chat.writing"), null, true);
					}
					this._scheduleRender(botMsg);
				},
				onInfo: info => {
					// Mudar de modelo não é um erro: aparece como progresso normal, sem laranja nem ×
					if (info && info.notice && !writing) this._setStatus(info.notice, null, true);
					const rl = this.L.formatRateLimit(info && info.rateLimit);
					if (rl) botMsg.usageNote = rl;
				},
			});
			botMsg.text = res.text || botMsg.text;
			botMsg.model = res.model || null;
			if (res.rateLimit) botMsg.usageNote = this.L.formatRateLimit(res.rateLimit) || botMsg.usageNote;
			if (res.notice) botMsg.usageNote = res.notice;
			botMsg.tokensNote = this.L.formatUsage(res.usage, engine);
			if (actionID === "triagem") {
				botMsg.screening = this.L.parseScreening(botMsg.text);
				botMsg.text = this.L.removeScreeningLine(botMsg.text);
			}
			if (actionID === "pergunta") {
				botMsg.stances = this.L.parseStances(botMsg.text);
				botMsg.text = this.L.removeStanceLines(botMsg.text);
			}
			if (actionID === "etiquetas") {
				botMsg.tags = this.L.parseTagLine(botMsg.text);
				if (botMsg.tags.length) botMsg.text = this.L.removeTagLine(botMsg.text);
			}
			// Verificação automática contra o texto dos PDFs: excertos, páginas e números
			try {
				const pool = {};
				const offs = {};
				for (const d of docs) {
					const src = d.pages ? d : this.state.allDocs[d.id];
					if (src && src.pages) pool[d.id] = { pages: src.pages };
					// O número impresso das páginas fica na resposta, para as citações o manterem
					if (src && typeof src.pageOffset === "number" && src.pageOffset !== 0) offs[d.id] = src.pageOffset;
				}
				if (Object.keys(offs).length) botMsg.pageOffsets = offs;
				botMsg.check = this.L.verifyAnswer(botMsg.text, pool);
			}
			catch (e) { this.core.log("Verificação: " + e); }
			botMsg.pending = false;
			this.core.setPref(engine + ".lastTest", "ok");
			const secs = Math.round((Date.now() - t0) / 1000);
			botMsg.secs = secs;
			// Painel Avançado: o tempo vai para a linha por baixo da resposta (motor, modelo e tempo juntos)
			if (this.mode === "section" && !this.simple) this._setStatus("");
			else this._setStatus(this.T("chat.done", { s: secs, engine: this.core.engineLabel(engine) }) + (botMsg.usageNote ? ` ${botMsg.usageNote}.` : ""));
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
			if (this._rebuildLater) this._rebuild();
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
		await this._ask(Object.assign({}, msg.request, { engine, stay: true }));
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

	/**
	 * Documentos da conversa. Com uma resposta (m), junta o número impresso das páginas
	 * guardado nessa resposta: assim as citações continuam certas depois de reiniciar o
	 * Zotero, sem voltar a ler o PDF.
	 */
	_docsMap(m) {
		const base = this.state.allDocs;
		const offs = m && m.pageOffsets;
		if (!offs) return base;
		const out = Object.assign({}, base);
		for (const id of Object.keys(offs)) {
			if (out[id] && out[id].pageOffset !== offs[id]) out[id] = Object.assign({}, out[id], { pageOffset: offs[id] });
		}
		return out;
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
			// No painel não há texto de ajuda (as perguntas de exemplo estão em "Pers."). Na janela, os passos
			if (this.mode !== "window") return;
			const help = this._el("div", "zia-empty");
			for (const t of this.T("chat.empty.window").split(/\s(?=\d\. )/)) help.appendChild(this._el("p", null, t));
			help.appendChild(this._el("p", "zia-tip", this.T("chat.tip")));
			box.appendChild(help);
			return;
		}
		for (const m of this.state.messages) this._appendMessage(m);
		this._hideRepeatedAsks();
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
	_hideRepeatedAsks() {
		const list = this.state.messages;
		for (let i = 0; i < list.length; i++) {
			const m = list[i];
			if (m.role !== "user" || !m.el) continue;
			const next = list[i + 1];
			// Numa ação, o título da resposta (com o x) já diz o que foi pedido: sem repetir
			m.el.hidden = !!(next && next.role === "assistant" && next.actionLabel);
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
		// Resposta: título da ação e x (o motor usado aparece por baixo do texto)
		const head = this._el("div", "zia-msg-head");
		m.collapsed = false;
		el.classList.remove("zia-collapsed");
		// Painel Avançado com separadores de conversa visíveis: o nome já está no separador, não se repete aqui
		const nameInTab = this.mode === "section" && !this.simple && (this.state.convs || []).length > 1;
		if (!nameInTab) head.appendChild(this._el("span", "zia-action-tag", this._actionTitle(m) || this.T("chat.question")));
		// Indicações ou artigo do pedido ("Resumir · foca a metodologia", "Ficha: Silva 2021")
		const asked = String(m.asked || "");
		if (m.actionLabel && asked.startsWith(m.actionLabel) && asked.length > m.actionLabel.length) {
			const extra = asked.slice(m.actionLabel.length).replace(/^\s*[·:]\s*/, "");
			if (extra) head.appendChild(this._el("span", "zia-action-extra", extra));
		}
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
		// Só o x: fica no canto, sem ocupar uma linha própria
		if (nameInTab && !head.querySelector(".zia-action-extra")) head.classList.add("zia-head-x");
		if (head.firstChild) el.appendChild(head);
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
		// O mapa mental desenha a lista encaixada como uma árvore com ramos
		if (m.stances && Object.keys(m.stances).length && !m.pending) el.appendChild(this._stanceMeter(m.stances));
		const isMap = m.actionID === "mapa" || m.actionID === "temas";
		const body = this._el("div", "zia-md" + (isMap ? " zia-mindmap" : ""));
		const ctx = {
			docsMap: this._docsMap(m),
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
		if (isMap && !m.pending) this._mindmapNodes(body);
		// Mapa mental: ramos com cor (cada ramo abre e fecha). Mapa de temas: Constelação ou Árvore
		let graph = null;
		if (isMap && !m.pending && m.text) {
			if (m.actionID === "temas") {
				const kinds = ["graph", "tree"];
				const cur = kinds.includes(m.view) ? m.view : "graph";
				const views = this._el("div", "zia-viewswitch");
				for (const v of kinds) {
					const on = cur === v;
					const b = this._button(this.T("temas.view." + v), "zia-mode-btn" + (on ? " on" : ""), () => {
						m.view = v;
						this._renderMessage(m);
					});
					b.dataset.view = v;
					b.setAttribute("aria-pressed", on ? "true" : "false");
					views.appendChild(b);
				}
				el.appendChild(views);
				if (cur === "graph") graph = this._themeGraph(body, m);
			}
			else this._mindmapBranches(body);
		}
		if (m.pending) {
			body.appendChild(this._el("span", "zia-typing", m.text ? " ▍" : this.T("chat.preparing")));
		}
		el.appendChild(body);
		if (graph) {
			body.classList.add("zia-graph-src");
			el.appendChild(graph);
		}
		if (m.actionID === "temas" && !m.pending && m.text) el.appendChild(this._el("div", "zia-msg-note", this.T("temas.note")));
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
			if (m.check) el.appendChild(this._checkBox(m.check, m));
			if (m.tags && m.tags.length) el.appendChild(this._tagsRow(m));
			const meta = [m.engine ? this.core.engineLabel(m.engine) + (m.model ? ` · ${m.model}` : "") : "", m.secs && this.mode === "section" ? `${m.secs} s` : "", m.usageNote, m.tokensNote].filter(Boolean);
			if (meta.length && !this.simple) el.appendChild(this._el("div", "zia-msg-meta", meta.join(" · ")));
		}
	}

	/** Cores dos ramos e dos temas (a primeira é o azul petróleo da app). */
	get MAP_COLORS() {
		return ["#4a6fa5", "#c2410c", "#6d4bb3", "#2f7d4f", "#b45309", "#2563eb", "#be185d", "#0e7490", "#4d7c0f", "#9333ea"];
	}

	_svg(tag, attrs, parent) {
		const e = this.doc.createElementNS("http://www.w3.org/2000/svg", tag);
		for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
		if (parent) parent.appendChild(e);
		return e;
	}

	/** Parte um texto em linhas de até n caracteres. */
	_wrap(text, n) {
		const out = [];
		let line = "";
		// palavras maiores do que a linha partem-se (nos hífenes, se houver)
		const words = [];
		for (const w of String(text).split(/\s+/).filter(Boolean)) {
			if (w.length <= n) { words.push(w); continue; }
			const parts = w.split(/(?<=-)/);
			let cur = "";
			for (const p of parts) {
				if (cur && (cur + p).length > n) { words.push(cur); cur = ""; }
				cur += p;
				while (cur.length > n) { words.push(cur.slice(0, n - 1) + "-"); cur = cur.slice(n - 1); }
			}
			if (cur) words.push(cur);
		}
		for (const w of words) {
			if (line && (line + " " + w).length > n) {
				out.push(line);
				line = w;
			}
			else line = line ? line + " " + w : w;
		}
		if (line) out.push(line);
		return out.length ? out : [""];
	}

	/** Texto de um ramo sem as citações, e as citações à parte (com a página, para abrir o PDF). */
	_mmInfo(li) {
		const node = li.querySelector(":scope > .zia-mm-node");
		if (!node) return { text: "", cites: [] };
		const cites = [...node.querySelectorAll(".zia-cite")];
		const copy = node.cloneNode(true);
		for (const c of copy.querySelectorAll(".zia-cite")) c.remove();
		const text = copy.textContent.replace(/\s+/g, " ").replace(/[\s,;:(\[]+$/, "").replace(/^\[[^\]]*\]\s*/, m0 => m0).trim();
		return { text, cites };
	}

	/**
	 * Caixa de um mapa desenhado: arrastar para mover, botões para aproximar, afastar e ajustar
	 * (Ctrl + roda do rato também). A vista fica guardada na mensagem ao redesenhar.
	 */
	_mapCanvas(svg, world, cw, ch, m, { minScale = 0.35, startScale, extra = [], left = false } = {}) {
		const box = this._el("div", "zia-mapbox");
		const tools = this._el("div", "zia-map-tools");
		const vp = this._el("div", "zia-map-view");
		vp.appendChild(svg);
		svg.setAttribute("width", "100%");
		svg.setAttribute("height", "100%");
		let st = m.mapView || null;
		const apply = () => {
			world.setAttribute("transform", `translate(${st.tx} ${st.ty}) scale(${st.s})`);
			m.mapView = st;
		};
		const width = () => vp.clientWidth || 360;
		const fit = keepHeight => {
			const W = width();
			let s = Math.min(1.15, (W - 16) / cw);
			if (startScale && s < startScale) s = startScale;
			s = Math.max(minScale, s);
			st = { s, tx: left && cw * s > W ? 8 : (W - cw * s) / 2, ty: 10 };
			if (!keepHeight) vp.style.height = Math.round(Math.min(Math.max(ch * s + 20, 220), 620)) + "px";
			apply();
		};
		const zoom = (f, cx, cy) => {
			const ns = Math.min(3, Math.max(0.2, st.s * f));
			if (cx == null) { cx = width() / 2; cy = (vp.clientHeight || 300) / 2; }
			st = { s: ns, tx: cx - (cx - st.tx) * ns / st.s, ty: cy - (cy - st.ty) * ns / st.s };
			apply();
		};
		for (const [label, tip, fn] of [["−", this.T("map.zoomOut"), () => zoom(1 / 1.25)], ["+", this.T("map.zoomIn"), () => zoom(1.25)], [this.T("map.fit"), this.T("map.fit"), () => fit(true)]]) {
			tools.appendChild(this._button(label, "zia-btn-small zia-map-btn", fn, tip));
		}
		for (const [label, fn] of extra) tools.appendChild(this._button(label, "zia-btn-small zia-map-btn", fn));
		// Arrastar o fundo move o mapa (os nós continuam a receber os cliques)
		let drag = null;
		vp.addEventListener("pointerdown", ev => {
			if (ev.button !== 0 || (ev.target.closest && ev.target.closest(".zia-map-hit"))) return;
			drag = { x: ev.clientX, y: ev.clientY, tx: st.tx, ty: st.ty };
			vp.classList.add("zia-dragging");
			try { vp.setPointerCapture(ev.pointerId); } catch (e) { /* sem captura */ }
		});
		vp.addEventListener("pointermove", ev => {
			if (!drag) return;
			st = { s: st.s, tx: drag.tx + ev.clientX - drag.x, ty: drag.ty + ev.clientY - drag.y };
			apply();
		});
		const end = () => { drag = null; vp.classList.remove("zia-dragging"); };
		vp.addEventListener("pointerup", end);
		vp.addEventListener("pointercancel", end);
		vp.addEventListener("wheel", ev => {
			if (!ev.ctrlKey) return;
			ev.preventDefault();
			const r = vp.getBoundingClientRect();
			zoom(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ev.clientX - r.left, ev.clientY - r.top);
		}, { passive: false });
		box.append(tools, vp);
		if (st) {
			vp.style.height = (m.mapHeight || 360) + "px";
			apply();
		}
		else this.win.setTimeout(() => { fit(); m.mapHeight = parseInt(vp.style.height, 10) || 360; }, 0);
		return box;
	}

	/**
	 * Mapa mental em ramos com cor (M1): a lista encaixada com a raiz a azul petróleo, cada ramo com a
	 * sua cor e, com um só artigo, só a página nas citações (o título da citação tem a referência inteira).
	 */
	_mindmapBranches(body) {
		body.classList.add("zia-mm-m1");
		const COLORS = this.MAP_COLORS.slice(1);
		const rootLi = body.querySelector("ul > li");
		if (!rootLi) return;
		[...rootLi.querySelectorAll(":scope > ul > li, :scope > ol > li")].forEach((li, i) => li.style.setProperty("--c", COLORS[i % COLORS.length]));
		if (this.state.docs.length === 1) {
			for (const c of body.querySelectorAll(".zia-cite")) {
				const x = c.textContent.match(/(pp?\.\s*[\d\s,–-]+)\s*$/);
				if (!x) continue;
				if (!c.title) c.title = c.textContent;
				c.textContent = x[1].trim();
			}
		}
		// Clicar no nome de um ramo esconde ou mostra as suas ideias
		for (const li of rootLi.querySelectorAll(":scope > ul > li, :scope > ol > li")) {
			const node = li.querySelector(":scope > .zia-mm-node");
			if (!node || !li.querySelector(":scope > ul, :scope > ol")) continue;
			node.classList.add("zia-mm-fold");
			node.setAttribute("role", "button");
			node.setAttribute("tabindex", "0");
			node.setAttribute("aria-expanded", "true");
			node.title = this.T("map.fold");
			const toggle = ev => {
				if (ev.target.closest && ev.target.closest(".zia-cite")) return;
				const folded = li.classList.toggle("zia-folded");
				node.setAttribute("aria-expanded", folded ? "false" : "true");
			};
			node.addEventListener("click", toggle);
			node.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(ev); } });
		}
	}

	/**
	 * Mapa de temas em constelação: cada tema é uma nuvem de cor com os seus artigos. Um artigo em
	 * vários temas é um só círculo, entre as nuvens e ligado a cada uma. Passar o rato mostra o título,
	 * clicar abre o PDF, clicar num tema (ou na legenda) destaca-o.
	 */
	_themeGraph(body, m) {
		const rootLi = body.querySelector("ul > li");
		if (!rootLi) return null;
		const root = this._mmInfo(rootLi);
		const themes = [], docs = new Map(), edges = [];
		const refOf = c => String(c.textContent || "").replace(/,?\s*pp?\.\s*[\d\s,–-]+$/, "").trim();
		const walk = (li, theme) => {
			for (const k of li.querySelectorAll(":scope > ul > li, :scope > ol > li")) {
				const kids = k.querySelectorAll(":scope > ul > li, :scope > ol > li");
				const info = this._mmInfo(k);
				if (kids.length || !theme) {
					// tema (os subtemas também contam como temas)
					const t = { kind: "theme", label: info.text.replace(/\s*\(\d+\)\s*$/, ""), docs: [], i: themes.length };
					themes.push(t);
					walk(k, t);
					continue;
				}
				const cite = info.cites[0] || null;
				const key = cite ? refOf(cite) : info.text;
				let d = docs.get(key);
				if (!d) {
					d = { kind: "doc", ref: cite ? refOf(cite) : info.text, title: info.text, cite, themes: [] };
					docs.set(key, d);
				}
				if (!d.themes.includes(theme)) {
					d.themes.push(theme);
					theme.docs.push(d);
					edges.push([theme, d]);
				}
			}
		};
		walk(rootLi, null);
		if (!themes.length) return null;
		const COL = this.MAP_COLORS;
		themes.forEach((t, i) => { t.color = COL[i % COL.length]; });
		const n = themes.length, R = n === 1 ? 0 : 110 + 26 * n;
		themes.forEach((t, i) => {
			// dois temas lado a lado, três ou mais à volta
			const a = (n === 2 ? Math.PI : -Math.PI / 2) + i * 2 * Math.PI / n;
			t.a = a; t.x = R * Math.cos(a); t.y = R * Math.sin(a);
		});
		const list = [...docs.values()];
		for (const t of themes) {
			const own = t.docs.filter(d => d.themes.length === 1);
			const rr = 52 + 5 * own.length;
			own.forEach((d, k) => {
				const a = t.a + (k - (own.length - 1) / 2) * Math.min(0.75, (2 * Math.PI) / Math.max(own.length, 1));
				d.x = t.x + rr * Math.cos(n === 1 ? -Math.PI / 2 + k * 2 * Math.PI / own.length : a);
				d.y = t.y + rr * Math.sin(n === 1 ? -Math.PI / 2 + k * 2 * Math.PI / own.length : a);
			});
		}
		for (const d of list) {
			if (d.themes.length < 2) continue;
			d.x = d.themes.reduce((s, t) => s + t.x, 0) / d.themes.length * 0.8;
			d.y = d.themes.reduce((s, t) => s + t.y, 0) / d.themes.length * 0.8;
		}
		// Afastar círculos que ficam por cima uns dos outros (os temas ficam no sítio)
		for (let it = 0; it < 80; it++) {
			for (let i = 0; i < list.length; i++) {
				const a = list[i];
				for (const b of list.slice(i + 1).concat(themes)) {
					const dx = a.x - b.x, dy = a.y - b.y, dist = Math.hypot(dx, dy) || 0.01;
					const min = b.kind === "theme" ? 46 : 30;
					if (dist >= min) continue;
					const push = (min - dist) / 2, ux = dx / dist, uy = dy / dist;
					a.x += ux * push; a.y += uy * push;
					if (b.kind === "doc") { b.x -= ux * push; b.y -= uy * push; }
				}
			}
		}
		const many = list.length > 30;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		const halo = t => Math.max(56, ...t.docs.filter(d => d.themes.length === 1).map(d => Math.hypot(d.x - t.x, d.y - t.y) + 26));
		for (const t of themes) {
			const h = halo(t);
			t.h = h;
			minX = Math.min(minX, t.x - h, t.x - t.label.length * 3.6 - 20); maxX = Math.max(maxX, t.x + h, t.x + t.label.length * 3.6 + 20);
			minY = Math.min(minY, t.y - h); maxY = Math.max(maxY, t.y + h);
		}
		for (const d of list) {
			minX = Math.min(minX, d.x - 12); maxX = Math.max(maxX, d.x + 14 + (many ? 0 : d.ref.length * 5.6));
			minY = Math.min(minY, d.y - 12); maxY = Math.max(maxY, d.y + 12);
		}
		const ox = -minX + 16, oy = -minY + 16, cw = maxX - minX + 32, ch = maxY - minY + 32;
		const svg = this._svg("svg", { class: "zia-graph" + (many ? " zia-g-many" : ""), role: "img", "aria-label": this.T("temas.view.graph") });
		const defs = this._svg("defs", {}, svg);
		const world = this._svg("g", { class: "zia-map-world" }, svg);
		const inner = this._svg("g", { transform: `translate(${ox} ${oy})` }, world);
		const gHalo = this._svg("g", {}, inner), gEdge = this._svg("g", { fill: "none" }, inner), gDoc = this._svg("g", {}, inner), gTheme = this._svg("g", {}, inner);
		for (const t of themes) this._svg("circle", { cx: t.x, cy: t.y, r: t.h, fill: t.color, "fill-opacity": 0.05, stroke: t.color, "stroke-opacity": 0.18, "stroke-dasharray": "2 4", class: "zia-g-halo", "data-t": t.i }, gHalo);
		for (const [t, d] of edges) {
			const mx = (t.x + d.x) / 2 * 0.92, my = (t.y + d.y) / 2 * 0.92;
			const e = this._svg("path", { d: `M${t.x} ${t.y} Q ${mx} ${my} ${d.x} ${d.y}`, stroke: t.color, "stroke-width": 1.4, "stroke-opacity": 0.55, class: "zia-g-edge" + (d.themes.length > 1 ? " multi" : ""), "data-t": t.i }, gEdge);
			(d.edgeEls = d.edgeEls || []).push(e);
		}
		const box = this._el("div", "zia-graph-wrap");
		const tipEl = this._el("div", "zia-g-tip");
		tipEl.hidden = true;
		let focus = null;
		const setFocus = i => {
			focus = focus === i ? null : i;
			svg.classList.toggle("zia-g-focus", focus != null);
			for (const el of svg.querySelectorAll("[data-t]")) el.classList.toggle("on", focus != null && String(el.dataset.t).split(",").includes(String(focus)));
			for (const c of box.querySelectorAll(".zia-g-legend button")) c.classList.toggle("on", focus != null && c.dataset.t === String(focus));
		};
		list.forEach((d, k) => {
			const g = this._svg("g", { class: "zia-g-doc zia-map-hit", tabindex: "0", "data-t": d.themes.map(t => t.i).join(",") }, gDoc);
			let fill = d.themes[0].color;
			if (d.themes.length > 1) {
				const grad = this._svg("linearGradient", { id: `zia-mix-${k}-${Math.random().toString(36).slice(2, 7)}` }, defs);
				const step = 100 / d.themes.length;
				d.themes.forEach((t, j) => {
					this._svg("stop", { offset: `${j * step}%`, "stop-color": t.color }, grad);
					this._svg("stop", { offset: `${(j + 1) * step}%`, "stop-color": t.color }, grad);
				});
				fill = `url(#${grad.getAttribute("id")})`;
			}
			this._svg("circle", { cx: d.x, cy: d.y, r: d.themes.length > 1 ? 9 : 7, fill, stroke: "#fff", "stroke-width": 2 }, g);
			const tx = this._svg("text", { x: d.x + 11, y: d.y + 4, class: "zia-g-label" }, g);
			tx.textContent = d.ref.length > 26 ? d.ref.slice(0, 25) + "…" : d.ref;
			const show = () => {
				for (const e of d.edgeEls || []) e.classList.add("hot");
				while (tipEl.firstChild) tipEl.removeChild(tipEl.firstChild);
				tipEl.appendChild(this._el("div", "zia-g-tip-ref", d.ref));
				if (d.title && d.title !== d.ref) tipEl.appendChild(this._el("div", "zia-g-tip-title", d.title));
				tipEl.appendChild(this._el("div", "zia-g-tip-themes", d.themes.map(t => t.label).join(" · ")));
				if (d.cite) tipEl.appendChild(this._el("div", "zia-g-tip-open", this.T("temas.openPdf")));
				tipEl.hidden = false;
				const vr = box.getBoundingClientRect(), r = g.getBoundingClientRect();
				tipEl.style.left = Math.max(4, Math.min(vr.width - 230, r.right - vr.left + 8)) + "px";
				tipEl.style.top = Math.max(4, r.top - vr.top - 6) + "px";
			};
			const hide = () => { for (const e of d.edgeEls || []) e.classList.remove("hot"); tipEl.hidden = true; };
			g.addEventListener("mouseenter", show);
			g.addEventListener("focus", show);
			g.addEventListener("mouseleave", hide);
			g.addEventListener("blur", hide);
			if (d.cite) {
				const open = () => d.cite.click();
				g.addEventListener("click", open);
				g.addEventListener("keydown", ev => { if (ev.key === "Enter") open(); });
			}
		});
		for (const t of themes) {
			const g = this._svg("g", { class: "zia-g-theme zia-map-hit", tabindex: "0", "data-t": t.i, role: "button" }, gTheme);
			const label = `${t.label} · ${t.docs.length}`;
			const w = Math.max(60, label.length * 6.6 + 22);
			// Etiqueta clara: fundo branco com um toque da cor, contorno fino e texto na cor do tema
			this._svg("rect", { x: t.x - w / 2, y: t.y - 13, width: w, height: 26, rx: 13, fill: "#fff", class: "zia-g-themebg" }, g);
			this._svg("rect", { x: t.x - w / 2, y: t.y - 13, width: w, height: 26, rx: 13, fill: t.color, "fill-opacity": 0.12, stroke: t.color, "stroke-width": 1.3 }, g);
			const tx = this._svg("text", { x: t.x, y: t.y + 4, "text-anchor": "middle", class: "zia-g-themetext", fill: t.color }, g);
			tx.textContent = label;
			g.addEventListener("click", () => setFocus(t.i));
			g.addEventListener("keydown", ev => { if (ev.key === "Enter") setFocus(t.i); });
		}
		if (root.text) box.appendChild(this._el("div", "zia-map-caption", root.text));
		const canvas = this._mapCanvas(svg, world, cw, ch, m, {});
		canvas.appendChild(tipEl);
		box.appendChild(canvas);
		const legend = this._el("div", "zia-g-legend");
		for (const t of themes) {
			const c = this._button("", "zia-g-chip", () => setFocus(t.i));
			c.dataset.t = String(t.i);
			const dot = this._el("i");
			dot.style.background = t.color;
			c.append(dot, this.doc.createTextNode(`${t.label} · ${t.docs.length}`));
			legend.appendChild(c);
		}
		box.appendChild(legend);
		box.appendChild(this._el("div", "zia-map-hint", this.T("temas.hint")));
		return box;
	}

	/** Perguntar à coleção: barra com o total de cada resposta (Sim, Em parte, Não, Não aborda). */
	_stanceMeter(stances) {
		const kinds = ["sim", "parte", "nao", "naoaborda"];
		const vals = Object.values(stances);
		const box = this._el("div", "zia-stances");
		const bar = this._el("div", "zia-stance-bar");
		const legend = [];
		for (const k of kinds) {
			const n = vals.filter(v => v === k).length;
			if (!n) continue;
			const seg = this._el("span", "zia-stance-" + k);
			seg.style.width = (100 * n / vals.length) + "%";
			seg.title = `${this.T("pergunta.ans." + k)}: ${n}`;
			bar.appendChild(seg);
			legend.push(`${this.T("pergunta.ans." + k)} ${n}`);
		}
		box.appendChild(bar);
		box.appendChild(this._el("div", "zia-stance-legend", legend.join(" · ")));
		return box;
	}

	/** Mapa mental: o texto de cada ramo fica numa caixa, para a árvore se ler como um mapa. */
	_mindmapNodes(body) {
		for (const li of body.querySelectorAll("li")) {
			const node = this._el("span", "zia-mm-node");
			while (li.firstChild && !(li.firstChild.nodeType === 1 && /^(UL|OL)$/i.test(li.firstChild.nodeName))) {
				const c = li.firstChild;
				// um parágrafo dentro do item passa só o conteúdo
				if (c.nodeType === 1 && /^P$/i.test(c.nodeName)) {
					while (c.firstChild) node.appendChild(c.firstChild);
					li.removeChild(c);
				}
				else node.appendChild(c);
			}
			li.insertBefore(node, li.firstChild);
		}
	}

	/** Resultado da verificação automática: tudo confirmado, ou o que não foi encontrado nos PDFs. */
	_checkBox(c, m) {
		const dm = this._docsMap(m);
		const ref = cite => {
			if (!cite) return "";
			const cs = this.L.parseCiteGroup(cite);
			return cs.length ? " (" + cs.map(x => this.L.citeLabel(x, dm)).join("; ") + ")" : "";
		};
		if (!c.problems) {
			if (this.simple) return this._el("div", "zia-check zia-check-ok", this.T("check.simpleOk"));
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
		for (const b of c.badCites.slice(0, 3)) add(this.T("check.badCite", { c: this.L.citeLabel(b, dm, { raw: true }) }));
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
			this.core.copyToClipboard(this.L.citesToText(m.text, this._docsMap(m)));
			this._setStatus(this.T("chat.copied"));
		}, this.T("chat.copy.tip")));
		row.appendChild(this._saveNoteButton(m, "zia-btn-small"));
		if (this.L.extractTables(m.text).length) {
			row.appendChild(this._button(this.T("chat.exportCsv"), "zia-btn-small", async () => {
				const csv = this.L.tablesToCSV(m.text, { docsMap: this._docsMap(m) });
				try {
					const path = await this.core.saveCSV(this.win, csv, m.heading || "tabela");
					if (path) this._setStatus(this.T("chat.exported", { path }));
				}
				catch (e) {
					this._setStatus(this.T("chat.exportError", { e: e.message || e }), "error");
				}
			}, this.T("chat.exportCsv.tip")));
		}
		// Testar o que percebi: perguntas e respostas para o Anki
		if (m.actionID === "estudo") {
			row.appendChild(this._button(this.T("chat.anki"), "zia-btn-small", async () => {
				const r = this.L.studyToAnki(this.L.citesToText(m.text, this._docsMap(m)));
				if (!r.count) {
					this._setStatus(this.T("chat.anki.none"), "warn");
					return;
				}
				try {
					const path = await this.core.saveCSV(this.win, r.csv, "Anki " + (m.heading || this.T("action.estudo.label")));
					if (path) this._setStatus(this.T("chat.anki.done", { n: r.count, path }));
				}
				catch (e) {
					this._setStatus(this.T("chat.exportError", { e: e.message || e }), "error");
				}
			}, this.T("chat.anki.tip")));
		}
		// O resumo da triagem é feito pela app, não por um motor: não há nada para repetir
		const others = m.request && !this.simple ? this._otherReadyEngines(m.engine) : [];
		if (others.length > 1) {
			// Vários motores prontos: uma só lista em vez de um botão por motor
			const sel = this._el("select", "zia-retry-sel");
			sel.setAttribute("aria-label", this.T("chat.retryList"));
			const first = this._el("option", null, this.T("chat.retryList"));
			first.setAttribute("value", "");
			sel.appendChild(first);
			for (const other of others) {
				const o = this._el("option", null, this.core.engineLabel(other));
				o.setAttribute("value", other);
				sel.appendChild(o);
			}
			sel.addEventListener("change", () => { if (sel.value) this._retry(m, sel.value); });
			row.appendChild(sel);
		}
		else for (const other of others) {
			row.appendChild(this._button(this.T("chat.retryWith", { engine: this.core.engineLabel(other) }), "zia-btn-small zia-btn-quiet", () => this._retry(m, other)));
		}
		return row;
	}

	async _saveMessageNote(m, { quiet } = {}) {
		const docsMap = this._docsMap(m);
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
