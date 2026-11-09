"use strict";
/**
 * Abre una página con el Playwright del proyecto y devuelve su árbol de accesibilidad, para que
 * Gemini escriba la prueba con los botones y campos que de verdad existen.
 *
 *   node capturar-pagina.js <raíz del proyecto> <url>   → imprime JSON { url, titulo, snapshot }
 *   node capturar-pagina.js <raíz del proyecto> --version → versión de @playwright/test (o error)
 */
const { createRequire } = require("module");
const path = require("path");

async function main() {
  const [raiz, url] = process.argv.slice(2);
  const req = createRequire(path.join(raiz || process.cwd(), "package.json"));
  let pw;
  try {
    pw = req("@playwright/test");
  } catch (e) {
    try { pw = req("playwright"); } catch (e2) {
      process.stdout.write(JSON.stringify({ error: "sin-playwright" }));
      process.exitCode = 2;
      return;
    }
  }
  if (url === "--version") {
    let version = "";
    try { version = req("@playwright/test/package.json").version; } catch (e) { try { version = req("playwright/package.json").version; } catch (e2) { /* */ } }
    process.stdout.write(JSON.stringify({ version }));
    return;
  }
  const navegador = await pw.chromium.launch();
  try {
    const pagina = await navegador.newPage({ locale: "es-CO" });
    await pagina.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pagina.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    const snapshot = await pagina.locator("body").ariaSnapshot();
    process.stdout.write(JSON.stringify({ url: pagina.url(), titulo: await pagina.title(), snapshot: snapshot.slice(0, 20000) }));
  } finally {
    await navegador.close();
  }
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String(e && e.message || e).split("\n")[0] }));
  process.exitCode = 1;
});
