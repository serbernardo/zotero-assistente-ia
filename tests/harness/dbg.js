const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  p.on("console", m => console.log("console:", m.type(), m.text()));
  p.on("pageerror", e => console.log("pageerror:", e.message));
  await p.goto("file://" + __dirname + "/ui.html?mode=window");
  await p.evaluate(() => window.ready);
  console.log("botões:", await p.evaluate(() => [...document.querySelectorAll("button")].map(b => b.textContent + (b.disabled ? "(off)" : "")).join(" | "))); await p.click("button:has-text(\"Selecionados\")");
  await p.waitForTimeout(1000);
  console.log("status:", await p.textContent(".zia-status"), "| docs:", await p.textContent(".zia-docs"));
  console.log(await p.evaluate(async () => { try { const d = await ZoteroIA.describeItem(Zotero.Items.get(1)); return JSON.stringify(d); } catch (e) { return "ERR " + e.stack; } }));
  await b.close();
})();
