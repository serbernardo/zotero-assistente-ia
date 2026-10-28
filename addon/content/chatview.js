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

	/** A partir de quantas linhas uma tabela da janela ganha pesquisa e altura própria. */
	TABLE_TOOLS = 8;

	/** Limite de pedidos por minuto: esperas antes de repetir o mesmo pedido (segundos), e a pausa entre lotes depois. */
	LIMIT_WAITS = [30, 60, 90];
	LIMIT_PACE = 15;

	/** A partir de quantos artigos se pede confirmação antes de os juntar (cada pedido gasta quota). */
	MANY_CONFIRM = 100;

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
			gear: [["path", { d: "M12.93 8.83 14.38 9.71 13.72 11.30 12.07 10.90 10.90 12.07 11.30 13.72 9.71 14.38 8.83 12.93 7.17 12.93 6.29 14.38 4.70 13.72 5.10 12.07 3.93 10.90 2.28 11.30 1.62 9.71 3.07 8.83 3.07 7.17 1.62 6.29 2.28 4.70 3.93 5.10 5.10 3.93 4.70 2.28 6.29 1.62 7.17 3.07 8.83 3.07 9.71 1.62 11.30 2.28 10.90 3.93 12.07 5.10 13.72 4.70 14.38 6.29 12.93 7.17Z" }], ["circle", { cx: 8, cy: 8, r: 2.1 }]],
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
			compare: ["cols", "blue"], pergunta: ["chat", "teal"], temas: ["constellation", "green"], cmp_sintese: ["review", "violet"],
		};
		const [icon, color] = MAP[id] || (String(id).startsWith("custom:") ? ["star", "slate"] : null) || [];
		if (!icon) return null;
		const tile = this._el("span", "zia-ic zia-k-" + color);
		tile.appendChild(this._icon(icon));
		return tile;
	}

	/** Botão só com ícone (com a dica para quem passa o rato e para leitores de ecrã). */
	/** Roda dentada das definições: fica verde quando há uma versão nova do addon. */
	_gearButton() {
		// Com versão nova, abre as definições já no aviso, junto da versão instalada
		const b = this._iconButton("gear", "zia-gear", () => this._openPrefs(this.core.pref("update.available") ? "#zia-update-banner" : null), this.T("chat.settings.tip"));
		this._gear = b;
		this._renderUpdateBadge();
		return b;
	}

	_renderUpdateBadge() {
		const b = this._gear;
		if (!b) return;
		const v = this.core.pref("update.available") || "";
		const restart = this.core.pref("update.state") === "restart";
		b.classList.toggle("zia-has-update", !!v);
		const title = v ? this.T(restart ? "chat.update.restart" : "chat.update.available", { v }) : this.T("chat.settings.tip");
		b.title = title;
		b.setAttribute("aria-label", title);
	}

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
			top.appendChild(this._gearButton());
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
		// "+ Artigos" é o primeiro passo na janela: à esquerda, antes da lista dos artigos que junta,
		// em destaque enquanto não há artigos e mais discreto depois
		if (this.mode === "window") {
			this.addBtn = this._button(this.T("chat.addPdf"), "zia-btn-small zia-add-articles", () => this._openPicker(),
				this.T("chat.addPdf.tip"));
			this.addBtn.insertBefore(this._icon("docs"), this.addBtn.firstChild);
			bar.appendChild(this.addBtn);
		}
		this.docsEl = this._el("div", "zia-docs");
		bar.appendChild(this.docsEl);
		const tools = this._el("div", "zia-bar-tools");
		this.engineSel = this._select("zia-engine", this.T("chat.engine.tip"));
		this.engineSel.title = this.T("chat.engine.tip");
		this.engineSel.addEventListener("change", () => this._setEngine(this.engineSel.value));
		// No painel (Simples e Avançado) usa-se o motor escolhido nas definições
		this.engineSel.hidden = this.mode === "section";
		tools.appendChild(this.engineSel);
		// No painel o ⚙ está na linha do título
		if (this.mode === "window") tools.appendChild(this._gearButton());
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
		// Janela: com mais de 12 artigos, uma linha a dizer quantos pedidos a ação escolhida vai fazer
		this.largeNoteEl = this._el("div", "zia-large-note");
		this.largeNoteEl.hidden = true;
		root.appendChild(this.largeNoteEl);
		// Painel Avançado: indicações para a próxima ação (abrem com "+ indicações") e "ou" antes da pergunta
		this.hintsEl = this._el("div", "zia-hints");
		this.hintsEl.hidden = true;
		this.hintsInput = null;
		root.appendChild(this.hintsEl);
		if (this._isAdv()) root.appendChild(this._el("div", "zia-or", this.T("chat.or")));
		const fichasLabel = this._el("label", "zia-fichas-toggle");
		this.useFichas = this._el("input");
		this.useFichas.setAttribute("type", "checkbox");
		// Escolha da pessoa: deixa de mudar sozinha com o número de artigos
		this.useFichas.addEventListener("change", () => { this._fichasAuto = false; });
		fichasLabel.appendChild(this.useFichas);
		// O texto diz o que vai acontecer: criar as fichas, criar só as que faltam ou usar as que já existem
		this.fichasText = this.doc.createTextNode(this.T("chat.fichas"));
		fichasLabel.appendChild(this.fichasText);
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
		const keys = ["engine", "anthropic.key", "openai.key", "gemini.key", "iaedu.key", "iaedu.endpoint", "iaedu.channel", "claude.enabled", "codex.enabled", "custom.prompts", "ui.lang", "ui.mode", "update.available", "update.state"];
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
		if (key.startsWith("update.")) {
			this._renderUpdateBadge();
			return;
		}
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
		// Sem "Usar fichas" no painel: as fichas só servem com vários artigos, e o painel é para um
		this._updateButtons();
	}

	/**
	 * Texto de "Usar fichas" conforme as fichas que já existem: "Criar as 8 fichas e usá-las (8 pedidos a mais)",
	 * "Usar fichas (3 feitas, criar as 5 em falta)" ou "Usar as 8 fichas já feitas". Antes dizia sempre "Usar
	 * fichas", mesmo quando ainda não havia nenhuma (e então criava-as primeiro, um pedido por artigo).
	 */
	_renderFichasLabel() {
		if (!this.fichasText) return;
		const docs = this.state.docs;
		let done = 0;
		for (const d of docs) {
			try { if (d.parentID && this.core.findFichaNote && this.core.findFichaNote(d.parentID)) done++; }
			catch (e) { /* sem acesso às notas */ }
		}
		const n = docs.length, m = n - done;
		const key = n < 2 ? "chat.fichas" : !done ? "chat.fichas.create" : m ? "chat.fichas.partial" : "chat.fichas.all";
		this.fichasText.textContent = " " + this.T(key, { n, k: done, m }).trim();
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
		// Ao passar depressa pela lista do Zotero, só conta o último artigo pedido
		const token = this._showToken = (this._showToken || 0) + 1;
		if (item && this.core.conversationItem) item = await this.core.conversationItem(item);
		if (token !== this._showToken) return;
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
			if (this.sessionKey !== key) return;
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

	async setItems(items, { collectionIDs } = {}) {
		if (collectionIDs) this.collectionIDs = collectionIDs;
		await this._addItems(items || [], {});
	}

	/**
	 * Janela já aberta que recebe outros artigos (clique direito, faixa "Vários artigos", menu das
	 * coleções): passam a ser só esses. Somá-los aos que lá estavam fazia, por exemplo, comparar 32
	 * artigos quando a pessoa escolheu 2. As respostas anteriores ficam na conversa.
	 * Devolve false se estiver a meio de um pedido (nada muda).
	 */
	async replaceItems(items, { collectionIDs, collectionName } = {}) {
		if (this.busy) {
			this._setStatus(this.T("win.busyReplace"), "warn");
			return false;
		}
		const before = this.state.docs.length;
		this.state.docs = [];
		this.collectionName = collectionName || null;
		this.collectionIDs = collectionIDs || [];
		this._docsOpen = false;
		this._fichasOpen = false;
		// "Usar fichas" volta a decidir-se sozinho pelo número de artigos novos (se foi ligado sozinho)
		if (this._fichasAuto) { this.useFichas.checked = false; this._fichasAuto = undefined; }
		if (this.selectedAction) { this.selectedAction = null; this._renderPending(); }
		this._closePicker();
		await this._addItems(items || [], {});
		if (before && this.state.docs.length) this._setStatus(this.T("win.replaced", { n: this.state.docs.length }));
		this._renderActions();
		return true;
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
		// A conversa a que os artigos pertencem: se entretanto se mudou de artigo no painel, os
		// artigos vão para a conversa certa e a interface (já de outro artigo) não muda
		const st = this.state;
		const skipped = [];
		let added = 0;
		const before = st.docs.length;
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
			if (st.docs.some(x => x.attachmentID === d.attachmentID)) continue;
			// Artigo que já esteve na conversa: volta com o mesmo identificador (as respostas antigas continuam certas)
			const prev = Object.values(st.allDocs).find(x => x.attachmentID === d.attachmentID);
			if (prev) {
				st.docs.push(prev);
				added++;
				continue;
			}
			d.id = "D" + st.nextDocNum++;
			st.docs.push(d);
			st.allDocs[d.id] = d;
			added++;
		}
		// Mesmo autor e ano em dois artigos: Silva et al., 2021a e 2021b
		this.L.disambiguateRefs(Object.values(st.allDocs));
		if (this.state !== st) return;
		this._renderDocs();
		// Passou a haver vários PDFs: abre logo o separador Comparar (sem mudar uma ação já escolhida)
		if (!quiet && this.mode !== "section" && before < 2 && this.state.docs.length >= 2 && this.group !== "comparar"
			&& !(this.selectedAction && (this._action(this.selectedAction) || {}).group !== "comparar")) {
			this.group = "comparar";
			this._renderTabs();
		}
		this._updateButtons();
		// "Usar fichas" liga-se sozinho entre 6 e 12 artigos (num só pedido o PDF inteiro não caberia).
		// Com mais, os lotes já resolvem e as fichas seriam um pedido a mais por artigo: desliga-se,
		// se tiver sido ligado sozinho
		const n = this.state.docs.length;
		let fichasOn = false;
		if (n > this.L.LARGE_DOCS && this.useFichas.checked && this._fichasAuto) {
			this.useFichas.checked = false;
			this._fichasAuto = undefined;
		}
		else if (n >= 6 && n <= this.L.LARGE_DOCS && !this.useFichas.checked && this._fichasAuto !== false) {
			this.useFichas.checked = true;
			this._fichasAuto = true;
			fichasOn = true;
		}
		// Registos sem PDF: o aviso vem primeiro (senão a pessoa não sabe que ficaram de fora)
		if (skipped.length && !quiet) {
			this._setStatus(this.T("chat.noPdfSkipped", { n: skipped.length, list: skipped.slice(0, 3).join(", ") + (skipped.length > 3 ? "…" : "") }), "warn");
		}
		else if (fichasOn) {
			this._setStatus(this.T("chat.fichasAuto", { n }));
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

	/** Na janela, a caixa de texto e o Enviar só aparecem depois de escolher o que fazer. */
	_syncInput() {
		if (this.inputEl) this.inputEl.hidden = this.mode === "window" && !this.selectedAction && !this.busy;
	}

	/**
	 * Aviso da janela com muitos artigos: a ação escolhida (comparar, perguntar, revisão) faz o trabalho
	 * por lotes e gasta vários pedidos. Aparece só quando é preciso e com os números certos.
	 */
	_renderLargeNote() {
		const el = this.largeNoteEl;
		if (!el) return;
		const mode = this.mode === "window" && this.selectedAction
			? this.L.largeMode(this.selectedAction, this.state.docs.length) : null;
		el.hidden = !mode;
		el.textContent = "";
		if (!mode) return;
		const n = this.state.docs.length;
		const b = Math.ceil(n / this.L.BATCH_SIZE);
		el.textContent = mode === "themes"
			? this.T("win.largeNote.themes", { n })
			: this.T("win.largeNote", { n, b, r: b + 1 });
	}

	_updatePlaceholder() {
		this._renderLargeNote();
		this._syncInput();
		const a = this.selectedAction && this._action(this.selectedAction);
		// Relevância, pergunta e colunas precisam de texto escrito: a caixa diz o que escrever
		const key = a && a.needsCriteria ? a.needsMsg
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
		this._renderFichasLabel();
		if (this.addBtn) this.addBtn.classList.toggle("zia-has-docs", this.state.docs.length > 0);
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
		// O seletor de artigos é só da janela: no painel lateral nunca abre (o painel é para um artigo)
		if (this.busy || this.mode !== "window") return;
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

		// Onde procurar (toda a biblioteca ou uma coleção) e ordenar, numa só linha.
		// "Coleção" mostra a lista das coleções no lugar dos artigos (como no Zotero), sem lista suspensa
		const bar = this._el("div", "zia-picker-bar");
		const seg = this._el("div", "zia-picker-seg");
		const libBtn = this._button("", "zia-picker-segbtn on", () => setSource("library"));
		libBtn.append(this._icon("shelf"), this.doc.createTextNode(this.T("chat.picker.source.library")));
		seg.appendChild(libBtn);
		const colBtn = this._button("", "zia-picker-segbtn", () => setSource("cols"));
		colBtn.append(this._icon("folder"), this.doc.createTextNode(this.T("chat.picker.collection")));
		seg.appendChild(colBtn);
		bar.appendChild(seg);
		const sortWrap = this._el("div", "zia-picker-sortwrap");
		sortWrap.title = this.T("chat.picker.sort");
		sortWrap.appendChild(this._icon("sort"));
		const sortSel = this._select("zia-picker-sortsel", this.T("chat.picker.sort"));
		for (const k of ["added", "author", "date", "title"]) sortSel.addOption(k, this.T("chat.picker.sort." + k));
		sortWrap.appendChild(sortSel);
		bar.appendChild(sortWrap);
		box.appendChild(bar);
		// Dentro de uma coleção: "‹ Coleções · Tese" para voltar à lista
		const crumb = this._el("div", "zia-picker-crumb");
		crumb.hidden = true;
		box.appendChild(crumb);

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
			// A pessoa desistiu ao ver quantos eram: o seletor fica aberto com as escolhas (null)
			if (!this._confirmMany(this.state.docs.length + items.length)) return null;
			this._closePicker();
			await this._addItems(items, {});
			return true;
		};
		const addBtn = this._button(this.T("chat.picker.add", { n: 0 }), "zia-btn-small zia-btn-primary", async () => {
			const done = this._pickerCommit ? await this._pickerCommit() : false;
			if (done === null) return;
			if (!done) return this._closePicker();
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
			many.textContent = this.T("chat.picker.many", { n: chosen.size, r: Math.ceil((inConv.size + chosen.size) / this.L.BATCH_SIZE) + 1 });
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
		let colRows = [];
		const filter = () => {
			const q = search.value.trim().toLowerCase();
			for (const r of source === "cols" ? colRows : rows) r.row.hidden = !!q && !r.text.includes(q);
			refresh();
		};
		// Artigos com PDF de uma coleção (o número ao lado do nome)
		const pdfCount = id => {
			try {
				return (this.core.collectionItems(id).items || []).filter(it => (it.isRegularItem && it.isRegularItem()
					? (it.getAttachments ? it.getAttachments() : []).some(a => { const x = Zotero.Items.get(a); return !!(x && x.isPDFAttachment && x.isPDFAttachment()); })
					: !!(it.isPDFAttachment && it.isPDFAttachment()))).length;
			}
			catch (e) { return null; }
		};
		// Lista das coleções, com subcoleções e o número de artigos com PDF. Clicar abre a coleção
		const renderCols = () => {
			++loadID;
			rows = [];
			colRows = [];
			while (ul.firstChild) ul.removeChild(ul.firstChild);
			wholeBtn.hidden = true;
			if (!cols.length) ul.appendChild(this._el("div", "zia-muted zia-picker-none", this.T("chat.picker.noCols")));
			let lastLib = null;
			for (const c of cols) {
				if (c.library && c.library !== lastLib) {
					lastLib = c.library;
					ul.appendChild(this._el("div", "zia-picker-lib", c.library));
				}
				const row = this._button("", "zia-picker-row zia-col-row zia-col-pick" + (c.selected ? " zia-col-selected" : ""), () => setSource("col:" + c.id));
				row.style.paddingInlineStart = (8 + c.depth * 16) + "px";
				row.dataset.col = String(c.id);
				const n = pdfCount(c.id);
				const count = this._el("span", "zia-col-count", n == null ? "" : String(n));
				if (n != null) count.title = this.T("chat.picker.colCount", { n });
				row.append(this._icon("folder"), this._el("span", "zia-col-name", c.name), count, this._icon("chevron"));
				colRows.push({ row, text: String(c.name).toLowerCase() });
				ul.appendChild(row);
			}
			filter();
		};
		let loadID = 0;
		const load = async () => {
			if (source === "cols") return renderCols();
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
			sortWrap.hidden = v === "cols";
			search.value = "";
			search.setAttribute("placeholder", this.T(v === "cols" ? "chat.picker.searchCols" : "chat.picker.search"));
			while (crumb.firstChild) crumb.removeChild(crumb.firstChild);
			const c = v.startsWith("col:") ? cols.find(x => "col:" + x.id === v) : null;
			crumb.hidden = !c;
			if (c) {
				crumb.append(this._button("‹ " + this.T("chat.picker.collections"), "zia-link-btn zia-picker-back", () => setSource("cols")),
					this._el("span", "zia-picker-crumb-sep", "·"), this._el("span", "zia-picker-crumb-name", c.name));
			}
			load();
		};
		sortSel.addEventListener("change", () => {
			rows.sort((r1, r2) => cmp[sortSel.value](r1.x, r2.x));
			for (const r of rows) ul.appendChild(r.row);
		});
		search.addEventListener("input", filter);
		refresh();
		await load();
		search.focus();
	}

	/**
	 * Muitos artigos de uma vez: confirma antes, com uma ideia dos pedidos que cada comparação vai fazer
	 * (um por lote de 10, mais a síntese). Devolve true para continuar.
	 */
	_confirmMany(n) {
		if (n <= this.MANY_CONFIRM) return true;
		const r = Math.ceil(n / this.L.BATCH_SIZE) + 1;
		return this.win.confirm(this.T("chat.picker.manyConfirm", { n, r }));
	}

	/** Junta todos os artigos de uma coleção e indica-a como "Coleção: X". */
	async _addWholeCollection(c) {
		this._closePicker();
		const r = this.core.collectionItems(c.id);
		if (!r.items.length) {
			this._setStatus(this.T("chat.emptyCollection", { name: r.name || c.name }), "warn");
			return;
		}
		if (!this._confirmMany(this.state.docs.length + r.items.length)) return;
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
			// Na janela, faltar artigos abre o seletor. No painel (um só artigo) o botão fica inativo
			b.disabled = this.busy || (n < a.minDocs && (this.mode !== "window" || !this.core.pickableItems));
			b.classList.toggle("zia-selected", this.selectedAction === id);
			b.setAttribute("aria-pressed", this.selectedAction === id ? "true" : "false");
			b.classList.toggle("zia-done", !!this._lastAnswerFor(id));
			if (this.mode === "section" && n < 1) {
				b.title = this.T("nopdf.title");
			}
			else if (a.minDocs > 1 && n < a.minDocs) {
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

	/**
	 * Abre a janela do assistente vazia: os artigos escolhem-se lá (com "+ Artigos"). Trazer o artigo do
	 * painel obrigava a tirá-lo quando não fazia parte da comparação. Se a janela já estiver aberta,
	 * fica com os artigos que tinha.
	 */
	openInWindow({ group } = {}) {
		this.core.openWindow({ items: [], collectionIDs: this.core.selectedCollectionIDs(), group });
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
			.concat(["pergunta", "temas", "cmp_sintese"].map(id => [id, this._action(id).label, this.T(`win.${id}.desc`)]));
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
		// "Usar fichas" só onde faz diferença
		if (a.fichasOK) {
			const row = this._el("div", "zia-win-fichas");
			this._renderFichasLabel();
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
		this.hintsInput.setAttribute("placeholder", this.T(a ? a.needsMsg : "chat.hints.placeholder"));
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
			this._setStatus(this.T(a.needsMsg), "warn");
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
				this._setStatus(this.T(a.needsMsg), "warn");
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
		if (a && this.state.docs.length < a.minDocs && this.mode !== "window") {
			// Painel lateral, registo sem PDF: não há nada a juntar aqui, explica e deixa a janela como saída
			this.selectedAction = null;
			this._renderPending();
			this._updateButtons();
			this._setStatus(this.T("chat.noPdfAction"), "warn");
			return;
		}
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
	 * Cada ação tem o seu separador: vai para o separador dela (ou um novo). Uma pergunta fica no
	 * separador à vista, para se poder continuar a conversa ("e quanto à amostra?"): leva as últimas
	 * trocas desse separador (ver selectHistory). Um separador vazio é aproveitado.
	 */
	_routeConversation(actionID) {
		this._ensureConvs();
		if (!actionID) return;
		const i = this._findConvFor(actionID);
		if (i >= 0) {
			if (i !== this.state.active) this._switchTo(i);
			return;
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
				this._setStatus(this.T(chosen.needsMsg), "warn");
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
			this._setStatus(this.T(this.mode === "window" ? "chat.addOne" : "chat.noPdfAction"), "warn");
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
		// A Relevância, a pergunta e as colunas precisam do texto do utilizador, escrito na caixa
		if (base.needsCriteria && !(extra && extra.trim())) {
			this._setStatus(this.T(base.needsMsg), "warn");
			this.textarea.focus();
			return;
		}
		let docs = this.state.docs.slice();
		if (docs.length < a.minDocs && this.mode !== "window") {
			this._setStatus(this.T("chat.noPdfAction"), "warn");
			return;
		}
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
			const falhados = [];
			for (const d of docs) {
				const req = {
					promptText: this.L.actionPrompt(a, [d]),
					display: `${a.label}: ${d.shortRef}`,
					heading: actionID === "ficha" ? `${this.L.fichaPrefix()} · ${d.shortRef}` : `${a.title} · ${d.shortRef}`,
					actionID,
					docs: [d],
					noHistory: true,
					returnMessage: true,
				};
				const msg = await this._askWaiting(req);
				if (!msg) break;
				// Um problema com este PDF (não está no computador, sem texto, com senha) salta o
				// artigo e segue para o seguinte. Um problema do motor pára: ia repetir-se em todos
				if (msg.error && !this._skippableError(msg)) break;
				if (msg.error) falhados.push(d.shortRef);
			}
			if (falhados.length) this._setStatus(this.T("chat.skipped", { n: falhados.length, list: falhados.join(", ") }), "warn");
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
		// Muitos artigos: por lotes (tabelas) ou tema a tema (revisão), senão a resposta sai cortada
		const large = this.L.largeMode(actionID, docs.length);
		if (a.fichasOK && docs.length > 1 && this.useFichas.checked) {
			if (large) {
				const r = await this._collectFichas(base, docs);
				if (r) await this._runLarge(base, r.fichaDocs, { extra, display: a.label, fichas: true, skipped: r.falhadas });
			}
			else await this._runWithFichas(a, docs);
			return;
		}
		if (large) {
			await this._runLarge(base, docs, { extra, display: a.label });
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

	/** Erro só deste PDF (não está no computador, sem texto, com senha): salta e segue. */
	_skippableError(msg) {
		return msg && msg.errorKind === "doc";
	}

	async _runWithFichas(a, docs) {
		const r = await this._collectFichas(a, docs);
		if (!r) return;
		await this._ask({
			promptText: this.L.actionPrompt(a, r.fichaDocs) + "\n\nTrabalha sobre as fichas de extração fornecidas.",
			display: this.T("chat.viaFichas", { label: a.label, docs: r.ok.map(d => d.shortRef).join(", ") }),
			heading: this._heading(a, r.ok),
			actionID: a.id,
			docs: r.fichaDocs,
			warnings: r.falhadas.length ? [this.T("chat.skipped", { n: r.falhadas.length, list: r.falhadas.join(", ") })] : [],
		});
	}

	/** Um pedido de uma série (fichas, relevância, palavras-chave): com limite por minuto, espera e repete o mesmo artigo. */
	async _askWaiting(req) {
		let msg = await this._ask(req);
		for (let w = 0; msg && msg.error && this._waitsOnLimit(msg.engine || this.engine, { kind: msg.errorKind }) && w < this.LIMIT_WAITS.length; w++) {
			this._dropFailed(msg);
			if (!(await this._limitPause(this.LIMIT_WAITS[w], msg.engine || this.engine, "large.limitWait"))) {
				this._setStatus(this.T("chat.cancelled"));
				return null;
			}
			msg = await this._ask(req);
		}
		return msg;
	}

	/** Fichas dos artigos: reutiliza as notas "Ficha IA" e cria as que faltam. null se tiver de parar. */
	async _collectFichas(a, docs) {
		const fichaDocs = [];
		const falhadas = [];
		const autoSave = this.core.pref("fichas.autoSave") !== false;
		let reused = 0, created = 0;
		for (const d of docs) {
			const note = this.core.findFichaNote(d.parentID);
			if (note) {
				fichaDocs.push(Object.assign({}, d, { kind: "ficha", fichaText: this.core.noteToText(note, d) }));
				reused++;
				continue;
			}
			const msg = await this._askWaiting({
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
				return null;
			}
			this._setStatus(this.T("chat.skipped", { n: falhadas.length, list: falhadas.join(", ") }), "warn");
		}
		else this._setStatus(this.T("chat.fichasDone", { reused, created }));
		this._renderFichasLabel();
		return { fichaDocs, falhadas, ok };
	}

	/**
	 * Muitos artigos (mais de LARGE_DOCS em lib.js): as tabelas fazem-se por lotes de BATCH_SIZE e juntam-se
	 * numa tabela única, com uma síntese final escrita a partir dela. A revisão de literatura escreve-se tema
	 * a tema. Fica uma só resposta na conversa e o progresso aparece no estado. Um PDF que não se consegue
	 * ler fica de fora e avisado. docs: os artigos, ou as fichas se "Usar fichas" estiver ligado.
	 */
	async _runLarge(a, docs, { extra, display, engine, fichas, skipped, resume } = {}) {
		if (this.busy) return;
		engine = engine || this.engine;
		if (!this.core.isEngineReady(engine)) {
			this._showSetupInline();
			return;
		}
		if (!(await this._ensurePrivacy(engine))) {
			this._setStatus(this.T("chat.notSent"));
			return;
		}
		if (this.busy) return;
		const actionID = a.id;
		this._routeConversation(actionID);
		const ids = docs.map(d => d.id);
		const userMsg = { role: "user", promptText: "", display: display || a.label, docIDs: ids };
		const botMsg = {
			role: "assistant", text: "", pending: true, heading: this._heading(a, docs), actionID, engine,
			actionLabel: a.label, docIDs: ids, asked: userMsg.display, time: Date.now(),
			request: { large: true, actionID, extra: extra || "", docIDs: ids, fichas: !!fichas, display: userMsg.display },
		};
		this.state.messages.push(userMsg, botMsg);
		this._appendMessage(userMsg);
		this._appendMessage(botMsg);
		this._hideRepeatedAsks();
		this.busy = true;
		this.abort = new this.win.AbortController();
		this._updateButtons();
		const t0 = Date.now();
		const out = { requests: 0, models: new Set(), warnings: [] };
		const left = (skipped || []).slice();
		try {
			const read = await this._loadTextsTolerant(docs);
			left.push(...read.skipped.map(d => d.shortRef));
			const ok = read.ok;
			if (!ok.length) throw Object.assign(new Error(this.T("chat.skippedAll", { list: left.join(", ") })), { kind: "doc" });
			// "Continuar de onde parou" só vale para os mesmos artigos
			const sameDocs = resume && resume.ids === ok.map(d => d.id).join(",");
			if (this.L.BATCH[actionID]) await this._largeTables(a, ok, extra, engine, botMsg, out, sameDocs ? resume : null);
			else await this._largeReview(a, ok, extra, engine, botMsg, out, sameDocs ? resume : null);
			delete botMsg.request.progress;
			if (left.length) out.warnings.unshift(this.T("chat.skipped", { n: left.length, list: left.join(", ") }));
			botMsg.warnings = out.warnings;
			botMsg.model = [...out.models].join(", ") || null;
			// Verificação contra os PDFs e número impresso das páginas, como numa resposta normal
			try {
				const pool = {}, offs = {};
				for (const d of ok) {
					const src = this.state.allDocs[d.id] || d;
					pool[d.id] = { pages: src.pages || null };
					if (typeof src.pageOffset === "number" && src.pageOffset !== 0) offs[d.id] = src.pageOffset;
				}
				if (Object.keys(offs).length) botMsg.pageOffsets = offs;
				const lit = this.L.literalDocIds(Object.values(pool), Object.keys(this.state.allDocs));
				if (lit.length) botMsg.literalIds = lit;
				botMsg.check = this.L.verifyAnswer(botMsg.text, pool);
			}
			catch (e) { this.core.log("Verificação: " + e); }
			botMsg.pending = false;
			this.core.setPref(engine + ".lastTest", "ok");
			botMsg.secs = Math.round((Date.now() - t0) / 1000);
			this._setStatus(this.T("chat.done", { s: botMsg.secs, engine: this.core.engineLabel(engine) }) + " " + (botMsg.usageNote || ""));
		}
		catch (e) {
			// O que já estava feito fica na resposta, com o erro por cima
			botMsg.pending = false;
			botMsg.error = (e && e.message) || String(e);
			botMsg.errorKind = (e && e.kind) || "other";
			botMsg.errorDetail = (e && e.detail) || null;
			if (botMsg.errorKind === "aborted") botMsg.error = this.T("err.aborted");
			if (botMsg.errorKind === "notfound" || botMsg.errorKind === "auth") this.core.setPref(engine + ".lastTest", "fail");
			if (out.warnings.length) botMsg.warnings = out.warnings;
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
	}

	/** Lotes de tabela: cada lote devolve as suas linhas, o addon junta-as e pede a síntese no fim. */
	async _largeTables(a, ok, extra, engine, botMsg, out, resume) {
		const actionID = a.id;
		const b = this.L.BATCH[actionID];
		const batches = this.L.splitBatches(ok, this.L.BATCH_SIZE);
		// O que já está feito fica guardado na resposta: se parar a meio, continua de onde parou
		const st = resume || { ids: ok.map(d => d.id).join(","), next: 0, tables: [], stances: {}, missing: [], requests: 0 };
		botMsg.request.progress = st;
		out.requests += st.requests;
		const { tables, stances, missing } = st;
		if (tables.length) {
			botMsg.text = this.L.tableToMarkdown(this.L.sortMergedRows(actionID, this.L.mergeTables(tables), stances));
			this._renderMessage(botMsg);
		}
		let first = 1 + batches.slice(0, st.next).reduce((n, x) => n + x.length, 0);
		for (let i = st.next; i < batches.length; i++) {
			const batch = batches[i];
			out.status = this.T("large.batch", { i: i + 1, n: batches.length, a: first, b: first + batch.length - 1 });
			this._setStatus(out.status, null, true);
			first += batch.length;
			let text = await this._engineCall(engine, this.L.batchPrompt(actionID, batch, extra), batch, actionID, out);
			if (actionID === "pergunta") {
				Object.assign(stances, this.L.parseStances(text));
				text = this.L.removeStanceLines(text);
			}
			const t = this.L.rawTables(text)[0];
			if (t) tables.push(t);
			const seen = new Set((t ? t.rows : []).map(r => this.L.docIdOf(r[b.docCol])));
			for (const d of batch) if (!seen.has(d.id)) missing.push(d.shortRef);
			st.next = i + 1;
			st.requests = out.requests;
			// A tabela vai crescendo à medida que os lotes chegam
			const partial = this.L.mergeTables(tables);
			if (partial) {
				botMsg.text = this.L.tableToMarkdown(this.L.sortMergedRows(actionID, partial, stances));
				this._renderMessage(botMsg);
			}
		}
		const merged = this.L.mergeTables(tables);
		if (!merged) throw new Error(this.T("large.noTable"));
		const table = this.L.tableToMarkdown(this.L.sortMergedRows(actionID, merged, stances));
		// Síntese: cada documento leva só as suas linhas da tabela, em vez do PDF inteiro
		const rows = this.L.rowsAsFichas(merged, b.docCol);
		const synthDocs = ok.filter(d => rows[d.id]).map(d => Object.assign({}, d, { kind: "ficha", fichaText: rows[d.id] }));
		out.status = this.T("large.synth");
		this._setStatus(out.status, null, true);
		let synth = await this._engineCall(engine, this.L.synthPrompt(actionID, synthDocs, extra), synthDocs, actionID, out);
		if (actionID === "pergunta") synth = this.L.removeStanceLines(synth);
		botMsg.text = table + "\n\n" + synth.trim();
		if (Object.keys(stances).length) botMsg.stances = stances;
		if (missing.length) out.warnings.push(this.T("large.missing", { list: missing.join(", ") }));
		botMsg.usageNote = this.T("large.done", { b: batches.length, r: out.requests });
	}

	/** Revisão de literatura com muitos artigos: temas primeiro, uma parte por tema, depois o fecho. */
	async _largeReview(a, ok, extra, engine, botMsg, out, resume) {
		const metaDocs = [];
		for (const d of ok) {
			const text = this.core.itemMetaText ? await this.core.itemMetaText(d) : (d.fullRef || d.ref);
			metaDocs.push(Object.assign({}, d, { kind: "ficha", fichaText: text }));
		}
		// O que já está feito fica guardado na resposta: se parar a meio, continua de onde parou
		const st = resume || { ids: ok.map(d => d.id).join(","), groups: null, next: 0, parts: [], requests: 0 };
		botMsg.request.progress = st;
		out.requests += st.requests;
		if (!st.groups) {
			out.status = this.T("large.themes");
			this._setStatus(out.status, null, true);
			const themesText = await this._engineCall(engine, this.L.actionPrompt("temas", metaDocs), metaDocs, "temas", out);
			let groups = this.L.parseThemeList(themesText).map(t => ({ name: t.name, ids: t.docs }));
			// Sem temas, grupos de artigos. Os artigos que ficaram sem tema vão para "Outros"
			if (!groups.length) groups = this.L.splitBatches(ok, this.L.BATCH_SIZE).map((g, i) => ({ name: this.T("large.group", { i: i + 1 }), ids: g.map(d => d.id) }));
			const placed = new Set([].concat(...groups.map(g => g.ids)));
			const rest = ok.filter(d => !placed.has(d.id)).map(d => d.id);
			if (rest.length) groups.push({ name: this.T("large.other"), ids: rest });
			st.groups = groups;
			st.requests = out.requests;
		}
		const groups = st.groups;
		const byId = new Map(ok.map(d => [d.id, d]));
		const parts = st.parts;
		if (parts.length) {
			botMsg.text = parts.join("\n\n");
			this._renderMessage(botMsg);
		}
		for (let i = st.next; i < groups.length; i++) {
			const g = groups[i];
			const gd = g.ids.map(id => byId.get(id)).filter(Boolean);
			st.next = i + 1;
			if (!gd.length) continue;
			out.status = this.T("large.part", { i: i + 1, n: groups.length, name: g.name });
			this._setStatus(out.status, null, true);
			let txt;
			try {
				txt = (await this._engineCall(engine, this.L.reviewPartPrompt(g.name, gd, extra), gd, a.id, out)).trim();
			}
			catch (e) {
				st.next = i;
				throw e;
			}
			if (!/^#{1,3}\s/.test(txt)) txt = `## ${g.name}\n\n${txt}`;
			parts.push(txt);
			st.requests = out.requests;
			botMsg.text = parts.join("\n\n");
			this._renderMessage(botMsg);
		}
		out.status = this.T("large.end");
		this._setStatus(out.status, null, true);
		const end = await this._engineCall(engine, this.L.reviewEndPrompt(parts.join("\n\n"), metaDocs), metaDocs, a.id, out);
		botMsg.text = parts.join("\n\n") + "\n\n" + end.trim();
		botMsg.usageNote = this.T("large.partsDone", { n: parts.length, r: out.requests });
	}

	/** Um pedido ao motor, sem mensagem própria na conversa (para os lotes). Devolve o texto. */
	async _engineCall(engine, promptText, docs, actionID, out) {
		if (this.abort.signal.aborted) throw Object.assign(new Error(this.T("err.aborted")), { kind: "aborted" });
		const action = this._action(actionID);
		const fitted = this.L.fitDocuments(docs, this.core.maxCharsFor(engine), { keepRefs: !!(action && action.keepRefs) });
		for (const w of fitted.warnings) if (!out.warnings.includes(w)) out.warnings.push(w);
		const promptParts = this.L.buildRequestParts({ fitted, history: [], userText: promptText });
		const aborted = () => Object.assign(new Error(this.T("err.aborted")), { kind: "aborted" });
		// Depois de um aviso de limite, uma pausa curta entre pedidos para não voltar a ele
		if (out.pace && !(await this._limitPause(out.pace, engine, "large.pace"))) throw aborted();
		for (let attempt = 0; ; attempt++) {
			try {
				const res = await this.core.runEngine(engine, {
					system: this.L.buildSystemPrompt("ui"),
					prompt: promptParts.docs + "\n\n" + promptParts.rest,
					promptParts,
					heavy: true,
					noLite: true,
					win: this.win,
					signal: this.abort.signal,
					onDelta: () => {},
					onInfo: info => { if (info && info.notice) this._setStatus(info.notice, null, true); },
				});
				out.requests++;
				if (res.model) out.models.add(res.model);
				return res.text || "";
			}
			catch (e) {
				// Limite de pedidos por minuto: espera e repete o mesmo pedido, sem perder o que está feito
				if (!this._waitsOnLimit(engine, e) || attempt >= this.LIMIT_WAITS.length) throw e;
				out.pace = this.LIMIT_PACE;
				if (!(await this._limitPause(this.LIMIT_WAITS[attempt], engine, "large.limitWait"))) throw aborted();
				if (out.status) this._setStatus(out.status, null, true);
			}
		}
	}

	/**
	 * Um limite de pedidos por minuto passa com uma espera. Só nos motores com chave (IAEdu, Claude API,
	 * ChatGPT API): o Gemini já espera sozinho e o limite da subscrição do Claude Code e do Codex dura horas.
	 */
	_waitsOnLimit(engine, e) {
		return !!(e && e.kind === "limit") && ["iaedu", "anthropic", "openai"].includes(engine) && !(this.abort && this.abort.signal.aborted);
	}

	/** Pausa com contagem decrescente, que o botão de parar interrompe. Devolve false se a pessoa parou. */
	async _limitPause(sec, engine, key) {
		const own = !this.busy;
		if (own) {
			this.busy = true;
			this.abort = new this.win.AbortController();
			this._updateButtons();
		}
		try {
			for (let s = sec; s > 0; s--) {
				if (this.abort.signal.aborted) return false;
				this._setStatus(this.T(key, { engine: this.core.engineLabel(engine), s }), null, true);
				await this.core._sleep(1000, this.abort.signal);
			}
			return !this.abort.signal.aborted;
		}
		finally {
			if (own) {
				this.busy = false;
				this.abort = null;
				this._updateButtons();
			}
		}
	}

	/** Retira da conversa um pedido que falhou por limite e vai ser repetido (sem aviso). */
	_dropFailed(m) {
		const list = this.state.messages;
		const i = list.indexOf(m);
		if (i < 0) return;
		const from = i > 0 && list[i - 1].role === "user" ? i - 1 : i;
		list.splice(from, i - from + 1);
		this._renderMessages();
	}

	/** Lê os PDFs um a um. Um PDF que não se consegue ler fica de fora, um problema do motor pára. */
	async _loadTextsTolerant(docs) {
		const ok = [], skipped = [];
		const toRead = docs.filter(d => d.kind !== "ficha" && !d.pages).length;
		let k = 0;
		for (const d of docs) {
			if (this.abort.signal.aborted) throw Object.assign(new Error(this.T("err.aborted")), { kind: "aborted" });
			if (d.kind === "ficha" || d.pages) {
				ok.push(d);
				continue;
			}
			k++;
			this._setStatus(this.T("chat.reading", { i: k, n: toRead, ref: d.shortRef }), null, true);
			try {
				await this.core.loadText(d);
				ok.push(d);
			}
			catch (e) {
				if (e && e.kind === "doc") skipped.push(d);
				else throw e;
			}
		}
		return { ok, skipped };
	}

	/** Repetir uma resposta feita por lotes: volta a fazer tudo com os mesmos artigos e indicações. */
	async _startLarge(req, engine) {
		const a = this._action(req.actionID);
		const docs = req.docIDs.map(id => this.state.allDocs[id]).filter(Boolean);
		if (!a || !docs.length) return;
		if (req.fichas) {
			const r = await this._collectFichas(a, docs);
			if (!r) return;
			await this._runLarge(a, r.fichaDocs, { extra: req.extra, display: req.display, engine, fichas: true, skipped: r.falhadas, resume: req.progress });
			return;
		}
		await this._runLarge(a, docs, { extra: req.extra, display: req.display, engine, resume: req.progress });
	}

	/**
	 * Envia um pedido e mostra a resposta em fluxo.
	 * Devolve true/false (ou a mensagem, se returnMessage).
	 */
	async _ask({ promptText, display, heading, actionID, docs, noHistory, returnMessage, engine, stay, warnings }) {
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
				if (orig && orig !== pdfDocs[i]) Object.assign(orig, { pages: pdfDocs[i].pages, pagesReliable: pdfDocs[i].pagesReliable, chars: pdfDocs[i].chars, pageOffset: pdfDocs[i].pageOffset });
			}
			for (const d of docs) {
				if (d.kind !== "ficha" && !d.pages) {
					const orig = this.state.allDocs[d.id];
					if (orig && orig.pages) Object.assign(d, { pages: orig.pages, pagesReliable: orig.pagesReliable, pageOffset: orig.pageOffset });
				}
			}
			// Fichas: o texto do PDF não vai no pedido, só serve para a verificação e para o número
			// impresso das páginas. Se não se conseguir ler, a ficha segue na mesma.
			for (const d of docs) {
				if (d.kind !== "ficha" || d.pages) continue;
				const orig = this.state.allDocs[d.id];
				if (orig && orig.pages) {
					Object.assign(d, { pages: orig.pages, pagesReliable: orig.pagesReliable, pageOffset: orig.pageOffset });
					continue;
				}
				try {
					await this.core.loadText(d);
					if (orig && orig !== d) Object.assign(orig, { pages: d.pages, pagesReliable: d.pagesReliable, chars: d.chars, pageOffset: d.pageOffset });
				}
				catch (e) {
					this.core.log("Ficha sem o texto do PDF: " + e);
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
			// Avisos do pedido (texto cortado…) e os que vêm de trás (artigos que ficaram de fora): ficam na resposta
			botMsg.warnings = fitted.warnings.concat(warnings || []);
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
					// Um artigo sem texto lido (ficha) fica na lista: as citações dele não são "páginas que não existem"
					pool[d.id] = { pages: (src && src.pages) || null };
					// O número impresso das páginas fica na resposta, para as citações o manterem
					if (src && typeof src.pageOffset === "number" && src.pageOffset !== 0) offs[d.id] = src.pageOffset;
				}
				if (Object.keys(offs).length) botMsg.pageOffsets = offs;
				const lit = this.L.literalDocIds(Object.values(pool), Object.keys(this.state.allDocs));
				if (lit.length) botMsg.literalIds = lit;
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
		if (msg.request.large) {
			await this._startLarge(msg.request, engine);
			return;
		}
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
		const lit = m && m.literalIds && m.literalIds.length ? m.literalIds : null;
		if (!offs && !lit) return base;
		const out = Object.assign({}, base);
		for (const id of Object.keys(offs || {})) {
			if (out[id] && out[id].pageOffset !== offs[id]) out[id] = Object.assign({}, out[id], { pageOffset: offs[id] });
		}
		// "D1" que o próprio PDF usa como nome (recetores D1 e D2): não se troca pelo autor
		if (lit) Object.defineProperty(out, "literalIds", { value: new Set(lit), enumerable: false });
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
		if (m.warnings && m.warnings.length) {
			const w = this._el("div", "zia-warn");
			for (const t of m.warnings) w.appendChild(this._el("div", null, t));
			el.appendChild(w);
		}
		// O mapa mental desenha a lista encaixada como uma árvore com ramos
		if (m.stances && Object.keys(m.stances).length && !m.pending) el.appendChild(this._stanceMeter(m.stances));
		const isMap = m.actionID === "mapa" || m.actionID === "temas";
		const body = this._el("div", "zia-md" + (isMap ? " zia-mindmap" : ""));
		// Resultado da verificação de cada citação, pela ordem do texto ("D1:p4#2"): marca e cartão de prova
		const items = {};
		for (const it of (m.check && m.check.items) || []) items[it.key] = it;
		const seen = {};
		const ctx = {
			docsMap: this._docsMap(m),
			citeItem: m.check && m.check.items ? inner => items[inner + "#" + (seen[inner] = (seen[inner] || 0) + 1)] || null : null,
			onCite: (c, extra) => this._openCite(c, extra && Object.assign({ m }, extra)),
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
		else {
			// Textos longos (revisão tema a tema): índice que salta para cada parte
			const toc = m.actionID === "cmp_sintese" ? this._tocRow(body) : null;
			if (toc) el.appendChild(toc);
			this._enhanceTables(body);
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
				// Por lotes, com parte feita: continua de onde parou em vez de refazer tudo
				const resume = m.request.large && m.request.progress && (m.request.progress.next > 0 || m.request.progress.groups);
				row.appendChild(this._button(this.T(resume ? "large.resume" : "chat.retry"), "zia-btn-small" + (resume ? " zia-btn-primary" : ""), () => this._retry(m, m.engine)));
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
	/**
	 * Uma linha no fim da resposta: quantas transcrições foram confirmadas e quantas citações rever
	 * (estas têm a marca ✗ no texto). "N a rever" salta para a primeira e abre o cartão. Só os
	 * problemas sem citação ao lado (página que não existe, conta errada, número solto) vão numa lista.
	 */
	_checkBox(c, m) {
		if (!c.items) return this._checkBoxOld(c, m);
		const L = this.L;
		const dm = this._docsMap(m);
		const flagged = c.items.filter(it => L.citeState(it) === "bad").length;
		const loose = [];
		for (const b of (c.badCites || []).slice(0, 3)) loose.push(this.T("check.badCite", { c: L.citeLabel(b, dm, { raw: true }) }));
		for (const e of (c.badCalcs || []).slice(0, 3)) loose.push(this.T("check.badCalc", { e }));
		if ((c.looseNumbers || []).length) loose.push(this.T("check.numbers", { n: c.looseNumbers.slice(0, 8).join(", ") }));
		const review = flagged + loose.length;
		const found = c.quotesOK + (c.wrongPage || []).length;
		if (!review && !c.quotes && !c.anchors) {
			if (c.numbers) return this._el("div", "zia-check zia-check-ok", this.T("check.okNumbers", { n: c.numbers }));
			return this._el("div", "zia-check zia-check-info", this.T(c.cites === 0 ? "check.noCites" : "check.okNoQuotes"));
		}
		const box = this._el("div", "zia-check zia-check-line" + (review ? " zia-check-review" : " zia-check-ok"));
		box.setAttribute("role", "note");
		// Transcrições (✓), paráfrases com frase de base (≈) e as que ficaram sem verificação
		const bits = [];
		if (c.quotes) bits.push((found ? "\u2713 " : "") + this.T("check.sum", { ok: found, n: c.quotes }));
		if (c.anchors) bits.push((c.anchorsOK ? "\u2248 " : "") + this.T("check.sumBased", { ok: c.anchorsOK, n: c.anchors }));
		if (c.unmarked && (c.quotes || c.anchors)) bits.push(this.T("check.unmarked", { n: c.unmarked }));
		bits.forEach((t, i) => {
			if (i) box.appendChild(this.doc.createTextNode(" · "));
			box.appendChild(this._el("span", null, t));
		});
		let list = null;
		if (review) {
			if (bits.length) box.appendChild(this.doc.createTextNode(" · "));
			box.appendChild(this._button(this.T("check.review", { k: review }), "zia-check-go", () => {
				const first = m.el && m.el.querySelector(".zia-cite-bad");
				if (first) {
					first.scrollIntoView({ block: "center" });
					if (!first.classList.contains("zia-cite-open")) first.click();
				}
				else if (list) list.scrollIntoView({ block: "center" });
			}));
		}
		// ⓘ: o que querem dizer as marcas (para "sem marca" não parecer "errado")
		const wrap = this._el("div", "zia-check-wrap");
		wrap.appendChild(box);
		const legend = this._el("ul", "zia-check-legend");
		legend.hidden = true;
		for (const k of ["ok", "based", "moved", "bad", "none"]) legend.appendChild(this._el("li", null, this.T("check.legend." + k)));
		const info = this._button("\u24d8", "zia-check-info-btn", () => { legend.hidden = !legend.hidden; }, this.T("check.legend.tip"));
		info.setAttribute("aria-label", this.T("check.legend.tip"));
		box.appendChild(info);
		if (loose.length) {
			list = this._el("ul", "zia-check-loose");
			for (const t of loose) list.appendChild(this._el("li", null, t));
			wrap.appendChild(list);
		}
		wrap.appendChild(legend);
		return wrap;
	}

	/** Respostas guardadas antes da prova por citação: a caixa antiga com a lista de avisos. */
	_checkBoxOld(c, m) {
		const dm = this._docsMap(m);
		const ref = cite => {
			if (!cite) return "";
			const cs = this.L.parseCiteGroup(cite);
			return cs.length ? " (" + cs.map(x => this.L.citeLabel(x, dm)).join("; ") + ")" : "";
		};
		if (!c.problems) {
			// O visto só diz o que foi mesmo confirmado: as paráfrases da IA nunca são
			const ok = text => this._el("div", "zia-check zia-check-ok", text);
			if (c.quotesOK) {
				if (this.simple) return ok(this.T("check.simpleOk", { q: c.quotesOK }));
				return ok(this.T(c.calcs ? "check.okCalc" : "check.ok", { q: c.quotesOK, n: c.numbers, c: c.calcs }));
			}
			if (c.numbers) return ok(this.T("check.okNumbers", { n: c.numbers }));
			return this._el("div", "zia-check zia-check-info", this.T(c.cites === 0 ? "check.noCites" : "check.okNoQuotes"));
		}
		const box = this._el("div", "zia-check zia-check-warn");
		box.setAttribute("role", "note");
		box.appendChild(this._el("div", "zia-check-title", this.T("check.warn", { n: c.problems })));
		const ul = this._el("ul");
		const add = t => ul.appendChild(this._el("li", null, t));
		for (const q of c.badQuotes.slice(0, 4)) add(this.T("check.badQuote", { q: q.quote }) + ref(q.cite));
		for (const q of (c.changedQuotes || []).slice(0, 3)) add(this.T("check.changedQuote", { q: q.quote }) + ref(q.cite));
		for (const q of c.wrongPage.slice(0, 3)) add(this.T("check.wrongPage", { q: q.quote }) + ref(q.cite));
		for (const q of (c.otherDoc || []).slice(0, 3)) add(this.T("check.otherDoc", { q: q.quote, d: this.L.citeLabel({ doc: q.doc }, dm) }) + ref(q.cite));
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

	/** Na janela, tabelas com muitas linhas: altura própria, cabeçalho e 1.ª coluna fixos, pesquisa e filtros. */
	_enhanceTables(body) {
		if (this.mode !== "window") return;
		const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
		for (const wrap of body.querySelectorAll(".zia-table-wrap")) {
			const rows = [...wrap.querySelectorAll("tbody tr")];
			if (rows.length < this.TABLE_TOOLS) continue;
			wrap.classList.add("zia-table-big");
			const bar = this._el("div", "zia-table-bar");
			const search = this._el("input", "zia-table-search");
			search.type = "search";
			search.placeholder = this.T("table.search");
			search.setAttribute("aria-label", this.T("table.search"));
			const count = this._el("span", "zia-table-count", this.T("table.rows", { n: rows.length }));
			const texts = rows.map(r => norm(r.textContent));
			const cat = this._categoryColumn(wrap, rows);
			let catVal = null;
			const apply = () => {
				const q = norm(search.value.trim());
				let n = 0;
				rows.forEach((r, i) => {
					const show = (!q || texts[i].includes(q)) && (catVal == null || cat.values[i] === catVal);
					r.hidden = !show;
					if (show) n++;
				});
				count.textContent = n === rows.length ? this.T("table.rows", { n }) : this.T("table.rowsOf", { k: n, n: rows.length });
			};
			search.addEventListener("input", apply);
			bar.appendChild(search);
			// Coluna de categorias (Resposta, Decisão…): um botão por valor, com quantos há
			if (cat) {
				const chips = this._el("div", "zia-table-chips");
				const set = (v, btn) => {
					catVal = v;
					for (const c of chips.children) c.classList.toggle("on", c === btn);
					apply();
				};
				const all = this._button(this.T("table.all", { n: rows.length }), "zia-table-chip on", ev => set(null, ev.currentTarget));
				chips.appendChild(all);
				for (const v of cat.distinct) {
					const n = cat.values.filter(x => x === v).length;
					chips.appendChild(this._button(`${v} ${n}`, "zia-table-chip", ev => set(v, ev.currentTarget)));
				}
				bar.appendChild(chips);
			}
			bar.appendChild(count);
			wrap.parentNode.insertBefore(bar, wrap);
		}
	}

	/** Coluna com poucos valores curtos (Sim, Não…; Incluir, Excluir…), boa para filtrar. */
	_categoryColumn(wrap, rows) {
		const head = wrap.querySelectorAll("thead th");
		for (let c = 1; c < head.length; c++) {
			const values = rows.map(r => (r.children[c] ? r.children[c].textContent.replace(/\s+/g, " ").trim() : ""));
			const distinct = [...new Set(values)];
			if (distinct.length >= 2 && distinct.length <= 5 && distinct.every(v => v && v.length <= 24)) return { values, distinct };
		}
		return null;
	}

	/** Índice da revisão de literatura (4 ou mais partes): um botão por parte, que salta para ela. */
	_tocRow(body) {
		if (this.mode !== "window") return null;
		const heads = [...body.querySelectorAll("h3.zia-h")];
		if (heads.length < 4) return null;
		const row = this._el("div", "zia-toc");
		row.appendChild(this._el("span", "zia-toc-label", this.T("toc.label")));
		for (const h of heads) {
			const b = this._button(h.textContent, "zia-toc-item", () => h.scrollIntoView({ block: "start", behavior: "smooth" }));
			row.appendChild(b);
		}
		return row;
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
		// Mapa de temas: uma linha por artigo e tema, para o Excel
		if (m.actionID === "temas" && !m.pending && this.L.parseThemeList(m.text).length) {
			row.appendChild(this._button(this.T("chat.exportCsv"), "zia-btn-small", async () => {
				const csv = this.L.themesToCSV(m.text, { docsMap: this._docsMap(m) });
				try {
					const path = await this.core.saveCSV(this.win, csv, m.heading || "temas");
					if (path) this._setStatus(this.T("chat.exported", { path }));
				}
				catch (e) {
					this._setStatus(this.T("chat.exportError", { e: e.message || e }), "error");
				}
			}, this.T("chat.exportThemes.tip")));
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

	/**
	 * Clique numa citação. Com resultado da verificação (marca ✓, ↪ ou ✗) abre ou fecha o cartão de prova
	 * logo por baixo. Sem marca (paráfrase) abre o PDF na página. Sem caixa de pesquisa no leitor do
	 * Zotero (confundia as pessoas): a prova lê-se no próprio cartão.
	 */
	_openCite(c, extra) {
		if (extra && extra.item && extra.el) return this._toggleProof(extra.item, c, extra.el, extra.m, extra.k);
		const d = this._docsMap()[c.doc];
		if (!d) {
			this._setStatus(this.T("chat.docMissing", { doc: c.doc }), "warn");
			return;
		}
		this._openPage(d, c.page);
	}

	_openPage(d, page) {
		if (!d) return;
		this.core.openAtPage(d, page).catch(e => this._setStatus(this.T("chat.openError", { e }), "error"));
	}

	_toggleProof(item, c, chip, m, k) {
		if (chip._proof && chip._proof.isConnected) {
			chip._proof.remove();
			chip._proof = null;
			chip.classList.remove("zia-cite-open");
			return;
		}
		const card = this._proofCard(item, c, m, () => this._toggleProof(item, c, chip, m, k), k);
		// Por baixo do parágrafo, do item da lista ou da tabela onde está a citação
		const table = chip.closest("table");
		const host = (table && (table.closest(".zia-table-wrap") || table)) || chip.closest("li, p, blockquote, h2, h3, h4, h5, h6") || chip.parentNode;
		if (host.localName === "li") host.appendChild(card);
		else host.parentNode.insertBefore(card, host.nextSibling);
		chip._proof = card;
		chip.classList.add("zia-cite-open");
	}

	/** Cartão de prova: o parágrafo do PDF com a frase a amarelo, ou o que o PDF diz quando não bate certo. */
	_proofCard(item, c, m, onClose, k) {
		const L = this.L;
		const dm = this._docsMap(m);
		const pg = (doc, page) => "p. " + L.pageLabel(dm[doc], page);
		const ref = doc => L.citeLabel({ doc }, dm);
		const state = L.citeState(item, k) || "ok";
		// Paráfrase com frase de base: o resultado desta citação do grupo
		const part = item.parts && k != null ? item.parts[k] : null;
		const src = part || item;
		const said = part ? part.anchor : item.quote;
		const card = this._el("div", "zia-proof zia-proof-" + state);
		const head = this._el("div", "zia-proof-head");
		const title = this._el("span", "zia-proof-title");
		head.appendChild(title);
		head.appendChild(this._button("\u2715", "zia-proof-x", onClose, this.T("proof.close")));
		card.appendChild(head);
		const text = t => card.appendChild(this._el("div", "zia-proof-text", t));
		const join = (a, b) => !a ? b : !b ? a : /\s$/.test(a) || /^\s/.test(b) ? a + b : a + " " + b;
		const passage = (p, soft) => {
			if (!p || !p.match) return;
			const box = this._el("div", "zia-proof-pdf");
			if (p.before) box.appendChild(this.doc.createTextNode(join(p.before, "")));
			const mk = this._el("mark", soft ? "zia-proof-soft" : null, p.match);
			if (p.before && !/\s$/.test(p.before)) box.appendChild(this.doc.createTextNode(" "));
			box.appendChild(mk);
			if (p.after) box.appendChild(this.doc.createTextNode(/^\s/.test(p.after) ? p.after : " " + p.after));
			card.appendChild(box);
		};
		const open = (doc, page, label) => {
			if (!dm[doc]) return;
			const b = this._button(label || this.T("proof.open"), "zia-proof-open", () => this._openPage(dm[doc], page));
			card.appendChild(b);
		};
		const ev = src.evidence, near = src.near;
		switch (src.status) {
			case "based":
				title.textContent = this.T("proof.based", { p: pg((ev && ev.doc) || c.doc, (ev && ev.page) || c.page) });
				passage(ev);
				text(this.T("proof.based.text"));
				open((ev && ev.doc) || c.doc, (ev && ev.page) || c.page);
				break;
			case "ok":
				title.textContent = this.T("proof.ok", { p: pg((ev && ev.doc) || c.doc, (ev && ev.page) || c.page) });
				passage(ev);
				open((ev && ev.doc) || c.doc, (ev && ev.page) || c.page);
				break;
			case "moved":
				title.textContent = this.T("proof.moved", { p: pg(ev.doc, ev.page), q: pg(c.doc, c.page) });
				passage(ev);
				open(ev.doc, ev.page, this.T("proof.open"));
				break;
			case "otherDoc":
				title.textContent = this.T("proof.otherDoc");
				text(this.T("proof.otherDoc.text", { doc: ref(ev.doc), p: ev.page ? ", " + pg(ev.doc, ev.page) : "", cited: ref(c.doc) }));
				passage(ev);
				open(ev.doc, ev.page, this.T("proof.openDoc", { doc: ref(ev.doc), p: pg(ev.doc, ev.page) }));
				break;
			case "changed": {
				const d = near && L.wordDiff(said, near.match);
				title.textContent = this.T("proof.changed", { p: pg(near ? near.doc : c.doc, near ? near.page : c.page) });
				if (d) {
					const row = (label, cls, parts) => {
						const r = this._el("div", "zia-proof-diff");
						r.appendChild(this._el("b", null, label));
						const q = this._el("span", cls);
						// Palavras separadas por um espaço. As aspas « » ficam coladas ao texto
						let prev = null;
						for (const x of parts) {
							const w = typeof x === "string" ? x.trim() : x.w;
							if (!w) continue;
							if (prev !== null && prev !== "«" && w !== "»") q.appendChild(this.doc.createTextNode(" "));
							q.appendChild(typeof x !== "string" && x.diff ? this._el(cls === "zia-proof-q" ? "s" : "b", "zia-diff", w) : this.doc.createTextNode(w));
							prev = w;
						}
						card.appendChild(r);
						r.appendChild(q);
					};
					row(this.T(part ? "proof.anchor" : "proof.answer"), "zia-proof-q", ["«", ...d.a, "»"]);
					row(this.T("proof.pdf"), "zia-proof-p", [d.bBefore ? d.bBefore + " " : "", ...d.b, d.bAfter ? " " + d.bAfter : ""]);
					text(this.T(part ? "proof.changed.anchorText" : "proof.changed.text"));
				}
				else text(this.T("proof.bad.none"));
				open(near ? near.doc : c.doc, near ? near.page : c.page);
				break;
			}
			case "bad":
				title.textContent = this.T(part ? "proof.anchorBad" : "proof.bad");
				if (part) text(this.T("proof.anchorBad.text"));
				if (near) {
					text(this.T(part ? "proof.near" : "proof.bad.near", { p: pg(near.doc, near.page) }));
					passage(near, true);
				}
				else text(this.T("proof.bad.none"));
				open(near ? near.doc : c.doc, near ? near.page : c.page);
				break;
			case "note":
				title.textContent = this.T("proof.note");
				text(this.T("proof.note.text"));
				break;
			default:
				title.textContent = this.T("proof.numbersTitle");
				open(c.doc, c.page);
		}
		if (item.numbers && item.numbers.length) {
			const n = this._el("div", "zia-proof-text zia-proof-numbers", this.T("proof.numbers", { doc: ref(c.doc), n: item.numbers.join(", ") }));
			card.insertBefore(n, card.querySelector(".zia-proof-open"));
		}
		return card;
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

	_openPrefs(scrollTo) {
		try {
			Zotero.Utilities.Internal.openPreferences(this.core.PREFS_PANE_ID, scrollTo ? { scrollTo } : undefined);
		}
		catch (e) {
			this.core.log("openPreferences: " + e);
		}
	}
};
