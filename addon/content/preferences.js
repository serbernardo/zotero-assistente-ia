/*
 * Assistente IA para Zotero: painel de definições.
 */

/* global Zotero, Services, window, document, setTimeout, clearTimeout */

window.ZIAPrefs = {
	core() {
		return Zotero.ZoteroIA;
	},

	T(key, vars) {
		return this.core().t(key, vars);
	},

	$(id) {
		return document.getElementById(id);
	},

	html(tag, text) {
		const e = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
		if (text != null) e.textContent = text;
		return e;
	},

	init() {
		if (this._inited || !this.$("zoteroia-prefs-root")) return;
		const core = this.core();
		if (!core) return;
		this._inited = true;
		const on = (id, fn) => {
			const el = this.$(id);
			if (el) el.addEventListener("command", fn);
		};
		for (const name of ["anthropic", "openai", "gemini"]) {
			on(`zia-${name}-save`, () => this.saveKey(name));
			on(`zia-${name}-clear`, () => this.clearKey(name));
			// Enter no campo da chave guarda e testa
			const input = this.$(`zia-${name}-key`);
			if (input) {
				input.addEventListener("keydown", ev => {
					if (ev.key === "Enter") {
						ev.preventDefault();
						this.saveKey(name);
					}
				});
			}
		}
		on("zia-gemini-list", () => this.listGemini());
		on("zia-gemini-probe", () => this.probeGemini());
		for (const tool of ["claude", "codex"]) {
			on(`zia-${tool}-detect`, () => this.detect(tool));
			on(`zia-${tool}-test`, () => this.test(tool));
		}
		on("zia-claude-install", () => this.installClaude());
		on("zia-claude-copy", () => this.copyClaudeCommand());
		on("zia-clear-all", () => this.clearAll());
		on("zia-update-check", () => this.checkUpdates());
		on("zia-history-clear", async () => {
			try {
				await this.core().clearAllConversations();
				this.setText("zia-history-result", this.T("prefs.historyCleared"));
			}
			catch (e) { this.setText("zia-history-result", e.message || String(e), true); }
		});
		on("zia-reset-privacy", () => this.resetPrivacy());
		// Ligações: abrem no browser
		for (const a of document.querySelectorAll("a.zia-link[data-url]")) {
			a.href = a.getAttribute("data-url");
			a.addEventListener("click", ev => {
				ev.preventDefault();
				try { Zotero.launchURL(a.getAttribute("data-url")); }
				catch (e) { core.log("Abrir ligação: " + e); }
			});
		}
		this.initClaudeModel();
		const gsel = this.$("zia-gemini-model");
		if (gsel) gsel.addEventListener("change", () => core.setPref("gemini.model", gsel.value));
		this.fillGeminiSelect(null);
		if (core.hasSecret("gemini")) this.listGemini(true);
		this.initUILanguage();
		this.initModelSelect("anthropic");
		this.initModelSelect("openai");
		this.initAnswerLanguage();
		this.initCustomPrompts();
		this.translate();
		this.refresh();
	},

	/** Aplica os textos da língua da interface a todos os elementos marcados. */
	translate() {
		const root = this.$("zoteroia-prefs-root");
		for (const el of root.querySelectorAll("[data-zia]")) el.textContent = this.T(el.getAttribute("data-zia"));
		for (const el of root.querySelectorAll("[data-zia-label]")) el.setAttribute("label", this.T(el.getAttribute("data-zia-label")));
		for (const id of ["zia-pref-claude-path", "zia-pref-codex-path"]) {
			const el = this.$(id);
			if (el) el.setAttribute("placeholder", this.T("prefs.path.placeholder"));
		}
		for (const name of ["anthropic", "openai", "gemini"]) {
			const el = this.$(`zia-${name}-key`);
			if (el) el.setAttribute("aria-label", this.T("prefs.apiKey"));
		}
		const ta = this.$("zia-custom-prompts");
		if (ta) ta.setAttribute("placeholder", this.T("prefs.prompts.placeholder"));
		this.setText("zia-version", this.T("prefs.update.version", { v: this.core().version || "?" }));
		const cmd = this.$("zia-claude-command");
		if (cmd) cmd.textContent = this.core().claudeInstallCommand();
		this.fillAnswerLanguage();
		this.initModelSelect("anthropic");
		this.initModelSelect("openai");
		this.showPromptCount();
	},

	setText(id, text, isError) {
		const el = this.$(id);
		if (!el) return;
		el.textContent = text;
		el.style.color = isError ? "var(--accent-red, #d93f33)" : "";
	},

	fillSelect(sel, items, value) {
		while (sel.firstChild) sel.removeChild(sel.firstChild);
		for (const [v, label] of items) {
			const o = this.html("option", label);
			o.value = v;
			sel.appendChild(o);
		}
		sel.value = value;
	},

	// ------------------------------------------------------------------
	// Línguas
	// ------------------------------------------------------------------

	initUILanguage() {
		const core = this.core();
		const sel = this.$("zia-ui-lang");
		if (!sel) return;
		const fill = () => this.fillSelect(sel, [
			["auto", this.T("prefs.uiLang.auto")], ["pt-PT", "Português (Portugal)"], ["en", "English"],
		], core.pref("ui.lang") || "auto");
		fill();
		sel.addEventListener("change", () => {
			core.setPref("ui.lang", sel.value);
			core.applyLanguage();
			fill();
			this.translate();
			this.refresh();
		});
	},

	initAnswerLanguage() {
		const sel = this.$("zia-answer-lang");
		if (!sel) return;
		sel.addEventListener("change", () => this.core().setPref("answerLang", sel.value));
	},

	fillAnswerLanguage() {
		const core = this.core();
		const sel = this.$("zia-answer-lang");
		if (!sel) return;
		const cur = core.pref("answerLang") || "ui";
		this.fillSelect(sel, core.lib.LANGUAGES.map(l => [l.id, l.label]), core.lib.LANGUAGES.some(l => l.id === cur) ? cur : "ui");
	},

	// ------------------------------------------------------------------
	// Escolha do motor e estado de cada um
	// ------------------------------------------------------------------

	/** Estado simples de um motor: ok (pronto), fail (último teste falhou), saved (falta testar), todo (por configurar). */
	engineState(e) {
		const core = this.core();
		const last = core.pref(e + ".lastTest") || "";
		if (core.ENGINES[e].kind === "key") {
			if (!core.hasSecret(e)) return "todo";
			return last === "fail" ? "fail" : last === "ok" ? "ok" : "saved";
		}
		if (last === "fail" || last === "ok") return last;
		return core.pref(e + ".enabled") ? "saved" : "todo";
	},

	/** Separador aberto (só mostra a configuração, não muda o motor em uso). */
	showEngine(e) {
		this._shown = e;
		this.setText("zia-test-result", "");
		const el = this.$("zia-test-result");
		if (el) el.className = "zia-test-result";
		this.refresh();
	},

	/** Motor usado pelo assistente. */
	useEngine(e) {
		this.core().setPref("engine", e);
		this.refresh();
	},

	refresh() {
		const core = this.core();
		const current = core.defaultEngine();
		const main = core.MAIN_ENGINES || core.ENGINE_ORDER;
		const shown = this._shown || current || main[0];
		this._shown = shown;
		const box = this.$("zia-engines");
		if (box) {
			while (box.firstChild) box.removeChild(box.firstChild);
			const addTab = e => {
				const st = this.engineState(e);
				const tab = this.html("div");
				tab.className = "zia-etab" + (e === shown ? " selected" : "") + (main.includes(e) ? "" : " minor");
				tab.setAttribute("role", "tab");
				tab.setAttribute("aria-selected", e === shown ? "true" : "false");
				tab.setAttribute("tabindex", "0");
				tab.dataset.engine = e;
				tab.title = this.T("prefs.badge." + st);
				const dot = this.html("span");
				dot.className = "zia-dot zia-dot-" + st;
				tab.append(dot, this.html("span", this.T("prefs.tab." + e)));
				if (e === current) {
					const inUse = this.html("span", "★");
					inUse.className = "zia-etab-star";
					inUse.title = this.T("prefs.inUse");
					tab.appendChild(inUse);
				}
				tab.addEventListener("click", () => this.showEngine(e));
				tab.addEventListener("keydown", ev => {
					if (ev.key === "Enter" || ev.key === " ") {
						ev.preventDefault();
						this.showEngine(e);
					}
				});
				box.appendChild(tab);
			};
			for (const e of main) addTab(e);
			// "Outros": as chaves de API pagas por uso, num só separador
			const rest = core.ENGINE_ORDER.filter(e => !main.includes(e));
			if (rest.length) {
				const inRest = rest.includes(shown);
				const states = rest.map(e => this.engineState(e));
				const st = states.includes("ok") ? "ok" : states.includes("saved") ? "saved" : states.includes("fail") ? "fail" : "todo";
				const tab = this.html("div");
				tab.className = "zia-etab" + (inRest ? " selected" : "");
				tab.setAttribute("role", "tab");
				tab.setAttribute("aria-selected", inRest ? "true" : "false");
				tab.setAttribute("tabindex", "0");
				tab.dataset.engine = "outros";
				const dot = this.html("span");
				dot.className = "zia-dot zia-dot-" + st;
				tab.append(dot, this.html("span", this.T("prefs.tab.others")));
				if (rest.includes(current)) {
					const star = this.html("span", "★");
					star.className = "zia-etab-star";
					tab.appendChild(star);
				}
				const openOthers = () => this.showEngine(inRest ? shown : (rest.find(e => e === current) || rest.find(e => this.engineState(e) !== "todo") || rest[0]));
				tab.addEventListener("click", openOthers);
				tab.addEventListener("keydown", ev => {
					if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openOthers(); }
				});
				box.appendChild(tab);
			}
		}
		// Dentro de "Outros": escolha entre Claude API e ChatGPT API
		const sw = this.$("zia-other-switch");
		if (sw) {
			while (sw.firstChild) sw.removeChild(sw.firstChild);
			const rest = core.ENGINE_ORDER.filter(e => !main.includes(e));
			sw.hidden = !rest.includes(shown);
			if (!sw.hidden) {
				sw.appendChild(this.html("span", this.T("prefs.others.intro")));
				for (const e of rest) {
					const b = this.html("button", this.T("prefs.tab." + e));
					b.className = "zia-seg" + (e === shown ? " selected" : "");
					b.dataset.engine = e;
					const dot = this.html("span");
					dot.className = "zia-dot zia-dot-" + this.engineState(e);
					b.insertBefore(dot, b.firstChild);
					b.addEventListener("click", () => this.showEngine(e));
					sw.appendChild(b);
				}
			}
		}
		// Resumo do separador aberto: para quem é, estado e botão para o usar
		const sum = this.$("zia-engine-summary");
		if (sum) {
			while (sum.firstChild) sum.removeChild(sum.firstChild);
			const st = this.engineState(shown);
			const text = this.html("div", this.T("prefs.engine." + shown + ".sub"));
			text.className = "zia-engine-sub";
			const badge = this.html("span", this.T("prefs.badge." + st));
			badge.className = "zia-badge zia-badge-" + st;
			const use = this.html("button", this.T(shown === current ? "prefs.inUse" : "prefs.useThis"));
			use.className = "zia-use-btn" + (shown === current ? " current" : "");
			use.disabled = shown === current;
			use.addEventListener("click", () => this.useEngine(shown));
			const row = this.html("div");
			row.className = "zia-engine-summary-row";
			row.append(badge, use);
			sum.append(text, row);
		}
		for (const panel of document.querySelectorAll(".zia-engine-panel")) {
			panel.hidden = panel.getAttribute("data-engine") !== shown;
		}
		const step2 = document.querySelector("[data-zia='prefs.step2']");
		if (step2) step2.textContent = this.T("prefs.step2", { engine: this.T("prefs.engine." + shown) });
		for (const name of ["anthropic", "openai", "gemini"]) {
			const st = core.secretState(name);
			const k = st === "encrypted" ? "prefs.st.keyEncrypted" : st === "login" ? "prefs.st.keyLogin" : st === "plain" ? "prefs.st.keyPlain" : null;
			this.setText(`zia-${name}-keystate`, k ? this.T("prefs.st.state", { s: this.T(k) }) : this.T("prefs.st.none"));
		}
	},

	// ------------------------------------------------------------------
	// Teste único: um pedido real e curto ao motor
	// ------------------------------------------------------------------

	async test(engine) {
		const core = this.core();
		const out = "zia-test-result";
		const el = this.$(out);
		if (el) el.className = "zia-test-result busy";
		this.setText(out, this.T("prefs.testing"));
		try {
			const r = await core.testEngine(engine, window, info => {
				if (info && info.notice) this.setText(out, this.T("prefs.testing") + "\n" + info.notice);
			});
			core.setPref(engine + ".lastTest", "ok");
			if (!core.defaultEngine()) core.setPref("engine", engine);
			if (el) el.className = "zia-test-result ok";
			this.setText(out, this.T("prefs.testOk", { engine: this.T("prefs.engine." + engine), model: r.model || "?" })
				+ (r.path ? "\n" + this.T("prefs.testProgram", { path: r.path, version: r.version || "?" }) : ""));
			if (engine === "anthropic" || engine === "openai") this.loadModels(engine);
		}
		catch (e) {
			core.setPref(engine + ".lastTest", "fail");
			if (core.ENGINES[engine].kind !== "key") core.setPref(engine + ".enabled", false);
			if (el) el.className = "zia-test-result fail";
			this.setText(out, this.T("prefs.testFail") + "\n" + (e.message || String(e)));
		}
		this.refresh();
	},

	// ------------------------------------------------------------------
	// Chaves
	// ------------------------------------------------------------------

	keyProblem(name, key) {
		if (/\s/.test(key) || key.length < 20 || key.length > 400) return "prefs.badKey";
		if (name === "anthropic" && !/^sk-ant-/.test(key)) return "prefs.badAnthropicKey";
		if (name === "openai" && !/^sk-/.test(key)) return "prefs.badOpenAIKey";
		return null;
	},

	async saveKey(name) {
		const core = this.core();
		const input = this.$(`zia-${name}-key`);
		const key = (input.value || "").trim();
		const state = `zia-${name}-keystate`;
		if (!key) {
			// Sem chave nova: testa a que já está guardada
			if (core.hasSecret(name)) return this.test(name);
			this.setText(state, this.T("prefs.pasteFirst"), true);
			return;
		}
		const problem = this.keyProblem(name, key);
		if (problem) {
			this.setText(state, this.T(problem), true);
			return;
		}
		try {
			await core.setSecret(name, key);
			input.value = "";
			core.setPref(name + ".lastTest", "");
			this.refresh();
			if (name === "gemini") await this.listGemini(true);
			await this.test(name);
		}
		catch (e) {
			this.setText(state, e.message || String(e), true);
		}
	},

	async clearKey(name) {
		const core = this.core();
		await core.setSecret(name, "");
		core.setPref(name + ".lastTest", "");
		this.refresh();
		this.setText("zia-test-result", this.T("prefs.keyDeleted"));
		this.$("zia-test-result").className = "zia-test-result";
	},

	async clearAll() {
		const core = this.core();
		try {
			await core.clearAllSecrets();
			for (const e of core.ENGINE_ORDER) if (core.ENGINES[e].kind === "key") core.setPref(e + ".lastTest", "");
			this.refresh();
			this.setText("zia-security-result", this.T("prefs.allDeleted"));
		}
		catch (e) {
			this.setText("zia-security-result", e.message || String(e), true);
		}
	},

	resetPrivacy() {
		const core = this.core();
		for (const e of core.ENGINE_ORDER) core.setPref("privacy.ack." + e, false);
		this.setText("zia-security-result", this.T("prefs.privacyReset"));
	},

	// ------------------------------------------------------------------
	// Modelos (Claude API e ChatGPT API)
	// ------------------------------------------------------------------

	_models(name) {
		const core = this.core();
		return name === "openai"
			? { list: core.OPENAI_MODELS, current: core.openaiModel(), pref: "openai.model", prefix: /^(gpt|o\d|chatgpt)/ }
			: { list: core.ANTHROPIC_MODELS, current: core.anthropicModel(), pref: "anthropic.model", prefix: /^claude-/ };
	},

	initModelSelect(name, extra) {
		const core = this.core();
		const sel = this.$(`zia-${name}-model`);
		if (!sel) return;
		const m = this._models(name);
		if (extra) this._extra = Object.assign(this._extra || {}, { [name]: extra });
		const models = m.list.map(x => ({ id: x.id, label: x.tier ? `${x.label} (${this.T("prefs.tier." + x.tier)})` : x.label }));
		for (const x of (this._extra && this._extra[name]) || []) {
			if (!models.some(y => y.id === x.id) && m.prefix.test(x.id)) models.push({ id: x.id, label: x.id });
		}
		if (!models.some(x => x.id === m.current)) models.push({ id: m.current, label: m.current });
		this.fillSelect(sel, models.map(x => [x.id, x.label]), m.current);
		if (!sel._ziaBound) {
			sel._ziaBound = true;
			sel.addEventListener("change", () => core.setPref(this._models(name).pref, sel.value));
		}
	},

	/** Acrescenta à lista os modelos que a conta tem (em segundo plano, sem mensagens). */
	async loadModels(name) {
		const core = this.core();
		try {
			const models = name === "openai" ? await core.listOpenAIModels(window) : await core.listAnthropicModels(window);
			this.initModelSelect(name, models);
		}
		catch (e) { core.log("Lista de modelos: " + e); }
	},

	// ------------------------------------------------------------------
	// Programas locais: Claude Code e Codex
	// ------------------------------------------------------------------

	async detect(tool) {
		const core = this.core();
		const old = core.pref(tool + ".path");
		core.setPref(tool + ".path", "");
		core._toolCache[tool] = null;
		const el = this.$("zia-test-result");
		try {
			const p = await core.findToolExecutable(tool);
			if (el) el.className = "zia-test-result";
			this.setText("zia-test-result", this.T("prefs.found", { p }));
		}
		catch (e) {
			core.setPref(tool + ".path", old || "");
			if (el) el.className = "zia-test-result fail";
			this.setText("zia-test-result", e.message);
		}
		this.refresh();
	},

	/** Janela visível que instala o Claude Code (se faltar) e abre o início de sessão. */
	async installClaude() {
		const core = this.core();
		const el = this.$("zia-test-result");
		const msg = this.T("prefs.claude.installConfirm");
		const ok = (typeof Services !== "undefined" && Services.prompt)
			? Services.prompt.confirm(window, this.T("prefs.claude.install"), msg)
			: window.confirm(msg);
		if (!ok) return;
		try {
			const r = await core.openClaudeSetup();
			if (el) el.className = r.opened ? "zia-test-result busy" : "zia-test-result fail";
			this.setText("zia-test-result", this.T(r.opened ? "prefs.claude.opened" : "prefs.claude.unsupported"));
			if (!r.opened) {
				const adv = document.querySelector(".zia-engine-panel[data-engine='claude'] .zia-advanced");
				if (adv) adv.open = true;
			}
		}
		catch (e) {
			if (el) el.className = "zia-test-result fail";
			this.setText("zia-test-result", e.message || String(e));
		}
		this.refresh();
	},

	async checkUpdates() {
		const out = "zia-update-result";
		this.setText(out, this.T("prefs.update.checking"));
		try {
			const r = await this.core().checkForUpdates();
			this.setText(out, this.T("prefs.update." + r.status, { v: r.version || "" }), r.status === "failed" || r.status === "error");
		}
		catch (e) {
			this.setText(out, this.T("prefs.update.error") + "\n" + (e.message || String(e)), true);
		}
	},

	copyClaudeCommand() {
		const core = this.core();
		try {
			Zotero.Utilities.Internal.copyTextToClipboard(core.claudeInstallCommand());
			this.setText("zia-test-result", this.T("prefs.copied"));
			this.$("zia-test-result").className = "zia-test-result";
		}
		catch (e) { core.log("Copiar: " + e); }
	},

	// ------------------------------------------------------------------
	// Gemini: lista de modelos da conta
	// ------------------------------------------------------------------

	/** Claude Code: nomes curtos que o Claude Code resolve sempre para a versão mais recente. */
	initClaudeModel() {
		const core = this.core();
		const sel = this.$("zia-claude-model");
		if (!sel) return;
		const cur = core.pref("claude.model") || "sonnet";
		const items = [["sonnet", this.T("prefs.claude.sonnet")], ["opus", this.T("prefs.claude.opus")], ["haiku", this.T("prefs.claude.haiku")]];
		if (!items.some(i => i[0] === cur)) items.push([cur, cur]);
		this.fillSelect(sel, items, cur);
		if (!sel._ziaBound) {
			sel._ziaBound = true;
			sel.addEventListener("change", () => core.setPref("claude.model", sel.value));
		}
	},

	/** Lista de modelos Gemini agrupada: gratuitos, pré-visualização e normalmente pagos. */
	fillGeminiSelect(models) {
		const core = this.core();
		const sel = this.$("zia-gemini-model");
		if (!sel) return;
		const cur = core.geminiModel();
		while (sel.firstChild) sel.removeChild(sel.firstChild);
		const { groups, recommended } = core.lib.sortGeminiModels(models || [cur]);
		const label = i => {
			const tags = [];
			if (i.name === recommended) tags.push(this.T("prefs.gm.recommended"));
			tags.push(this.T(i.preview ? "prefs.gm.preview" : "prefs.gm." + i.tier));
			return `${i.name}  (${tags.join(", ")})`;
		};
		for (const g of ["free", "preview", "paid"]) {
			if (!groups[g].length) continue;
			const og = this.html("optgroup");
			og.setAttribute("label", this.T("prefs.gm.group." + g));
			for (const i of groups[g]) {
				const o = this.html("option", models ? label(i) : i.name);
				o.value = i.name;
				og.appendChild(o);
			}
			sel.appendChild(og);
		}
		const names = [].concat(groups.free, groups.preview, groups.paid).map(i => i.name);
		if (!names.includes(cur)) {
			const o = this.html("option", cur);
			o.value = cur;
			sel.insertBefore(o, sel.firstChild);
		}
		sel.value = cur;
		this.fillGeminiStrong(models);
		return { names, recommended };
	},

	/** Modelo para análises exigentes: automático, desligado ou um flash/pro da conta. */
	fillGeminiStrong(models) {
		const core = this.core();
		const sel = this.$("zia-gemini-strong");
		if (!sel) return;
		const cur = String(core.pref("gemini.modelStrong") || "auto");
		const main = core.geminiModel();
		const auto = core.lib.geminiStrongCandidates(main, models || [], "auto");
		const items = [
			["auto", this.T("prefs.gemini.strongAuto", { m: auto.length ? auto.join(", ") : "…" })],
			["off", this.T("prefs.gemini.strongOff")],
		];
		const { groups } = core.lib.sortGeminiModels(models || []);
		for (const i of [].concat(groups.free, groups.preview, groups.paid)) {
			if (i.name !== main && i.tier !== "lite") items.push([i.name, i.name]);
		}
		if (!items.some(x => x[0] === cur)) items.push([cur, cur]);
		this.fillSelect(sel, items, cur);
		if (!sel._ziaBound) {
			sel._ziaBound = true;
			sel.addEventListener("change", () => core.setPref("gemini.modelStrong", sel.value));
		}
	},

	/** Testa ao mesmo tempo os modelos flash da conta e mostra quais respondem agora. */
	async probeGemini() {
		const core = this.core();
		const box = this.$("zia-gemini-probe-result");
		const btn = this.$("zia-gemini-probe");
		if (!box) return;
		while (box.firstChild) box.removeChild(box.firstChild);
		box.appendChild(this.html("div", this.T("prefs.gemini.probing")));
		if (btn) btn.disabled = true;
		try {
			let models = [];
			try { models = await core.geminiModels(window); }
			catch (e) { models = []; }
			const main = core.geminiModel();
			const strong = String(core.pref("gemini.modelStrong") || "auto");
			const { groups } = core.lib.sortGeminiModels(models);
			const list = [main];
			if (strong !== "auto" && strong !== "off") list.push(strong);
			for (const i of groups.free) if (list.length < 6 && !list.includes(i.name)) list.push(i.name);
			const results = await core.probeGeminiModels(window, list);
			while (box.firstChild) box.removeChild(box.firstChild);
			for (const r of results) {
				const row = this.html("div");
				row.className = "zia-probe-row zia-probe-" + r.state;
				const name = this.html("span", r.model);
				name.className = "zia-probe-name";
				const st = this.html("span", this.T("prefs.gemini.probe." + r.state, { s: (r.ms / 1000).toFixed(1) }));
				st.className = "zia-probe-state";
				row.append(name, st);
				if (r.state === "ok") {
					const tags = [];
					if (r.model === strong) tags.push(this.T("prefs.gemini.isStrong"));
					if (r.model === main) tags.push(this.T("prefs.gemini.isMain"));
					else if (r.model !== strong) {
						const b = this.html("button", this.T("prefs.gemini.useMain"));
						b.className = "zia-probe-btn";
						b.addEventListener("click", () => { core.setPref("gemini.model", r.model); this.fillGeminiSelect(models); this.probeMark(); });
						row.appendChild(b);
						if (core.lib.geminiModelInfo(r.model).tier !== "lite") {
							const b2 = this.html("button", this.T("prefs.gemini.useStrong"));
							b2.className = "zia-probe-btn";
							b2.addEventListener("click", () => { core.setPref("gemini.modelStrong", r.model); this.fillGeminiStrong(models); this.probeMark(); });
							row.appendChild(b2);
						}
					}
					for (const t of tags) {
						const s2 = this.html("span", t);
						s2.className = "zia-probe-tag";
						row.appendChild(s2);
					}
				}
				box.appendChild(row);
			}
			box.appendChild(this.html("div", this.T("prefs.gemini.probeDone")));
		}
		catch (e) {
			while (box.firstChild) box.removeChild(box.firstChild);
			box.appendChild(this.html("div", e.message || String(e)));
		}
		finally {
			if (btn) btn.disabled = false;
		}
	},

	probeMark() {
		this.setText("zia-gemini-models", this.T("prefs.saved"));
	},

	async listGemini(quiet) {
		const core = this.core();
		if (!quiet) this.setText("zia-gemini-models", this.T("prefs.loadingModels"));
		try {
			const models = await core.listGeminiModels(window);
			if (!models.length) {
				this.setText("zia-gemini-models", this.T("prefs.geminiNoModels"));
				return;
			}
			const { names, recommended } = this.fillGeminiSelect(models);
			// O modelo guardado já não existe na conta: passa para o recomendado
			if (!names.includes(core.geminiModel()) && recommended) {
				core.setPref("gemini.model", recommended);
				this.fillGeminiSelect(models);
				this.setText("zia-gemini-models", this.T("prefs.geminiSwitched", { m: recommended }));
				return;
			}
			this.setText("zia-gemini-models", this.T("prefs.geminiCount", { n: models.length }));
		}
		catch (e) {
			if (!quiet) this.setText("zia-gemini-models", e.message || String(e), true);
		}
	},

	// ------------------------------------------------------------------
	// Prompts do utilizador
	// ------------------------------------------------------------------

	showPromptCount() {
		const ta = this.$("zia-custom-prompts");
		if (!ta) return;
		const n = this.core().lib.parseCustomPrompts(ta.value).length;
		this.setText("zia-custom-state", n ? this.T("prefs.prompts.count", { n }) : this.T("prefs.prompts.none"));
	},

	initCustomPrompts() {
		const core = this.core();
		const ta = this.$("zia-custom-prompts");
		if (!ta) return;
		ta.value = core.pref("custom.prompts") || "";
		const save = () => {
			core.setPref("custom.prompts", ta.value.slice(0, 20000));
			this.showPromptCount();
		};
		let timer = null;
		ta.addEventListener("input", () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(save, 400);
		});
		ta.addEventListener("change", save);
	},
};

// O painel é inserido depois de este script ser carregado: espera por ele
(function waitForPane(tries) {
	if (document.getElementById("zoteroia-prefs-root")) {
		window.ZIAPrefs.init();
		return;
	}
	if (tries < 150) setTimeout(() => waitForPane(tries + 1), 100);
})(0);
