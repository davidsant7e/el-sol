"use strict";
// Pruebas end-to-end de los escenarios: reportes, aplicar resultados, generar con Gemini y ejecutar.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const S = require("../vscode/nucleo/sol.js");
const E = require("../vscode/nucleo/e2e.js");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function planDePrueba() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "elsol-e2e-"));
  const carpeta = S.crearCarpetaPlan(path.join(raiz, "pruebas"), "Login");
  const plan = S.guardarPlan(carpeta, {
    titulo: "Login", caso: "Iniciar sesión con usuario y clave", e2e: { url: "https://demo.test", appId: "com.demo.app" },
    escenarios: [
      { titulo: "Entrar con usuario válido", pasos: ["Abrir", "Escribir usuario", "Entrar"], esperado: "Bienvenida" },
      { titulo: "Clave incorrecta", pasos: ["Abrir", "Escribir clave mala"], esperado: "Mensaje de error" },
      { titulo: "Entrar desde el celular", pasos: ["Abrir app", "Tocar Entrar"], esperado: "Pantalla principal" },
    ],
  });
  return { raiz, carpeta, plan };
}

function reportePlaywright(carpeta) {
  const art = path.join(carpeta, "e2e", ".resultados", "artefactos");
  fs.mkdirSync(art, { recursive: true });
  for (const f of ["e1.png", "e2.png", "v2.webm"]) fs.writeFileSync(path.join(art, f), f.endsWith(".png") ? PNG : Buffer.from("video"));
  return {
    suites: [{
      title: "E01.spec.ts", file: "E01.spec.ts",
      specs: [{ title: "E01 · Entrar con usuario válido", file: "E01.spec.ts", tests: [{ status: "expected", results: [{ status: "passed", duration: 1200, attachments: [{ name: "screenshot", contentType: "image/png", path: path.join(art, "e1.png") }] }] }] }],
    }, {
      title: "grabada.spec.ts", file: "grabada.spec.ts",
      suites: [{ title: "describe", specs: [{ title: "E02 · Clave incorrecta", file: "grabada.spec.ts", tests: [{ status: "unexpected", results: [{
        status: "failed", duration: 3400,
        error: { message: "\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\nLocator: getByText('Clave incorrecta')\nCall log:\n  - waiting\n    at x.spec.ts:3:1" },
        attachments: [
          { name: "screenshot", contentType: "image/png", path: path.join(art, "e2.png") },
          { name: "video", contentType: "video/webm", path: path.join(art, "v2.webm") },
          { name: "error-context", contentType: "text/markdown", path: path.join(art, "no-existe.md") },
        ],
      }] }] }] }],
    }, {
      title: "otra.spec.ts", file: "otra.spec.ts",
      specs: [{ title: "sin id", file: "otra.spec.ts", tests: [{ status: "skipped", results: [{ status: "skipped", duration: 0 }] }] }],
    }],
    errors: [],
  };
}

