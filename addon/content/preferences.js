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
		for (const tool of ["claude", "codex"]) {
			on(`zia-${tool}-detect`, () => this.detect(tool));
			on(`zia-${tool}-test`, () => this.test(tool));
		}
		on("zia-claude-install", () => this.installClaude());
		on("zia-claude-copy", () => this.copyClaudeCommand());
		on("zia-clear-all", () => this.clearAll());
		on("zia-reset-privacy", () => this.resetPrivacy());
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

	selectEngine(e) {
		this.core().setPref("engine", e);
		this.setText("zia-test-result", "");
		this.refresh();
	},

	refresh() {
		const core = this.core();
		const current = core.defaultEngine();
		const box = this.$("zia-engines");
		if (box) {
			while (box.firstChild) box.removeChild(box.firstChild);
			for (const e of core.ENGINE_ORDER) {
				const st = this.engineState(e);
				const card = this.html("div");
				card.className = "zia-engine-card" + (e === current ? " selected" : "");
				card.setAttribute("role", "radio");
				card.setAttribute("aria-checked", e === current ? "true" : "false");
				card.setAttribute("tabindex", "0");
				const radio = this.html("span");
				radio.className = "zia-engine-radio";
				const text = this.html("span");
				text.className = "zia-engine-text";
				const name = this.html("span", this.T("prefs.engine." + e));
				name.className = "zia-engine-name";
				const sub = this.html("span", this.T("prefs.engine." + e + ".sub"));
				sub.className = "zia-engine-sub";
				text.append(name, sub);
				const badge = this.html("span", this.T("prefs.badge." + st));
				badge.className = "zia-badge zia-badge-" + st;
				card.append(radio, text, badge);
				card.addEventListener("click", () => this.selectEngine(e));
				card.addEventListener("keydown", ev => {
					if (ev.key === "Enter" || ev.key === " ") {
						ev.preventDefault();
						this.selectEngine(e);
					}
				});
				box.appendChild(card);
			}
		}
		for (const panel of document.querySelectorAll(".zia-engine-panel")) {
			panel.hidden = panel.getAttribute("data-engine") !== current;
		}
		const step2 = document.querySelector("[data-zia='prefs.step2']");
		if (step2) step2.textContent = current ? this.T("prefs.step2", { engine: this.T("prefs.engine." + current) }) : this.T("prefs.step2.none");
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
			const r = await core.testEngine(engine, window);
			core.setPref(engine + ".lastTest", "ok");
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

	async listGemini() {
		const box = this.$("zia-gemini-models");
		this.setText("zia-gemini-models", this.T("prefs.loadingModels"));
		try {
			const models = await this.core().listGeminiModels(window);
			box.textContent = "";
			if (!models.length) {
				this.setText("zia-gemini-models", this.T("prefs.geminiNoModels"));
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
			this.setText("zia-gemini-models", e.message || String(e), true);
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
