/*
 * Assistente IA para Zotero: arranque do plugin (Zotero 8 ou superior).
 */

/* global Zotero, Services, Components */

var ZoteroIA;
var chromeHandle;
var sectionID;
var menuIDs = [];
var prefsPaneID;

function log(msg) {
	Zotero.debug("Assistente IA: " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
	log("A iniciar " + version);

	// Regista chrome://zoteroia/ para a janela do assistente
	const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	const manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "zoteroia", "content/"],
	]);

	Services.scriptloader.loadSubScript(rootURI + "content/i18n.js");
	Services.scriptloader.loadSubScript(rootURI + "content/lib.js");
	Services.scriptloader.loadSubScript(rootURI + "content/chatview.js");
	Services.scriptloader.loadSubScript(rootURI + "content/zoteroia.js");
	ZoteroIA.init({ id, version, rootURI });
	// Acessível às janelas e às preferências
	Zotero.ZoteroIA = ZoteroIA;

	try {
		prefsPaneID = await Zotero.PreferencePanes.register({
			pluginID: id,
			id: ZoteroIA.PREFS_PANE_ID,
			src: rootURI + "content/preferences.xhtml",
			scripts: [rootURI + "content/preferences.js"],
			stylesheets: [rootURI + "content/zoteroia.css"],
			label: ZoteroIA.t("app.name"),
			image: rootURI + "content/icons/sparkle20.svg",
		});
	}
	catch (e) {
		Zotero.logError(e);
	}

	registerSection(id, rootURI);
	placeAfterInfo(sectionID);
	registerMenus(id, rootURI);

	for (const win of Zotero.getMainWindows()) {
		if (win.ZoteroPane) onMainWindowLoad({ window: win });
	}
}

