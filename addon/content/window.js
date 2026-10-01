/*
 * Assistente IA para Zotero: janela para vários PDFs (comparação, lacunas).
 */

/* global Zotero, window, document */

var ZIAWindow = {
	view: null,

	async init() {
		const core = Zotero.ZoteroIA;
		if (!core) {
			document.getElementById("zia-host").textContent = "O plugin Assistente IA não está ativo.";
			return;
		}
		document.title = core.t("app.name");
		// A mesma folha de estilos do painel lateral, sempre a versão instalada
		const css = document.createElementNS("http://www.w3.org/1999/xhtml", "link");
		css.rel = "stylesheet";
		css.href = core.rootURI + "content/zoteroia.css?v=" + encodeURIComponent(core.version || "");
		document.documentElement.appendChild(css);
		const host = document.getElementById("zia-host");
		this.view = new core.ChatView({ doc: document, win: window, container: host, mode: "window", core });
		const args = window.arguments && window.arguments[0];
		await this.receive(args && (args.wrappedJSObject || args));
	},

	/** Recebe itens (ao abrir ou quando a janela já existe). */
	async receive(args) {
		if (!this.view || !args) return;
		await this.view.setItems(args.items || [], { collectionIDs: args.collectionIDs || [] });
		if (args.autoAction) {
			const a = Zotero.ZoteroIA.lib.ACTIONS[args.autoAction];
			if (a && this.view.state.docs.length >= a.minDocs) {
				await this.view.runAction(args.autoAction);
			}
		}
	},
};

window.addEventListener("load", () => {
	ZIAWindow.init().catch(e => Zotero.logError(e));
}, { once: true });

window.addEventListener("unload", () => {
	if (ZIAWindow.view) ZIAWindow.view.destroy();
});
