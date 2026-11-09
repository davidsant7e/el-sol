"use strict";
// Prueba el panel (webview) en Chromium con Playwright. Si Playwright no está instalado, se omite.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const S = require("../vscode/nucleo/sol.js");

let playwright = null;
try { playwright = require("playwright"); } catch (e) { /* opcional */ }

const MEDIA = path.join(__dirname, "..", "vscode", "media");

function estadoPlan() {
  const plan = S.normalizarPlan({
    titulo: "Login con Google", caso: "Como usuario quiero iniciar sesión con Google", fuente: "gemini",
    escenarios: [
      { titulo: "Login correcto", tipo: "feliz", prioridad: "alta", pasos: ["Abrir", "Pulsar"], esperado: "Entra", estado: "paso",
        adjuntos: [{ archivo: "adjuntos/E01-01-a.png", nombre: "a.png", tipo: "image/png", bytes: 2048 }] },
      { titulo: "Sin internet", tipo: "error", prioridad: "alta", pasos: ["Modo avión", "Pulsar"], esperado: "Aviso" },
      { titulo: "Doble clic", tipo: "borde", prioridad: "media", pasos: ["x"], esperado: "" },
    ],
  });
  for (const e of plan.escenarios) for (const a of e.adjuntos) { a.uri = "data:image/gif;base64,R0lGODlhAQABAAAAACw="; a.imagen = true; }
  return { tipo: "estado", modo: "plan", ocupado: false, clave: "guardada en El Sol", modelo: "gemini-3.5-flash-lite",
    estados: S.ESTADOS, tipos: S.TIPOS, prioridades: S.PRIORIDADES, veredictos: S.VEREDICTOS, plan, carpeta: "pruebas/x", hayPdf: false };
}

async function abrirPanel(navegador) {
  const pg = await navegador.newPage({ viewport: { width: 900, height: 1000 } });
  const errores = [];
  pg.on("pageerror", (e) => errores.push(String(e)));
  await pg.setContent(`<!doctype html><html><head><style>${fs.readFileSync(path.join(MEDIA, "panel.css"), "utf8")}</style></head>
    <body class="vscode-dark"><main id="app"></main>
    <script>window.__enviados=[];window.__estado=null;window.acquireVsCodeApi=()=>({postMessage:m=>window.__enviados.push(m),getState:()=>window.__estado,setState:s=>{window.__estado=s}});</script>
    <script>${fs.readFileSync(path.join(MEDIA, "panel.js"), "utf8")}</script></body></html>`);
  const enviados = () => pg.evaluate(() => window.__enviados);
  const mandar = (m) => pg.evaluate((x) => window.postMessage(x, "*"), m);
  return { pg, errores, enviados, mandar };
}