// Ícone do assistente logo a seguir à Info na barra lateral do item. Só uma vez: se a pessoa
// mudar a ordem (botão direito no ícone), essa escolha fica.
const BUILT_IN_PANES = ["info", "abstract", "attachments", "notes", "note-info", "attachment-info", "attachment-annotations", "libraries-collections", "tags", "related"];
function placeAfterInfo(paneID) {
	try {
		if (!paneID || ZoteroIA.pref("sidenav.placed")) return;
		const cur = Zotero.Prefs.get("sidenav.order");
		let order = cur ? String(cur).split(",") : BUILT_IN_PANES.slice();
		order = order.filter(p => p && p !== paneID);
		const i = order.indexOf("info");
		order.splice(i + 1, 0, paneID);
		Zotero.Prefs.set("sidenav.order", order.join(","));
		ZoteroIA.setPref("sidenav.placed", true);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function registerSection(pluginID, rootURI) {
	const views = new WeakMap();
	sectionID = Zotero.ItemPaneManager.registerSection({
		paneID: "zoteroia-section",
		pluginID,
		header: {
			l10nID: "zoteroia-section-header",
			icon: rootURI + "content/icons/sparkle16.svg",
		},
		sidenav: {
			l10nID: "zoteroia-section-sidenav",
			icon: rootURI + "content/icons/sparkle20.svg",
		},
		sectionButtons: [
			{
				// Língua da app: mostra PT ou EN e troca com um clique
				type: "zoteroia-lang",
				icon: rootURI + "content/icons/lang-pt16.svg",
				l10nID: "zoteroia-section-lang",
				onClick: ({ body }) => {
					ZoteroIA.toggleLanguage();
					showLang(body, rootURI);
				},
			},
			{
				type: "zoteroia-open-window",
				icon: rootURI + "content/icons/window16.svg",
				l10nID: "zoteroia-section-open-window",
				onClick: ({ item }) => {
					ZoteroIA.openWindow({ items: item ? [item] : [], collectionIDs: ZoteroIA.selectedCollectionIDs() });
				},
			},
		],
		onItemChange: ({ body, item, setEnabled }) => {
			// O Zotero "fixa" a secção cujo ícone se carregou e depois abre sempre nela.
			// O assistente nunca fica fixado: cada registo abre na Info, como no Zotero normal.
			try {
				const details = body && body.closest && body.closest("item-details");
				if (details && sectionID && details.pinnedPane === sectionID) details.pinnedPane = "";
			}
			catch (e) { /* versão do Zotero sem fixar secções */ }
			// Sempre visível (também em registos sem PDF): o painel explica o que fazer
			setEnabled(!!item);
			return true;
		},
		onRender: ({ body, doc, item }) => {
			let view = views.get(body);
			if (!view) {
				view = new ZoteroIA.ChatView({
					doc,
					win: doc.defaultView,
					container: body,
					mode: "section",
					core: ZoteroIA,
				});
				views.set(body, view);
			}
			view.showItem(item).catch(e => Zotero.logError(e));
			showLang(body, rootURI);
		},
		onDestroy: ({ body }) => {
			const view = views.get(body);
			if (view) {
				view.destroy();
				views.delete(body);
			}
		},
	});
}

/** O botão da língua mostra PT ou EN, conforme a língua atual da app. */
function showLang(body, rootURI) {
	try {
		const section = body && body.closest && body.closest("collapsible-section");
		const btn = section && section.querySelector(".zoteroia-lang");
		if (!btn) return;
		const icon = `url('${rootURI}content/icons/lang-${ZoteroIA.lib.I18N.getLang() === "en" ? "en" : "pt"}16.svg')`;
		btn.style.setProperty("--custom-button-icon-light", icon);
		btn.style.setProperty("--custom-button-icon-dark", icon);
	}
	catch (e) { Zotero.logError(e); }
}

function registerMenus(pluginID, rootURI) {
	if (!Zotero.MenuManager) return;
	// Botão direito numa coleção: analisar todos os PDFs dela na janela grande
	try {
		menuIDs.push(Zotero.MenuManager.registerMenu({
			menuID: "zoteroia-collection-menu",
			pluginID,
			target: "main/library/collection",
			menus: [{
				menuType: "menuitem",
				l10nID: "zoteroia-menu-collection",
				icon: rootURI + "content/icons/sparkle16.svg",
				onShowing: (ev, ctx) => {
					const rows = ctx.collectionTreeRows || [];
					ctx.setVisible(rows.length === 1 && rows[0].isCollection && rows[0].isCollection());
				},
				onCommand: (ev, ctx) => {
					const row = (ctx.collectionTreeRows || [])[0];
					const col = row && row.ref;
					if (!col) return;
					const r = ZoteroIA.collectionItems(col.id);
					ZoteroIA.openWindow({ items: r.items, collectionIDs: [col.id], collectionName: r.name });
				},
			}],
		}));
	}
	catch (e) {
		Zotero.logError(e);
	}
	const openWith = (items, autoAction) => {
		const group = autoAction && ZoteroIA.lib.ACTIONS[autoAction] ? ZoteroIA.lib.ACTIONS[autoAction].group : null;
		ZoteroIA.openWindow({ items, collectionIDs: ZoteroIA.selectedCollectionIDs(), autoAction, group });
	};
	const pdfCount = items => (items || []).filter(i => i.isRegularItem() || (i.isAttachment() && i.isPDFAttachment())).length;
	try {
		menuIDs.push(Zotero.MenuManager.registerMenu({
			menuID: "zoteroia-item-menu",
			pluginID,
			target: "main/library/item",
			menus: [
				// Sem separador: o Zotero agrupa os menus dos plugins automaticamente
				{
					menuType: "submenu",
					l10nID: "zoteroia-menu-root",
					icon: rootURI + "content/icons/sparkle16.svg",
					// Só as funcionalidades de comparação (precisam de 2 ou mais PDFs selecionados)
					menus: [
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-compare",
							onShowing: (ev, ctx) => ctx.setEnabled(pdfCount(ctx.items) >= 2),
							onCommand: (ev, ctx) => openWith(ctx.items, "comparar"),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-cmp-methods",
							onShowing: (ev, ctx) => ctx.setEnabled(pdfCount(ctx.items) >= 2),
							onCommand: (ev, ctx) => openWith(ctx.items, "cmp_metodos"),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-cmp-results",
							onShowing: (ev, ctx) => ctx.setEnabled(pdfCount(ctx.items) >= 2),
							onCommand: (ev, ctx) => openWith(ctx.items, "cmp_resultados"),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-cmp-concepts",
							onShowing: (ev, ctx) => ctx.setEnabled(pdfCount(ctx.items) >= 2),
							onCommand: (ev, ctx) => openWith(ctx.items, "cmp_conceitos"),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-cmp-synthesis",
							onShowing: (ev, ctx) => ctx.setEnabled(pdfCount(ctx.items) >= 2),
							onCommand: (ev, ctx) => openWith(ctx.items, "cmp_sintese"),
						},
					],
				},
			],
		}));
		menuIDs.push(Zotero.MenuManager.registerMenu({
			menuID: "zoteroia-tools-menu",
			pluginID,
			target: "main/menubar/tools",
			menus: [
				{
					menuType: "menuitem",
					l10nID: "zoteroia-menu-tools",
					onCommand: () => openWith(ZoteroIA.selectedItems(), null),
				},
			],
		}));
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function onMainWindowLoad({ window }) {
	const doc = window.document;
	window.MozXULElement.insertFTLIfNeeded("zoteroia.ftl");
	if (!doc.getElementById("zoteroia-stylesheet")) {
		const link = doc.createElement("link");
		link.id = "zoteroia-stylesheet";
		link.type = "text/css";
		link.rel = "stylesheet";
		link.href = ZoteroIA.rootURI + "content/zoteroia.css?v=" + encodeURIComponent(ZoteroIA.version || "");
		doc.documentElement.appendChild(link);
	}
}

function onMainWindowUnload({ window }) {
	const doc = window.document;
	doc.getElementById("zoteroia-stylesheet")?.remove();
	doc.querySelector('[href="zoteroia.ftl"]')?.remove();
}

function shutdown({ id }, reason) {
	log("A terminar");
	try {
		ZoteroIA && ZoteroIA.closeAllWindows();
	}
	catch (e) { /* ignora */ }
	if (sectionID) {
		try { Zotero.ItemPaneManager.unregisterSection(sectionID); }
		catch (e) { /* ignora */ }
		sectionID = null;
	}
	if (Zotero.MenuManager) {
		for (const m of menuIDs) {
			try { Zotero.MenuManager.unregisterMenu(m); }
			catch (e) { /* ignora */ }
		}
	}
	menuIDs = [];
	for (const win of Zotero.getMainWindows()) {
		if (win.ZoteroPane) onMainWindowUnload({ window: win });
	}
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
	delete Zotero.ZoteroIA;
	ZoteroIA = undefined;
}

function uninstall() {}
