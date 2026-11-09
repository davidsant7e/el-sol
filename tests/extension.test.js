"use strict";
// Prueba la extensión con un VS Code simulado: crear un plan desde el panel, editar, adjuntar y generar el PDF.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

function vscodeFalso(raiz) {
  const registro = { comandos: {}, mensajes: [], avisos: [], abiertos: [], paneles: [], secretos: {}, respuestaModal: "Quitar", vigias: [], salida: [], terminales: [] };
  const Uri = {
    file: (p) => ({ fsPath: p, scheme: "file", toString: () => "file://" + p }),
  };
  const vscode = {
    Uri,
    ViewColumn: { Active: -1, Beside: -2 },
    ProgressLocation: { Notification: 15 },
    RelativePattern: function (base, patron) { this.base = base; this.patron = patron; },
    commands: {
      registerCommand: (id, f) => { registro.comandos[id] = f; return { dispose() {} }; },
      executeCommand: async (...a) => { registro.abiertos.push(a); },
    },
    env: { openExternal: async (u) => { registro.abiertos.push(["externo", u.fsPath]); return true; } },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(raiz), name: "demo" }],
      getWorkspaceFolder: () => ({ uri: Uri.file(raiz) }),
      asRelativePath: (p) => path.relative(raiz, typeof p === "string" ? p : p.fsPath).split(path.sep).join("/"),
      getConfiguration: () => ({ get: () => undefined }),
      createFileSystemWatcher: () => {
        const v = { cambios: [], onDidChange: (f) => v.cambios.push(f), onDidCreate: (f) => v.cambios.push(f), dispose() {} };
        registro.vigias.push(v);
        return v;
      },
    },
    window: {
      activeTextEditor: null,
      showInformationMessage: async (m) => { registro.avisos.push(["info", m]); return undefined; },
      showWarningMessage: async (m, ...b) => { registro.avisos.push(["aviso", m]); return b.find((x) => typeof x === "string") ? registro.respuestaModal : undefined; },
      showErrorMessage: async (m) => { registro.avisos.push(["error", m]); },
      showInputBox: async () => registro.entrada,
      showOpenDialog: async () => registro.archivosElegidos,
      showQuickPick: async (items) => items[0],
      showTextDocument: async (u) => { registro.abiertos.push(["texto", u.fsPath]); },
      withProgress: async (_o, f) => f({ report() {} }, { onCancellationRequested() {} }),
      createOutputChannel: () => ({ appendLine: (t) => registro.salida.push(t), append: (t) => registro.salida.push(t), show() {} }),
      createTerminal: (o) => { const t = { opciones: o, textos: [], show() {}, sendText: (x) => t.textos.push(x) }; registro.terminales.push(t); return t; },
      createWebviewPanel: (tipo, titulo) => {
        let alRecibir = null;
        const panel = {
          title: titulo,
          webview: {
            options: {},
            cspSource: "vscode-resource:",
            html: "",
            asWebviewUri: (u) => ({ toString: () => "vscode-webview://" + u.fsPath }),
            postMessage: (m) => { registro.mensajes.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (f) => { alRecibir = f; },
          },
          reveal() {},
          onDidDispose() {},
          enviar: (m) => alRecibir(m),
        };
        registro.paneles.push(panel);
        return panel;
      },
    },
  };
  return { vscode, registro };
}

function cargarExtension(vscode) {
  const original = Module._resolveFilename;
  const cargarOriginal = Module._load;
  Module._load = function (pedido, ...resto) {
    if (pedido === "vscode") return vscode;
    return cargarOriginal.call(this, pedido, ...resto);
  };
  const ruta = require.resolve("../vscode/extension.js");
  delete require.cache[ruta];
  try {
    return require(ruta);
  } finally {
    Module._load = cargarOriginal;
    Module._resolveFilename = original;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms || 20));
const ultimoEstado = (reg) => [...reg.mensajes].reverse().find((m) => m.tipo === "estado");