module.exports = {
  async "panel: estados, observación, atajos, filtros y pegar capturas"() {
    if (!playwright) return "omitida";
    const navegador = await playwright.chromium.launch();
    try {
      const { pg, errores, enviados, mandar } = await abrirPanel(navegador);
      assert.deepStrictEqual(await enviados(), [{ tipo: "listo" }]);
      await mandar(estadoPlan());
      await pg.waitForSelector('article[data-id="E01"]');
      const texto = await pg.textContent("#app");
      assert.ok(!/\bnull\b|\bundefined\b/.test(texto), "aparece null/undefined en el panel");
      assert.ok(texto.includes("Incompleto") && texto.includes("1 de 3 revisados"));
      assert.strictEqual(await pg.locator(".tramo").count(), 2);

      await pg.click('article[data-id="E02"] .b-fallo');
      await pg.fill('article[data-id="E02"] .observacion', "Se cierra la app");
      await pg.waitForTimeout(650);
      await pg.focus('article[data-id="E03"] .observacion');
      await pg.keyboard.press("b"); // dentro de un campo de texto es una letra normal
      await pg.focus('article[data-id="E03"] .b-paso');
      await pg.keyboard.press("b");
      let m = await enviados();
      assert.deepStrictEqual(m.slice(1).map((x) => [x.tipo, x.id, x.campo, x.valor]), [
        ["campo", "E02", "estado", "fallo"],
        ["campo", "E02", "observacion", "Se cierra la app"],
        ["campo", "E03", "observacion", "b"],
        ["campo", "E03", "estado", "bloqueado"],
      ]);

      // pegar una imagen en el escenario activo (E03)
      await pg.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
        document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
      });
      await pg.waitForTimeout(100);
      m = await enviados();
      const pegado = m[m.length - 1];
      assert.strictEqual(pegado.tipo, "adjuntarDatos");
      assert.strictEqual(pegado.id, "E03");
      assert.ok(/^captura-\d{4}-\d{2}-\d{2}-.*\.png$/.test(pegado.archivos[0].nombre), pegado.archivos[0].nombre);
      assert.strictEqual(pegado.archivos[0].base64, "iVBORw==");

      // soltar archivos en la zona de evidencias
      await pg.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(["hola"], "log.txt", { type: "text/plain" }));
        document.querySelector('.zona[data-id="E01"]').dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await pg.waitForTimeout(100);
      m = await enviados();
      assert.deepStrictEqual([m[m.length - 1].id, m[m.length - 1].archivos[0].nombre], ["E01", "log.txt"]);

      // un estado nuevo de la extensión no quita el foco del campo que se está escribiendo
      await pg.click('article[data-id="E01"] .observacion');
      await pg.keyboard.type("Ok en Pixel");
      const est = estadoPlan();
      est.plan.escenarios[1].estado = "fallo";
      await mandar(est);
      await pg.waitForTimeout(50);
      const foco = await pg.evaluate(() => document.activeElement && document.activeElement.dataset.foco);
      assert.strictEqual(foco, "E01-observacion");

      // filtro
      await pg.click(".filtros .chip:nth-child(3)"); // Fallaron
      assert.deepStrictEqual(await pg.locator("article").evaluateAll((a) => a.map((x) => x.dataset.id)), ["E02"]);

      // enfocar un escenario recién agregado
      const est2 = estadoPlan();
      est2.enfocar = "E03";
      await mandar(est2);
      await pg.waitForTimeout(50);
      assert.strictEqual(await pg.evaluate(() => document.activeElement.className), "titulo-esc");
      assert.strictEqual(await pg.locator("article").count(), 3, "enfocar vuelve al filtro Todos");

      assert.deepStrictEqual(errores, []);
    } finally {
      await navegador.close();
    }
  },

  async "panel: crear un plan"() {
    if (!playwright) return "omitida";
    const navegador = await playwright.chromium.launch();
    try {
      const { pg, errores, enviados, mandar } = await abrirPanel(navegador);
      await mandar({ tipo: "estado", modo: "nuevo", ocupado: false, clave: "", modelo: "m", estados: S.ESTADOS, tipos: S.TIPOS, prioridades: S.PRIORIDADES, veredictos: S.VEREDICTOS, borrador: { caso: "Del editor" }, destino: "demo/pruebas" });
      await pg.waitForSelector("#caso");
      assert.strictEqual(await pg.inputValue("#caso"), "Del editor");
      assert.ok((await pg.textContent("#app")).includes("Sin clave de Gemini"));
      await pg.fill("#titulo", "Exportar");
      await pg.click("button.primario");
      await pg.click(".enlace");
      const m = await enviados();
      assert.deepStrictEqual(m.slice(1), [{ tipo: "crear", modo: "gemini", titulo: "Exportar", caso: "Del editor", indicacion: "" }, { tipo: "configurarClave" }]);
      assert.deepStrictEqual(errores, []);
    } finally {
      await navegador.close();
    }
  },

  async "panel: pruebas end-to-end"() {
    if (!playwright) return "omitida";
    const E = require("../vscode/nucleo/e2e.js");
    const navegador = await playwright.chromium.launch();
    try {
      const { pg, errores, enviados, mandar } = await abrirPanel(navegador);
      const est = estadoPlan();
      est.plataformas = E.PLATAFORMAS;
      est.origenes = E.ORIGENES;
      est.plan.e2e = { url: "https://demo.test", appId: "" };
      est.plan.escenarios[0].automatizacion = Object.assign(E.normalizarAutomatizacion({ plataforma: "web", archivo: "e2e/E01.spec.ts", origen: "gemini",
        ultima: { fecha: "2026-11-09T15:30:00Z", estado: "fallo", duracionMs: 2400 } }), { existe: true });
      est.plan.escenarios[1].automatizacion = Object.assign(E.normalizarAutomatizacion({ plataforma: "android", archivo: "e2e/E02.yaml", origen: "grabada" }), { existe: false });
      await mandar(est);
      await pg.waitForSelector('article[data-id="E01"] .e2e');
      const t1 = await pg.textContent('article[data-id="E01"] .e2e');
      assert.ok(t1.includes("Web (Playwright)") && t1.includes("Generada con Gemini") && t1.includes("falló · 2,4 s"), t1);
      assert.ok((await pg.textContent('article[data-id="E02"] .e2e')).includes("aún no se ha guardado"));
      assert.ok(await pg.isDisabled('article[data-id="E02"] .e2e button:has-text("Ejecutar")'));
      assert.ok((await pg.textContent(".barra-acciones")).includes("Ejecutar automatizadas (2)"));

      await pg.click('article[data-id="E01"] .e2e button:has-text("Ejecutar")');
      await pg.click('article[data-id="E03"] button:has-text("Generar web con IA")');
      await pg.click('article[data-id="E03"] button:has-text("Grabar Android")');
      await pg.click('article[data-id="E03"] button:has-text("Vincular")');
      await pg.click('article[data-id="E01"] button:has-text("Desunir")');
      await pg.click(".barra-acciones button:has-text(\"Ejecutar automatizadas\")");
      await pg.click(".bloque-e2e summary");
      await pg.fill('[data-foco="e2e-appId"]', "com.demo.app");
      await pg.waitForTimeout(650);
      const m = (await enviados()).slice(1);
      assert.deepStrictEqual(m, [
        { tipo: "e2eEjecutar", ids: ["E01"] },
        { tipo: "e2eGenerar", id: "E03", plataforma: "web" },
        { tipo: "e2eGrabar", id: "E03", plataforma: "android" },
        { tipo: "e2eVincular", id: "E03" },
        { tipo: "e2eQuitar", id: "E01" },
        { tipo: "e2eEjecutar", ids: [] },
        { tipo: "e2eConfig", campo: "appId", valor: "com.demo.app" },
      ]);
      await pg.screenshot({ path: require("path").join(require("os").tmpdir(), "elsol-panel-e2e.png"), fullPage: true });
      assert.deepStrictEqual(errores, []);
    } finally {
      await navegador.close();
    }
  },
};
