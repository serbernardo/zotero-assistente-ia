/*
 * Assistente IA para Zotero: painel de definições.
 */

/* global Zotero, window, document, setTimeout, clearTimeout */

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
		for (const name of ["anthropic", "openai"]) {
			on(`zia-${name}-save`, () => this.saveKey(name));
			on(`zia-${name}-clear`, () => this.clearKey(name));
			on(`zia-${name}-test`, () => this.testKeyModels(name));
		}
		on("zia-gemini-save", () => this.saveKey("gemini"));
		on("zia-gemini-clear", () => this.clearKey("gemini"));
		on("zia-gemini-list", () => this.listGemini());
		for (const tool of ["claude", "codex"]) {
			on(`zia-${tool}-detect`, () => this.detect(tool));
			on(`zia-${tool}-test`, () => this.testLocal(tool));
		}
		on("zia-clear-all", () => this.clearAll());
		on("zia-reset-privacy", () => this.resetPrivacy());
		// Enter no campo da chave guarda
		for (const name of ["anthropic", "openai", "gemini"]) {
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
		this.initUILanguage();
		this.initDefaultEngine();
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
		const ta = this.$("zia-custom-prompts");
		if (ta) ta.setAttribute("placeholder", this.T("prefs.prompts.placeholder"));
		this.fillDefaultEngine();
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
	// Línguas e motor por omissão
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

	initDefaultEngine() {
		const sel = this.$("zia-default-engine");
		if (!sel) return;
		sel.addEventListener("change", () => this.core().setPref("engine", sel.value));
	},

	fillDefaultEngine() {
		const core = this.core();
		const sel = this.$("zia-default-engine");
		if (!sel) return;
		const items = [["", this.T("prefs.defaultEngine.none")]]
			.concat(core.ENGINE_ORDER.map(e => [e, this.T("prefs.engine." + e)]));
		this.fillSelect(sel, items, core.defaultEngine());
	},

	setDefaultIfNone(engine) {
		const core = this.core();
		if (!core.defaultEngine()) {
			core.setPref("engine", engine);
			this.fillDefaultEngine();
		}
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

	/** Estado de cada motor, no topo do painel. */
	refresh() {
		const core = this.core();
		const keyText = name => {
			const st = core.secretState(name);
			if (st === "encrypted") return this.T("prefs.st.keyEncrypted");
			if (st === "login") return this.T("prefs.st.keyLogin");
			if (st === "plain") return this.T("prefs.st.keyPlain");
			return null;
		};
		const set = (id, ok, text) => {
			const el = this.$(id);
			if (!el) return;
			el.textContent = (ok ? "✓ " : "○ ") + text;
			el.className = "zia-prefs-status " + (ok ? "ok" : "");
		};
		for (const e of core.ENGINE_ORDER) {
			const label = this.T("prefs.engine." + e) + ": ";
			if (core.ENGINES[e].kind === "key") {
				const k = keyText(e);
				set("zia-status-" + e, !!k, label + (k || this.T("prefs.st.noKey")));
				this.setText(`zia-${e}-keystate`, k ? this.T("prefs.st.state", { s: k }) : this.T("prefs.st.none"));
			}
			else {
				const ok = !!core.pref(e + ".enabled");
				const selected = !ok && core.pref("engine") === e;
				const key = ok ? "prefs.st.active" : (selected ? "prefs.st.selected" : "prefs.st.inactive");
				set("zia-status-" + e, ok, label + this.T(key));
			}
		}
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

	resultID(name) {
		return `zia-${name}-result`;
	},

	async saveKey(name) {
		const input = this.$(`zia-${name}-key`);
		const key = (input.value || "").trim();
		const state = `zia-${name}-keystate`;
		if (!key) {
			this.setText(state, this.T("prefs.pasteFirst"), true);
			return;
		}
		const problem = this.keyProblem(name, key);
		if (problem) {
			this.setText(state, this.T(problem), true);
			return;
		}
		try {
			await this.core().setSecret(name, key);
			input.value = "";
			this.setDefaultIfNone(name);
			this.refresh();
			if (name === "gemini") await this.listGemini();
			else await this.testKeyModels(name);
		}
		catch (e) {
			this.setText(state, e.message || String(e), true);
		}
	},

	async clearKey(name) {
		await this.core().setSecret(name, "");
		this.refresh();
		this.setText(this.resultID(name), this.T("prefs.keyDeleted"));
	},

	async clearAll() {
		try {
			await this.core().clearAllSecrets();
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

	async testKeyModels(name) {
		const core = this.core();
		const out = this.resultID(name);
		this.setText(out, this.T("prefs.testingKey"));
		try {
			const models = name === "openai" ? await core.listOpenAIModels(window) : await core.listAnthropicModels(window);
			this.initModelSelect(name, models);
			const cur = this._models(name).current;
			const has = models.some(m => m.id === cur);
			this.setText(out, this.T("prefs.keyValid", { n: models.length })
				+ (has || !models.length ? "" : "\n" + this.T("prefs.modelMissing", { m: cur })));
		}
		catch (e) {
			this.setText(out, e.message || String(e), true);
		}
		this.refresh();
	},

	// ------------------------------------------------------------------
	// Programas locais: Claude Code e Codex
	// ------------------------------------------------------------------

	async detect(tool) {
		const core = this.core();
		const old = core.pref(tool + ".path");
		core.setPref(tool + ".path", "");
		core._toolCache[tool] = null;
		try {
			const p = await core.findToolExecutable(tool);
			this.setText(this.resultID(tool), this.T("prefs.found", { p }));
		}
		catch (e) {
			core.setPref(tool + ".path", old || "");
			this.setText(this.resultID(tool), e.message, true);
		}
	},

	async testLocal(tool) {
		const core = this.core();
		const out = this.resultID(tool);
		this.setText(out, this.T("prefs.testing"));
		try {
			const r = tool === "codex" ? await core.testCodex() : await core.testClaude();
			this.setDefaultIfNone(tool);
			this.setText(out, this.T("prefs.testOk", { path: r.path, version: r.version, model: r.model || "?", reply: r.reply }));
		}
		catch (e) {
			this.setText(out, e.message || String(e), true);
		}
		this.refresh();
	},

	// ------------------------------------------------------------------
	// Gemini
	// ------------------------------------------------------------------

	async listGemini() {
		const box = this.$("zia-gemini-result");
		this.setText("zia-gemini-result", this.T("prefs.testingKey"));
		try {
			const models = await this.core().listGeminiModels(window);
			box.textContent = "";
			if (!models.length) {
				this.setText("zia-gemini-result", this.T("prefs.geminiNoModels"));
				return;
			}
			box.appendChild(this.html("div", this.T("prefs.geminiPick")));
			for (const m of models) {
				const a = this.html("a", m);
				a.href = "#";
				a.style.marginRight = "10px";
				a.addEventListener("click", ev => {
					ev.preventDefault();
					this.$("zia-pref-gemini-model").value = m;
					this.core().setPref("gemini.model", m);
				});
				box.appendChild(a);
				box.appendChild(document.createTextNode(" "));
			}
		}
		catch (e) {
			this.setText("zia-gemini-result", e.message || String(e), true);
		}
		this.refresh();
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