module.exports = {
  async "flujo completo en el panel"() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "elsol-ext-"));
    const antes = process.env.APPDATA;
    process.env.APPDATA = path.join(raiz, "appdata"); // sin clave guardada: usa la plantilla
    const geminiAntes = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { vscode, registro } = vscodeFalso(raiz);
      const ext = cargarExtension(vscode);
      const secretos = {};
      ext.activate({
        subscriptions: [],
        extensionPath: path.join(__dirname, "..", "vscode"),
        secrets: { get: async (k) => secretos[k], store: async (k, v) => { secretos[k] = v; }, delete: async (k) => { delete secretos[k]; } },
      });
      for (const c of ["elsol.nuevo", "elsol.nuevoDesdeSeleccion", "elsol.abrir", "elsol.generarPdf", "elsol.configurarClave"]) assert.ok(registro.comandos[c], "falta el comando " + c);

      // con texto seleccionado, el caso viene relleno
      vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file(path.join(raiz, "a.md")), getText: () => "Como usuario quiero exportar el reporte a Excel" }, selection: { isEmpty: false } };
      registro.comandos["elsol.nuevoDesdeSeleccion"]();
      await esperar();
      const panel = registro.paneles[0];
      assert.ok(panel.webview.html.includes("Content-Security-Policy") && panel.webview.html.includes("panel.js"));
      let est = ultimoEstado(registro);
      assert.strictEqual(est.modo, "nuevo");
      assert.strictEqual(est.borrador.caso, "Como usuario quiero exportar el reporte a Excel");
      assert.strictEqual(est.clave, "");

      // crear con Gemini sin clave → plantilla + aviso
      await panel.enviar({ tipo: "crear", modo: "gemini", titulo: "", caso: "Exportar reporte a Excel\n- Debe incluir todas las columnas\n- El archivo se descarga" });
      est = ultimoEstado(registro);
      assert.strictEqual(est.modo, "plan");
      assert.strictEqual(est.plan.titulo, "Exportar reporte a Excel");
      assert.strictEqual(est.plan.fuente, "plantilla");
      assert.ok(/Sin clave/.test(est.aviso));
      assert.ok(est.plan.escenarios.length >= 5);
      assert.ok(est.carpeta.startsWith("pruebas/"));
      const carpeta = path.join(raiz, est.carpeta);
      assert.ok(fs.existsSync(path.join(carpeta, "sol.json")));
      assert.strictEqual(panel.title, "☀ Exportar reporte a Excel");

      // editar campos
      await panel.enviar({ tipo: "campo", id: "E01", campo: "estado", valor: "paso" });
      await panel.enviar({ tipo: "campo", id: "E01", campo: "observacion", valor: "Probado en Chrome" });
      await panel.enviar({ tipo: "campo", id: "E01", campo: "pasos", valor: "Abrir\nExportar\n\n" });
      await panel.enviar({ tipo: "campo", id: "E01", campo: "adjuntos", valor: [] }); // no permitido: se ignora
      await panel.enviar({ tipo: "campo", id: "E02", campo: "estado", valor: "fallo" });
      await panel.enviar({ tipo: "campoPlan", campo: "titulo", valor: "Exportar a Excel" });
      let plan = JSON.parse(fs.readFileSync(path.join(carpeta, "sol.json"), "utf8"));
      assert.strictEqual(plan.titulo, "Exportar a Excel");
      assert.strictEqual(plan.escenarios[0].estado, "paso");
      assert.strictEqual(plan.escenarios[0].observacion, "Probado en Chrome");
      assert.deepStrictEqual(plan.escenarios[0].pasos, ["Abrir", "Exportar"]);

      // adjuntar por pegado (base64) y por diálogo
      const pngMin = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc000000301010018dd8db40000000049454e44ae426082", "hex");
      await panel.enviar({ tipo: "adjuntarDatos", id: "E02", archivos: [{ nombre: "captura.png", base64: pngMin.toString("base64") }, { nombre: "", base64: pngMin.toString("base64") }] });
      const externo = path.join(raiz, "log.txt");
      fs.writeFileSync(externo, "error 500");
      registro.archivosElegidos = [vscode.Uri.file(externo)];
      await panel.enviar({ tipo: "elegirAdjuntos", id: "E02" });
      est = ultimoEstado(registro);
      const e2 = est.plan.escenarios.find((e) => e.id === "E02");
      assert.strictEqual(e2.adjuntos.length, 3);
      assert.ok(e2.adjuntos[0].uri.startsWith("vscode-webview://") && e2.adjuntos[0].imagen);
      assert.ok(/^adjuntos\/E02-02-captura-\d{4}/.test(e2.adjuntos[1].archivo), e2.adjuntos[1].archivo);
      assert.strictEqual(e2.adjuntos[2].imagen, false);

      // quitar un adjunto, mover, duplicar, agregar y quitar escenarios
      await panel.enviar({ tipo: "quitarAdjunto", id: "E02", archivo: e2.adjuntos[1].archivo });
      assert.ok(!fs.existsSync(path.join(carpeta, e2.adjuntos[1].archivo)));
      await panel.enviar({ tipo: "mover", id: "E02", dir: -1 });
      est = ultimoEstado(registro);
      assert.deepStrictEqual(est.plan.escenarios.slice(0, 2).map((e) => e.id), ["E02", "E01"]);
      const total = est.plan.escenarios.length;
      await panel.enviar({ tipo: "duplicarEscenario", id: "E02" });
      est = ultimoEstado(registro);
      assert.strictEqual(est.plan.escenarios[1].titulo.endsWith("(copia)"), true);
      assert.strictEqual(est.plan.escenarios[1].adjuntos.length, 0);
      assert.ok(est.enfocar);
      await panel.enviar({ tipo: "agregarEscenario" });
      await panel.enviar({ tipo: "quitarEscenario", id: est.enfocar });
      est = ultimoEstado(registro);
      assert.strictEqual(est.plan.escenarios.length, total + 1);

      // más escenarios: sin clave, la plantilla no tiene nada nuevo
      registro.entrada = "accesibilidad";
      await panel.enviar({ tipo: "pedirMas" });
      est = ultimoEstado(registro);
      assert.ok(/No salieron escenarios nuevos/.test(est.aviso), est.aviso);

      // un cambio de afuera (git pull) se refleja en el panel
      const desdeDisco = JSON.parse(fs.readFileSync(path.join(carpeta, "sol.json"), "utf8"));
      desdeDisco.titulo = "Cambiado por git pull";
      fs.writeFileSync(path.join(carpeta, "sol.json"), JSON.stringify(desdeDisco));
      registro.vigias[0].cambios[0]();
      await esperar();
      assert.strictEqual(ultimoEstado(registro).plan.titulo, "Cambiado por git pull");

      // PDF
      await panel.enviar({ tipo: "pdf" });
      const pdf = path.join(carpeta, path.basename(carpeta) + ".pdf");
      assert.ok(fs.existsSync(pdf), "no se generó el PDF");
      assert.ok(registro.abiertos.some((a) => a[0] === "externo" && a[1] === pdf), "debería abrir el PDF");
      assert.ok(registro.avisos.some(([t, m]) => t === "info" && /PDF listo/.test(m)));
      assert.strictEqual(ultimoEstado(registro).hayPdf, true);
      assert.strictEqual(ultimoEstado(registro).ocupado, false);

      // abrir el plan desde el explorador reutiliza el panel
      await registro.comandos["elsol.abrir"](vscode.Uri.file(path.join(carpeta, "sol.json")));
      assert.strictEqual(registro.paneles.length, 1);

      // la clave guardada aparece en el panel
      registro.entrada = "clave-nueva";
      await registro.comandos["elsol.configurarClave"]();
      await esperar();
      assert.strictEqual(ultimoEstado(registro).clave, "guardada en El Sol");

      // con clave, "más escenarios" llama a Gemini (simulado)
      const fetchAntes = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify([{ titulo: "Exportar con 100 000 filas", tipo: "rendimiento", prioridad: "media", pasos: ["a"], esperado: "b" }]) }] } }] }) });
      try {
        await panel.enviar({ tipo: "mas", indicacion: "" });
      } finally {
        globalThis.fetch = fetchAntes;
      }
      est = ultimoEstado(registro);
      assert.ok(est.plan.escenarios.some((e) => e.titulo === "Exportar con 100 000 filas"));
      assert.strictEqual(est.plan.fuente, "mixta");
      assert.ok(/Se agregaron 1/.test(est.aviso));
    } finally {
      antes === undefined ? delete process.env.APPDATA : (process.env.APPDATA = antes);
      if (geminiAntes !== undefined) process.env.GEMINI_API_KEY = geminiAntes;
    }
  },

  async "pruebas end-to-end desde el panel"() {
    // Ejecuta Playwright de verdad si está instalado en /tmp/pwt (o ELSOL_PLAYWRIGHT); si no, se omite.
    const base = process.env.ELSOL_PLAYWRIGHT || "/tmp/pwt";
    try { require.resolve("@playwright/test", { paths: [base] }); } catch (e) { return "omitida"; }
    if (process.platform === "win32") return "omitida";
    const http = require("http");
    const servidor = http.createServer((_q, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end("<!doctype html><title>Demo</title><h1>Hola mundo</h1>"); }).listen(0);
    const raiz = fs.mkdtempSync(path.join(base, "elsol-ext-"));
    const antes = process.env.APPDATA;
    process.env.APPDATA = path.join(raiz, "appdata");
    try {
      const { vscode, registro } = vscodeFalso(raiz);
      const ext = cargarExtension(vscode);
      ext.activate({ subscriptions: [], extensionPath: path.join(__dirname, "..", "vscode"), secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
      assert.ok(registro.comandos["elsol.e2eEjecutar"]);
      registro.comandos["elsol.nuevo"]();
      await esperar();
      const panel = registro.paneles[0];
      await panel.enviar({ tipo: "crear", modo: "plantilla", titulo: "Portada", caso: "La portada saluda\n- Muestra Hola mundo" });
      let est = ultimoEstado(registro);
      const carpeta = path.join(raiz, est.carpeta);
      await panel.enviar({ tipo: "e2eConfig", campo: "url", valor: "http://127.0.0.1:" + servidor.address().port + " " });
      await panel.enviar({ tipo: "e2eEjecutar", ids: [] });
      assert.ok(registro.avisos.some(([, m]) => /no hay escenarios con prueba automática/.test(m)));

      // una prueba que ya existe en el proyecto (fuera de la carpeta del plan)
      fs.mkdirSync(path.join(raiz, "tests"), { recursive: true });
      const existente = path.join(raiz, "tests", "portada.spec.ts");
      fs.writeFileSync(existente, "import { test, expect } from '@playwright/test';\ntest('la portada saluda', async ({ page }) => {\n  await page.goto(process.env.E2E_URL);\n  await expect(page.getByRole('heading')).toHaveText('Hola mundo');\n});\n");
      fs.mkdirSync(path.join(carpeta, "e2e"), { recursive: true });
      fs.writeFileSync(path.join(carpeta, "e2e", ".env"), "E2E_URL=http://127.0.0.1:" + servidor.address().port + "\n");
      registro.archivosElegidos = [vscode.Uri.file(existente)];
      await panel.enviar({ tipo: "e2eVincular", id: "E01" });
      // y una del plan, grabada (codegen la deja como 'test')
      fs.writeFileSync(path.join(carpeta, "e2e", "E02.spec.ts"), "import { test, expect } from '@playwright/test';\ntest('test', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.getByRole('heading')).toHaveText('Adiós', { timeout: 1000 });\n});\n");
      registro.entrada = "com.demo.app"; // pide el paquete de la app la primera vez
      await panel.enviar({ tipo: "e2eGrabar", id: "E02", plataforma: "android" }); // abre Maestro Studio en una terminal
      assert.deepStrictEqual(registro.terminales.map((t) => t.textos), [["maestro studio"]]);
      let plan = JSON.parse(fs.readFileSync(path.join(carpeta, "sol.json"), "utf8"));
      assert.strictEqual(plan.e2e.url, "http://127.0.0.1:" + servidor.address().port);
      assert.strictEqual(plan.escenarios[0].automatizacion.archivo, "../../tests/portada.spec.ts");
      assert.strictEqual(plan.escenarios[1].automatizacion.archivo, "e2e/E02.yaml");
      // en realidad era web: lo vinculo
      registro.archivosElegidos = [vscode.Uri.file(path.join(carpeta, "e2e", "E02.spec.ts"))];
      await panel.enviar({ tipo: "e2eVincular", id: "E02" });
      est = ultimoEstado(registro);
      assert.strictEqual(est.plan.escenarios[1].automatizacion.existe, true);

      await panel.enviar({ tipo: "e2eEjecutar", ids: [] });
      plan = JSON.parse(fs.readFileSync(path.join(carpeta, "sol.json"), "utf8"));
      const salida = registro.salida.join("");
      assert.strictEqual(plan.escenarios[0].estado, "paso", salida.slice(-1500));
      assert.strictEqual(plan.escenarios[1].estado, "fallo", salida.slice(-1500));
      assert.ok(plan.escenarios[0].adjuntos.length === 0 || plan.escenarios[0].adjuntos.every((a) => a.archivo.includes("e2e-")));
      assert.ok(plan.escenarios[1].adjuntos.some((a) => a.tipo === "image/png"));
      assert.ok(/Pruebas end-to-end: 1 pasaron, 1 fallaron/.test(ultimoEstado(registro).aviso || [...registro.mensajes].reverse().find((m) => m.aviso).aviso));

      await panel.enviar({ tipo: "e2eQuitar", id: "E01" });
      plan = JSON.parse(fs.readFileSync(path.join(carpeta, "sol.json"), "utf8"));
      assert.strictEqual(plan.escenarios[0].automatizacion, null);
      assert.ok(fs.existsSync(existente), "desunir no borra el archivo");
    } finally {
      servidor.close();
      process.env.APPDATA = antes;
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  },
};