module.exports = {
  "e2e: sol.json conserva la automatización y la configuración"() {
    const { carpeta, plan } = planDePrueba();
    plan.escenarios[0].automatizacion = { plataforma: "web", archivo: "e2e\\E01.spec.ts", origen: "gemini", ultima: { fecha: "2026-11-09T10:00:00Z", estado: "paso", duracionMs: 10 } };
    plan.escenarios[1].automatizacion = { plataforma: "rara", archivo: "", origen: "x" };
    S.guardarPlan(carpeta, plan);
    const leido = S.leerPlan(carpeta);
    assert.deepStrictEqual(leido.e2e, { url: "https://demo.test", appId: "com.demo.app" });
    assert.strictEqual(leido.escenarios[0].automatizacion.archivo, "e2e/E01.spec.ts");
    assert.strictEqual(leido.escenarios[0].automatizacion.ultima.estado, "paso");
    assert.strictEqual(leido.escenarios[1].automatizacion, null);
    // los escenarios que suma Gemini no heredan automatización
    const [nuevo] = S.sumarEscenarios(leido, [Object.assign({}, leido.escenarios[0], { titulo: "Otro" })]);
    assert.strictEqual(nuevo.automatizacion, null);
  },

  "e2e: lee el reporte JSON de Playwright"() {
    const { carpeta } = planDePrueba();
    const r = E.leerReportePlaywright(JSON.stringify(reportePlaywright(carpeta)));
    assert.deepStrictEqual(r.map((x) => [x.id, x.estado]), [["E01", "paso"], ["E02", "fallo"], [null, "omitida"]]);
    assert.strictEqual(r[1].error, "Error: expect(locator).toBeVisible() failed\nLocator: getByText('Clave incorrecta')");
    assert.strictEqual(r[1].adjuntos.length, 3);
    assert.strictEqual(r[0].duracionMs, 1200);
  },

  "e2e: lee reportes JUnit (Maestro, Cypress, Selenium)"() {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="x">
      <testcase name="E01 · Entrar" classname="login" time="1.5"/>
      <testcase name="Clave mala" classname="E02.yaml" time="2"><failure message="Element not found: Text matching &quot;Error&quot;">detalle &lt;aquí&gt;</failure></testcase>
      <testcase name="E03 omitido" time="0"><skipped/></testcase>
      <testcase name="sin id" time="0"><error message="boom"/></testcase>
    </testsuite></testsuites>`;
    const r = E.leerJUnit(xml);
    assert.deepStrictEqual(r.map((x) => [x.id, x.estado, x.duracionMs]), [["E01", "paso", 1500], ["E02", "fallo", 2000], ["E03", "omitida", 0], [null, "fallo", 0]]);
    assert.strictEqual(r[1].error, 'Element not found: Text matching "Error"\ndetalle <aquí>');
  },

  "e2e: aplicar resultados marca el estado, la observación y las evidencias (sin acumular)"() {
    const { carpeta, plan } = planDePrueba();
    plan.escenarios[0].observacion = "Probado con Chrome.";
    plan.escenarios[0].automatizacion = E.normalizarAutomatizacion({ plataforma: "web", archivo: "e2e/E01.spec.ts", origen: "gemini" });
    const resultados = E.leerReportePlaywright(reportePlaywright(carpeta));
    for (let vez = 0; vez < 2; vez++) {
      const r = E.aplicarResultados(carpeta, plan, resultados, { fecha: "2026-11-09T15:30:00Z" });
      assert.deepStrictEqual(r.aplicados, [{ id: "E01", estado: "paso" }, { id: "E02", estado: "fallo" }]);
      assert.deepStrictEqual(r.sinEscenario, ["sin id"]);
    }
    const [e1, e2] = plan.escenarios;
    assert.strictEqual(e1.estado, "paso");
    assert.strictEqual(e2.estado, "fallo");
    // la nota del probador se conserva y el bloque automático se reemplaza
    assert.ok(e1.observacion.startsWith("Probado con Chrome.\n» E2E "), e1.observacion);
    assert.strictEqual(e1.observacion.split("» E2E").length, 2);
    assert.ok(/Pasó en 1,2 s\.$/.test(e1.observacion));
    assert.ok(e2.observacion.includes("Falló en 3,4 s:\nError: expect(locator).toBeVisible()"));
    // evidencias: captura en el que pasó; captura y video en el que falló; nada repetido tras dos ejecuciones
    assert.deepStrictEqual(e1.adjuntos.map((a) => a.archivo), ["adjuntos/E01-01-e2e-1-screenshot.png"]);
    assert.deepStrictEqual(e2.adjuntos.map((a) => a.archivo), ["adjuntos/E02-01-e2e-1-screenshot.png", "adjuntos/E02-02-e2e-2-video.webm"]);
    assert.strictEqual(fs.readdirSync(path.join(carpeta, "adjuntos")).length, 3);
    assert.strictEqual(e1.automatizacion.ultima.estado, "paso");
    // una evidencia que puso el probador no se toca
    S.agregarAdjunto(carpeta, plan, "E01", "mia.png", PNG);
    E.aplicarResultados(carpeta, plan, resultados);
    assert.ok(plan.escenarios[0].adjuntos.some((a) => a.nombre === "mia.png"));
  },

  "e2e: codegen deja test('test'): se le pone el id del escenario"() {
    const esc = { id: "E07", titulo: "Pagar con 'tarjeta'" };
    const grabado = "import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n  await page.goto('/');\n});\n";
    const con = E.ponerTitulo(grabado, esc);
    assert.ok(con.includes("test('E07 · Pagar con tarjeta', async"));
    assert.strictEqual(E.ponerTitulo(con, esc), con);
  },

  async "e2e: generar con Gemini (web y Android)"() {
    const { plan } = planDePrueba();
    let pedido = null;
    const fetch = (codigo) => async (_url, op) => {
      pedido = JSON.parse(op.body);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "```ts\n" + codigo + "\n```" }] } }] }) };
    };
    const web = "import { test, expect } from '@playwright/test';\ntest('Entrar', async ({ page }) => { await page.goto('/'); await expect(page.getByText('Bienvenida')).toBeVisible(); });";
    const codigo = await E.generarCodigo("web", plan.escenarios[0], plan, { clave: "k", fetch: fetch(web), pagina: { url: "https://demo.test", snapshot: "- button \"Entrar\"" } });
    assert.ok(codigo.startsWith("import { test, expect }"));
    assert.ok(codigo.includes("test('E01 · Entrar con usuario válido'"));
    const texto = pedido.contents[0].parts[0].text;
    assert.ok(texto.includes("- button \"Entrar\"") && texto.includes("3. Entrar") && texto.includes("baseURL"));

    const yaml = "appId: com.demo.app\nname: E03\n---\n- launchApp\n- tapOn: \"Entrar\"\n- assertVisible: \"Inicio\"\n- takeScreenshot: E03-final\n";
    assert.strictEqual(await E.generarCodigo("android", plan.escenarios[2], plan, { clave: "k", fetch: fetch(yaml), pantalla: "- texto=\"Entrar\" tocable" }), yaml);
    assert.ok(pedido.contents[0].parts[0].text.includes("appId: com.demo.app"));

    await assert.rejects(() => E.generarCodigo("web", plan.escenarios[0], plan, { clave: "k", fetch: fetch("console.log(1)") }), /no devolvió una prueba de Playwright/);
    await assert.rejects(() => E.generarCodigo("android", plan.escenarios[2], plan, { clave: "k", fetch: fetch("- tapOn: x") }), /flujo de Maestro/);
    await assert.rejects(() => E.generarCodigo("web", plan.escenarios[0], plan, {}), /clave de Gemini/);
    const f429 = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await assert.rejects(() => E.generarCodigo("web", plan.escenarios[0], plan, { clave: "k", fetch: f429 }), /límite/);
  },

  "e2e: resumen de la pantalla de Maestro"() {
    const j = { attributes: {}, children: [
      { attributes: { text: "Bienvenido", "resource-id": "com.demo:id/titulo" } },
      { attributes: { accessibilityText: "Entrar", clickable: "true" }, children: [{ attributes: { text: "" } }] },
      { attributes: { hintText: "Correo", enabled: "false" } },
    ] };
    assert.strictEqual(E.resumirJerarquia("Running…\n" + JSON.stringify(j)),
      '- texto="Bienvenido" id=com.demo:id/titulo\n- texto="Entrar" tocable\n- texto="Correo" deshabilitado');
  },

  async "e2e: ejecutar Maestro (simulado) junta el JUnit y las capturas"() {
    const { carpeta, plan } = planDePrueba();
    plan.escenarios[2].automatizacion = E.normalizarAutomatizacion({ plataforma: "android", archivo: "e2e/E03.yaml", origen: "gemini" });
    fs.mkdirSync(path.join(carpeta, "e2e"), { recursive: true });
    fs.writeFileSync(path.join(carpeta, "e2e", "E03.yaml"), "appId: com.demo.app\n---\n- launchApp\n");
    fs.writeFileSync(path.join(carpeta, "e2e", ".env"), "# datos\nE2E_USUARIO=ana\nE2E_CLAVE=\"secreta 1\"\n");
    let llamado = null;
    const spawn = (cmd, args, op) => {
      llamado = { cmd, args, op };
      const h = new EventEmitter();
      h.stdout = new EventEmitter();
      h.stderr = new EventEmitter();
      setImmediate(() => {
        const salida = args.find((a) => a.startsWith("--test-output-dir=")).split("=")[1];
        const shots = path.join(salida, "2026-11-09_101500", "E03", "takeScreenshot");
        fs.mkdirSync(shots, { recursive: true });
        fs.writeFileSync(path.join(shots, "E03-final.png"), PNG);
        fs.writeFileSync(args[args.indexOf("--output") + 1], '<testsuites><testsuite><testcase name="E03" time="4.2"><failure message="Assertion is false: &quot;Inicio&quot; is visible"/></testcase></testsuite></testsuites>');
        h.stdout.emit("data", Buffer.from("Running E03\n"));
        h.emit("close", 1);
      });
      return h;
    };
    if (process.platform === "win32") return "omitida"; // en Windows va por la consola: se prueba en el PC
    const r = await E.ejecutarAndroid(carpeta, plan, [], { spawn });
    assert.strictEqual(llamado.cmd, "maestro");
    assert.deepStrictEqual(llamado.args.slice(0, 5), ["test", "-e", "E2E_USUARIO=ana", "-e", "E2E_CLAVE=secreta 1"]);
    assert.deepStrictEqual(r.resultados.map((x) => [x.id, x.estado]), [["E03", "fallo"]]);
    assert.strictEqual(r.extra.E03.length, 1);
    E.aplicarResultados(carpeta, plan, r.resultados, { extra: r.extra });
    const e3 = plan.escenarios[2];
    assert.strictEqual(e3.estado, "fallo");
    assert.ok(e3.observacion.includes('Assertion is false: "Inicio" is visible'));
    assert.deepStrictEqual(e3.adjuntos.map((a) => a.archivo), ["adjuntos/E03-01-e2e-1-e03-final.png"]);
    assert.ok(fs.readFileSync(path.join(carpeta, "e2e", ".gitignore"), "utf8").includes(".env"));
  },

  async "e2e: Playwright de verdad contra una página local"() {
    // Necesita @playwright/test y Chromium; si no están, se omite.
    let raizPw = null;
    for (const r of [process.env.ELSOL_PLAYWRIGHT, path.join(__dirname, ".."), "/tmp/pwt"]) {
      try { if (r) { require.resolve("@playwright/test", { paths: [r] }); raizPw = r; break; } } catch (e) { /* */ }
    }
    if (!raizPw || process.platform === "win32") return "omitida";
    const http = require("http");
    const servidor = http.createServer((_q, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><html lang="es"><title>Demo</title><label for="u">Usuario</label><input id="u"><button onclick="document.getElementById(\'r\').textContent=document.getElementById(\'u\').value===\'ana\'?\'Bienvenida, ana\':\'Usuario incorrecto\'">Entrar</button><p id="r" role="status"></p>');
    }).listen(0);
    const puerto = servidor.address().port;
    try {
      const carpeta = S.crearCarpetaPlan(path.join(raizPw, "pruebas"), "Demo e2e " + Date.now());
      const plan = S.guardarPlan(carpeta, { titulo: "Demo", e2e: { url: "http://127.0.0.1:" + puerto }, escenarios: [
        { titulo: "Entra ana", pasos: ["Escribir ana", "Entrar"], esperado: "Bienvenida" },
        { titulo: "Grabado que falla", pasos: ["Entrar"], esperado: "Bienvenido" },
      ] });
      fs.mkdirSync(path.join(carpeta, "e2e"), { recursive: true });
      fs.writeFileSync(path.join(carpeta, "e2e", "E01.spec.ts"), "import { test, expect } from '@playwright/test';\ntest('E01 · Entra ana', async ({ page }) => {\n  await page.goto('/');\n  await page.getByLabel('Usuario').fill(process.env.E2E_USUARIO ?? '');\n  await page.getByRole('button', { name: 'Entrar' }).click();\n  await expect(page.getByRole('status')).toHaveText('Bienvenida, ana');\n});\n");
      fs.writeFileSync(path.join(carpeta, "e2e", "E02.spec.ts"), "import { test, expect } from '@playwright/test';\ntest('test', async ({ page }) => {\n  await page.goto('/');\n  await page.getByRole('button', { name: 'Entrar' }).click();\n  await expect(page.getByRole('status')).toHaveText('Bienvenido', { timeout: 1500 });\n});\n");
      fs.writeFileSync(path.join(carpeta, "e2e", ".env"), "E2E_USUARIO=ana\n");
      plan.escenarios[0].automatizacion = E.normalizarAutomatizacion({ plataforma: "web", archivo: "e2e/E01.spec.ts", origen: "gemini" });
      plan.escenarios[1].automatizacion = E.normalizarAutomatizacion({ plataforma: "web", archivo: "e2e/E02.spec.ts", origen: "grabada" });
      const r = await E.ejecutarWeb(carpeta, plan, [], { raiz: raizPw });
      assert.deepStrictEqual(r.resultados.map((x) => [x.id, x.estado]), [["E01", "paso"], ["E02", "fallo"]], r.salida.slice(-1500));
      E.aplicarResultados(carpeta, plan, r.resultados);
      S.guardarPlan(carpeta, plan);
      assert.ok(fs.readFileSync(path.join(carpeta, "e2e", "E02.spec.ts"), "utf8").includes("test('E02 · Grabado que falla'"));
      assert.ok(plan.escenarios[1].adjuntos.some((a) => a.tipo === "image/png"));
      const { generarInforme } = require("../vscode/nucleo/informe.js");
      const pdf = await generarInforme(carpeta);
      assert.ok(pdf.paginas >= 2);
      fs.rmSync(carpeta, { recursive: true, force: true });
    } finally {
      servidor.close();
    }
  },
};
