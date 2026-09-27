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
	registerMenus(id, rootURI);

	for (const win of Zotero.getMainWindows()) {
		if (win.ZoteroPane) onMainWindowLoad({ window: win });
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
				type: "zoteroia-open-window",
				icon: rootURI + "content/icons/window16.svg",
				l10nID: "zoteroia-section-open-window",
				onClick: ({ item }) => {
					ZoteroIA.openWindow({ items: item ? [item] : [], collectionIDs: ZoteroIA.selectedCollectionIDs() });
				},
			},
		],
		onItemChange: ({ item, setEnabled }) => {
			const ok = !!item && (item.isRegularItem() || (item.isAttachment() && item.isPDFAttachment()));
			setEnabled(ok);
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

function registerMenus(pluginID, rootURI) {
	if (!Zotero.MenuManager) return;
	const openWith = (items, autoAction) => {
		ZoteroIA.openWindow({ items, collectionIDs: ZoteroIA.selectedCollectionIDs(), autoAction });
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
					menus: [
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-open",
							onCommand: (ev, ctx) => openWith(ctx.items, null),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-compare",
							onShowing: (ev, ctx) => ctx.setEnabled(pdfCount(ctx.items) >= 2),
							onCommand: (ev, ctx) => openWith(ctx.items, "comparar"),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-gaps",
							onCommand: (ev, ctx) => openWith(ctx.items, "lacunas"),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-review",
							onCommand: (ev, ctx) => openWith(ctx.items, "revisao"),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-summary",
							onCommand: (ev, ctx) => openWith(ctx.items, "resumo"),
						},
						{
							menuType: "menuitem",
							l10nID: "zoteroia-menu-critique",
							onCommand: (ev, ctx) => openWith(ctx.items, "critica"),
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
		link.href = ZoteroIA.rootURI + "content/zoteroia.css";
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
