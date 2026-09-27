// Corre o bootstrap.js do plugin contra o código de validação REAL do Zotero
// (PluginAPIBase, ItemPaneManager, MenuManager), com o resto do Zotero simulado.
import fs from "fs";
import path from "path";
import vm from "vm";
import assert from "assert/strict";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADDON = path.resolve(here, "../../addon");
// Clone esparso do repositório oficial (ver GUIA de testes):
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/zotero/zotero.git zsrc
//   cd zsrc && git sparse-checkout set chrome/content/zotero/xpcom/pluginAPI
// Indica a pasta do clone com ZOTERO_SRC=<caminho>/zsrc
if (!process.env.ZOTERO_SRC) {
	console.error("Define ZOTERO_SRC com a pasta do clone do Zotero.");
	process.exit(2);
}
const ZSRC = path.join(process.env.ZOTERO_SRC, "chrome/content/zotero/xpcom/pluginAPI");

const warnings = [];
const Zotero = {
	isMac: false, isWin: true, isLinux: false,
	debug: m => { if (!String(m).startsWith("Assistente IA:")) warnings.push("debug: " + String(m)); },
	warn: m => warnings.push(String(m)),
	logError: e => warnings.push("logError: " + (e && e.stack || e)),
	Utilities: { randomString: () => Math.random().toString(36).slice(2) },
	Plugins: { addObserver: () => {} },
	Notifier: { queue: () => {}, trigger: () => {} },
	DB: { executeTransaction: async f => f() },
	getMainWindows: () => [],
	Prefs: { get: () => undefined, set: () => {} },
};

// PluginAPIBase real, com o getter do Zotero substituído
let base = fs.readFileSync(path.join(ZSRC, "pluginAPIBase.mjs"), "utf8");
base = base.replace(/ChromeUtils\.defineESModuleGetters\(lazy, \{[\s\S]*?\}\);/, "lazy.Zotero = globalThis.__Zotero;");
const tmpBase = path.join(here, "out", "pluginAPIBase.test.mjs");
fs.writeFileSync(tmpBase, base);
globalThis.__Zotero = Zotero;
globalThis.CSS = { escape: s => String(s).replace(/[^a-zA-Z0-9_-]/g, c => "\\" + c) };
const { PluginAPIBase } = await import(pathToFileURL(tmpBase).href);

const zctx = vm.createContext({
	Zotero, Services: { wm: { getEnumerator: () => ({ hasMoreElements: () => false }) } },
	ChromeUtils: { importESModule: () => ({ PluginAPIBase }) },
	console,
});
for (const f of ["itemPaneManager.js", "menuManager.js"]) {
	vm.runInContext(fs.readFileSync(path.join(ZSRC, f), "utf8"), zctx, { filename: f });
}
assert.ok(Zotero.ItemPaneManager && Zotero.MenuManager, "gestores reais carregados");

// Resto do ambiente do bootstrap
const prefPanes = [];
Zotero.PreferencePanes = { register: async o => { prefPanes.push(o); return o.id; } };
const loaded = [];
const scope = {
	Zotero,
	Services: {
		io: { newURI: u => ({ spec: u }) },
		scriptloader: {
			loadSubScript: url => {
				const file = url.replace(rootURI, "");
				loaded.push(file);
				vm.runInContext(fs.readFileSync(path.join(ADDON, file), "utf8"), scopeCtx, { filename: file });
			},
		},
	},
	Components: {
		classes: { "@mozilla.org/addons/addon-manager-startup;1": { getService: () => ({
			registerChrome: (uri, entries) => { scope.__chrome = { uri: uri.spec, entries }; return { destruct: () => { scope.__chromeDestructed = true; } }; },
		}) } },
		interfaces: { amIAddonManagerStartup: {} },
	},
	setTimeout, clearTimeout, console, TextDecoder,
};
const rootURI = pathToFileURL(ADDON).href + "/";
const scopeCtx = vm.createContext(scope);
vm.runInContext(fs.readFileSync(path.join(ADDON, "bootstrap.js"), "utf8"), scopeCtx, { filename: "bootstrap.js" });

await vm.runInContext("startup", scopeCtx)({ id: "assistente-ia@sbhg.pt", version: "0.1.0", rootURI });

// Verificações
assert.deepEqual(loaded, ["content/i18n.js", "content/lib.js", "content/chatview.js", "content/zoteroia.js"]);
assert.equal(JSON.stringify(scope.__chrome.entries), JSON.stringify([["content", "zoteroia", "content/"]]));
assert.equal(prefPanes.length, 1);
assert.equal(prefPanes[0].id, "zoteroia-prefs");
for (const k of ["src", "image"]) assert.ok(fs.existsSync(fileURLToPath(prefPanes[0][k])), k + " existe");
for (const s of prefPanes[0].scripts.concat(prefPanes[0].stylesheets)) assert.ok(fs.existsSync(fileURLToPath(s)), s);
const sectionID = vm.runInContext("sectionID", scopeCtx);
assert.ok(sectionID && typeof sectionID === "string", "secção registada pelo ItemPaneManager real: " + sectionID);
const menuIDs = vm.runInContext("menuIDs", scopeCtx);
assert.equal(menuIDs.length, 2);
assert.ok(menuIDs.every(Boolean), "menus aceites pelo MenuManager real: " + menuIDs.join(", "));
assert.ok(Zotero.ZoteroIA && Zotero.ZoteroIA.ChatView, "núcleo exposto");

// Ícones e textos de interface existem
const ftl = fs.readFileSync(path.join(ADDON, "locale/pt-PT/zoteroia.ftl"), "utf8");
const src = fs.readFileSync(path.join(ADDON, "bootstrap.js"), "utf8");
for (const id of new Set(src.match(/zoteroia-[a-z-]+(?=")/g).filter(x => !["zoteroia-section", "zoteroia-item-menu", "zoteroia-tools-menu", "zoteroia-stylesheet", "zoteroia-open-window"].includes(x)))) {
	assert.ok(ftl.includes(id + " ="), "texto em falta: " + id);
}
for (const icon of src.match(/content\/icons\/[a-z0-9]+\.svg/g)) assert.ok(fs.existsSync(path.join(ADDON, icon)), icon);

// Encerramento
Zotero.ZoteroIA.closeAllWindows = () => {};
vm.runInContext("shutdown", scopeCtx)({ id: "assistente-ia@sbhg.pt" }, 2);
assert.equal(scope.__chromeDestructed, true);
assert.equal(Zotero.ZoteroIA, undefined);

if (warnings.length) {
	console.error("Avisos do Zotero:\n" + warnings.join("\n"));
	process.exit(1);
}
console.log("OK bootstrap: chrome registado, 4 scripts carregados, preferências, secção e 2 menus aceites pelas validações reais do Zotero, textos e ícones presentes, encerramento limpo");
