"use strict";
/**
 * XIX · El Sol — extensión para VS Code y Kiro.
 * Le pasas un caso de desarrollo y arma los escenarios de prueba (Gemini o plantilla),
 * con un estado y evidencias por escenario, y al final genera el informe en PDF.
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const S = require("./nucleo/sol.js");

const CLAVE_SECRETA = "elsol.claveGemini";
const paneles = new Map(); // carpeta del plan → Panel

let contexto;

function activate(context) {
  contexto = context;
  context.subscriptions.push(
    vscode.commands.registerCommand("elsol.nuevo", () => nuevoPlan()),
    vscode.commands.registerCommand("elsol.nuevoDesdeSeleccion", () => nuevoPlan()),
    vscode.commands.registerCommand("elsol.abrir", (uri) => abrir(uri)),
    vscode.commands.registerCommand("elsol.generarPdf", (uri) => generarPdfComando(uri)),
    vscode.commands.registerCommand("elsol.configurarClave", () => configurarClave()),
  );
}

function deactivate() {}

// ---------------------------------------------------------------- ajustes y clave

function ajustes() {
  const c = vscode.workspace.getConfiguration("elsol");
  return {
    carpeta: (c.get("carpeta") || "pruebas").replace(/^[\\/]+|[\\/]+$/g, "") || "pruebas",
    modelo: c.get("modelo") || S.MODELO_POR_DEFECTO,
    cantidad: c.get("cantidad") || "entre 8 y 15 escenarios",
    abrirPdf: c.get("abrirPdfAlTerminar") !== false,
  };
}

/** Clave de Gemini: la de la extensión, o la variable GEMINI_API_KEY, o la que guardó La Justicia. */
async function clave() {
  const propia = await contexto.secrets.get(CLAVE_SECRETA);
  if (propia) return { clave: propia, origen: "guardada en El Sol" };
  return S.leerClaveGuardada();
}

async function configurarClave() {
  const actual = await clave();
  const valor = await vscode.window.showInputBox({
    title: "XIX · El Sol — clave de Gemini",
    prompt: "Pégala desde aistudio.google.com → Get API key. Deja vacío para borrar la guardada en El Sol." + (actual.clave ? " Ahora se usa la " + actual.origen + "." : ""),
    password: true,
    ignoreFocusOut: true,
  });
  if (valor === undefined) return false;
  if (!valor.trim()) {
    await contexto.secrets.delete(CLAVE_SECRETA);
    vscode.window.showInformationMessage("El Sol: clave borrada. " + (S.leerClaveGuardada().clave ? "Se seguirá usando la de " + S.leerClaveGuardada().origen + "." : "Los escenarios se armarán con la plantilla."));
  } else {
    await contexto.secrets.store(CLAVE_SECRETA, valor.trim());
    vscode.window.showInformationMessage("El Sol: clave de Gemini guardada.");
  }
  for (const p of paneles.values()) p.enviarEstado();
  return true;
}

// ---------------------------------------------------------------- carpetas

function carpetaRaiz() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (wf) return wf.uri.fsPath;
  }
  const wfs = vscode.workspace.workspaceFolders || [];
  return wfs.length ? wfs[0].uri.fsPath : null;
}

function raicesDePruebas() {
  return (vscode.workspace.workspaceFolders || []).map((wf) => path.join(wf.uri.fsPath, ajustes().carpeta));
}

/** Acepta el sol.json, la carpeta del plan o cualquier archivo dentro de ella. */
function carpetaDePlan(fsPath) {
  let actual = fsPath;
  try {
    if (fs.statSync(actual).isFile()) actual = path.dirname(actual);
  } catch (e) {
    return null;
  }
  for (let i = 0; i < 3 && actual; i++) {
    if (fs.existsSync(path.join(actual, S.ARCHIVO_PLAN))) return actual;
    actual = path.dirname(actual);
  }
  return null;
}

async function elegirPlan(titulo) {
  const planes = raicesDePruebas().flatMap((r) => S.listarPlanes(r));
  if (!planes.length) {
    const b = await vscode.window.showInformationMessage("El Sol: aún no hay planes de prueba en la carpeta «" + ajustes().carpeta + "».", "Crear uno");
    if (b) nuevoPlan();
    return null;
  }
  const item = await vscode.window.showQuickPick(
    planes.map((p) => ({
      label: p.titulo,
      description: p.resumen ? p.resumen.revisados + "/" + p.resumen.total + " revisados · " + S.VEREDICTOS[p.resumen.veredicto] : "",
      detail: vscode.workspace.asRelativePath(p.carpeta),
      carpeta: p.carpeta,
    })),
    { title: titulo, placeHolder: "Elige un plan de pruebas", matchOnDetail: true },
  );
  return item ? item.carpeta : null;
}

// ---------------------------------------------------------------- comandos

function nuevoPlan() {
  const raiz = carpetaRaiz();
  if (!raiz) {
    vscode.window.showWarningMessage("El Sol: abre la carpeta de tu proyecto primero; los planes se guardan dentro de él, en «" + ajustes().carpeta + "».");
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const seleccion = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
  Panel.nuevo(raiz, seleccion);
}

async function abrir(uri) {
  const carpeta = uri && uri.fsPath ? carpetaDePlan(uri.fsPath) : await elegirPlan("XIX · El Sol — abrir plan de pruebas");
  if (!carpeta) {
    if (uri) vscode.window.showWarningMessage("El Sol: esa carpeta no tiene un " + S.ARCHIVO_PLAN + ".");
    return;
  }
  Panel.abrir(carpeta);
}

async function generarPdfComando(uri) {
  const carpeta = uri && uri.fsPath ? carpetaDePlan(uri.fsPath) : await elegirPlan("XIX · El Sol — generar el PDF");
  if (!carpeta) return;
  const panel = paneles.get(carpeta);
  if (panel) return panel.pdf();
  return generarPdf(carpeta);
}

async function generarPdf(carpeta) {
  const informe = require("./nucleo/informe.js");
  try {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "El Sol: generando el PDF…" },
      () => informe.generarInforme(carpeta),
    );
    const extra = r.adjuntados ? " · " + r.adjuntados + (r.adjuntados === 1 ? " archivo adjunto" : " archivos adjuntos") + " dentro del PDF" : "";
    const msj = "El Sol: PDF listo (" + r.paginas + (r.paginas === 1 ? " página" : " páginas") + ", " + S.VEREDICTOS[r.resumen.veredicto].toLowerCase() + ")" + extra + ".";
    const abrirLo = ajustes().abrirPdf;
    if (abrirLo) vscode.env.openExternal(vscode.Uri.file(r.ruta));
    vscode.window.showInformationMessage(msj, abrirLo ? "Mostrar en la carpeta" : "Abrir PDF", "Mostrar en la carpeta").then((b) => {
      if (b === "Abrir PDF") vscode.env.openExternal(vscode.Uri.file(r.ruta));
      else if (b === "Mostrar en la carpeta") vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(r.ruta));
    });
    return r;
  } catch (e) {
    vscode.window.showErrorMessage("El Sol: no pude generar el PDF. " + e.message);
    return null;
  }
}

// ---------------------------------------------------------------- panel

class Panel {
  /** Panel para crear un plan nuevo (todavía sin carpeta). */
  static nuevo(raizProyecto, casoInicial) {
    const panel = new Panel(null, raizProyecto);
    panel.borrador = { caso: casoInicial || "" };
    panel.enviarEstado();
    return panel;
  }

  static abrir(carpeta) {
    const existente = paneles.get(carpeta);
    if (existente) {
      existente.web.reveal();
      return existente;
    }
    const panel = new Panel(carpeta, null);
    panel.enviarEstado();
    return panel;
  }

  constructor(carpeta, raizProyecto) {
    this.carpeta = carpeta;
    this.raizProyecto = raizProyecto;
    this.plan = null;
    this.ultimoGuardado = "";
    this.ocupado = false;
    const media = vscode.Uri.file(path.join(contexto.extensionPath, "media"));
    this.web = vscode.window.createWebviewPanel("elsol.plan", "XIX · El Sol", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media].concat(carpeta ? [vscode.Uri.file(carpeta)] : []),
    });
    this.web.iconPath = vscode.Uri.file(path.join(contexto.extensionPath, "media", "sol.svg"));
    this.web.webview.html = this.html();
    this.web.webview.onDidReceiveMessage((m) => this.recibir(m).catch((e) => this.error(e)));
    this.web.onDidDispose(() => this.cerrar());
    if (carpeta) this.vincular(carpeta);
  }

  /** Une el panel con la carpeta del plan: lo lee y vigila cambios de afuera (git pull, otro editor). */
  vincular(carpeta) {
    this.carpeta = carpeta;
    paneles.set(carpeta, this);
    this.web.webview.options = Object.assign({}, this.web.webview.options, {
      localResourceRoots: [vscode.Uri.file(path.join(contexto.extensionPath, "media")), vscode.Uri.file(carpeta)],
    });
    this.leer();
    const patron = new vscode.RelativePattern(vscode.Uri.file(carpeta), S.ARCHIVO_PLAN);
    this.vigia = vscode.workspace.createFileSystemWatcher(patron);
    const recargar = () => {
      try {
        const txt = fs.readFileSync(S.rutaPlan(carpeta), "utf8");
        if (txt === this.ultimoGuardado) return;
        this.leer();
        this.enviarEstado();
      } catch (e) { /* lo borraron o está a medio escribir */ }
    };
    this.vigia.onDidChange(recargar);
    this.vigia.onDidCreate(recargar);
  }

  leer() {
    this.plan = S.leerPlan(this.carpeta);
    this.ultimoGuardado = fs.readFileSync(S.rutaPlan(this.carpeta), "utf8");
    this.web.title = "☀ " + this.plan.titulo;
  }

  guardar() {
    this.plan = S.guardarPlan(this.carpeta, this.plan);
    this.ultimoGuardado = fs.readFileSync(S.rutaPlan(this.carpeta), "utf8");
    this.web.title = "☀ " + this.plan.titulo;
  }

  cerrar() {
    if (this.carpeta && paneles.get(this.carpeta) === this) paneles.delete(this.carpeta);
    if (this.vigia) this.vigia.dispose();
  }

  error(e) {
    this.ocupado = false;
    vscode.window.showErrorMessage("El Sol: " + (e && e.message ? e.message : String(e)));
    this.enviarEstado();
  }

  uriAdjunto(archivo) {
    const ruta = S.rutaAdjunto(this.carpeta, archivo);
    if (!ruta) return "";
    let v = "";
    try { v = "?v=" + fs.statSync(ruta).mtimeMs; } catch (e) { return ""; }
    return this.web.webview.asWebviewUri(vscode.Uri.file(ruta)).toString() + v;
  }

  async enviarEstado(extra) {
    const c = await clave();
    const base = {
      tipo: "estado",
      ocupado: this.ocupado,
      clave: c.clave ? c.origen : "",
      modelo: ajustes().modelo,
      estados: S.ESTADOS,
      tipos: S.TIPOS,
      prioridades: S.PRIORIDADES,
      veredictos: S.VEREDICTOS,
    };
    if (!this.plan) {
      this.web.webview.postMessage(Object.assign(base, { modo: "nuevo", borrador: this.borrador || {}, destino: path.join(path.basename(this.raizProyecto || ""), ajustes().carpeta) }, extra));
      return;
    }
    const plan = JSON.parse(JSON.stringify(this.plan));
    for (const e of plan.escenarios) for (const a of e.adjuntos) {
      a.uri = this.uriAdjunto(a.archivo);
      a.imagen = /^image\//.test(a.tipo) && a.tipo !== "image/svg+xml";
    }
    const pdf = path.join(this.carpeta, path.basename(this.carpeta) + ".pdf");
    this.web.webview.postMessage(Object.assign(base, {
      modo: "plan",
      plan,
      carpeta: vscode.workspace.asRelativePath(this.carpeta),
      hayPdf: fs.existsSync(pdf),
    }, extra));
  }

  escenario(id) {
    const e = this.plan.escenarios.find((x) => x.id === id);
    if (!e) throw new Error("El escenario " + id + " ya no existe.");
    return e;
  }

  async recibir(m) {
    switch (m.tipo) {
      case "listo":
        return this.enviarEstado();

      case "configurarClave":
        return configurarClave();

      case "crear":
        return this.crear(m);

      case "campoPlan": {
        if (!["titulo", "caso", "responsable"].includes(m.campo)) return;
        this.plan[m.campo] = String(m.valor || "");
        this.guardar();
        return;
      }

      case "campo": {
        const permitidos = ["titulo", "tipo", "prioridad", "precondiciones", "pasos", "esperado", "estado", "observacion"];
        if (!permitidos.includes(m.campo)) return;
        const e = this.escenario(m.id);
        e[m.campo] = m.campo === "pasos" ? String(m.valor || "").split("\n") : m.valor;
        this.guardar();
        if (m.campo === "estado" || m.campo === "tipo" || m.campo === "prioridad") return this.enviarEstado();
        return;
      }

      case "agregarEscenario": {
        const e = S.nuevoEscenario(this.plan, { titulo: "Nuevo escenario", tipo: "otro", prioridad: "media" });
        this.guardar();
        return this.enviarEstado({ enfocar: e.id });
      }

      case "duplicarEscenario": {
        const o = this.escenario(m.id);
        const e = S.nuevoEscenario(this.plan, { titulo: o.titulo + " (copia)", tipo: o.tipo, prioridad: o.prioridad, precondiciones: o.precondiciones, pasos: o.pasos, esperado: o.esperado });
        // queda justo debajo del original
        this.plan.escenarios.splice(this.plan.escenarios.indexOf(e), 1);
        this.plan.escenarios.splice(this.plan.escenarios.indexOf(o) + 1, 0, e);
        this.guardar();
        return this.enviarEstado({ enfocar: e.id });
      }

      case "quitarEscenario": {
        const e = this.escenario(m.id);
        const aviso = e.adjuntos.length ? " y sus " + e.adjuntos.length + " evidencias" : "";
        const b = await vscode.window.showWarningMessage("¿Quitar " + e.id + " «" + e.titulo + "»" + aviso + "?", { modal: true }, "Quitar");
        if (b !== "Quitar") return;
        S.quitarEscenario(this.carpeta, this.plan, m.id);
        this.guardar();
        return this.enviarEstado();
      }

      case "mover": {
        const lista = this.plan.escenarios;
        const i = lista.findIndex((x) => x.id === m.id);
        const j = i + (m.dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= lista.length) return;
        [lista[i], lista[j]] = [lista[j], lista[i]];
        this.guardar();
        return this.enviarEstado();
      }

      case "elegirAdjuntos": {
        const e = this.escenario(m.id);
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: "Adjuntar a " + e.id,
          title: "Evidencias para " + e.id + " · " + e.titulo,
        });
        if (!uris || !uris.length) return;
        const fallos = [];
        for (const u of uris) {
          try {
            S.agregarAdjunto(this.carpeta, this.plan, e.id, path.basename(u.fsPath), fs.readFileSync(u.fsPath));
          } catch (err) { fallos.push(path.basename(u.fsPath) + ": " + err.message); }
        }
        this.guardar();
        if (fallos.length) vscode.window.showWarningMessage("El Sol: " + fallos.join(" · "));
        return this.enviarEstado();
      }

      case "adjuntarDatos": {
        // archivos pegados o arrastrados en el panel (llegan en base64)
        const e = this.escenario(m.id);
        const fallos = [];
        for (const a of m.archivos || []) {
          try {
            const nombre = a.nombre || "captura-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
            S.agregarAdjunto(this.carpeta, this.plan, e.id, nombre, Buffer.from(String(a.base64 || ""), "base64"));
          } catch (err) { fallos.push((a.nombre || "archivo") + ": " + err.message); }
        }
        this.guardar();
        if (fallos.length) vscode.window.showWarningMessage("El Sol: " + fallos.join(" · "));
        return this.enviarEstado();
      }

      case "quitarAdjunto": {
        S.quitarAdjunto(this.carpeta, this.plan, m.id, m.archivo);
        this.guardar();
        return this.enviarEstado();
      }

      case "abrirAdjunto": {
        const ruta = S.rutaAdjunto(this.carpeta, m.archivo);
        if (ruta && fs.existsSync(ruta)) {
          const uri = vscode.Uri.file(ruta);
          if (/\.(txt|log|json|xml|csv|md|har|html)$/i.test(ruta)) vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.Beside });
          else vscode.commands.executeCommand("vscode.open", uri, vscode.ViewColumn.Beside);
        }
        return;
      }

      case "pedirMas": {
        const indicacion = await vscode.window.showInputBox({
          title: "XIX · El Sol — más escenarios",
          prompt: "¿En qué deben enfocarse los escenarios nuevos? (opcional; Enter para seguir)",
          placeHolder: "Ej.: accesibilidad, datos en inglés, sin conexión…",
          ignoreFocusOut: true,
        });
        if (indicacion === undefined) return;
        return this.mas(indicacion);
      }

      case "mas":
        return this.mas(m.indicacion);

      case "pdf":
        return this.pdf();

      case "abrirPdf": {
        const pdf = path.join(this.carpeta, path.basename(this.carpeta) + ".pdf");
        if (fs.existsSync(pdf)) vscode.env.openExternal(vscode.Uri.file(pdf));
        return;
      }

      case "mostrarCarpeta":
        return vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(S.rutaPlan(this.carpeta)));

      case "abrirJson":
        return vscode.window.showTextDocument(vscode.Uri.file(S.rutaPlan(this.carpeta)), { viewColumn: vscode.ViewColumn.Beside });
    }
  }

  async crear(m) {
    const caso = String(m.caso || "").trim();
    if (!caso) { vscode.window.showWarningMessage("El Sol: escribe o pega el caso de desarrollo."); return; }
    const titulo = String(m.titulo || "").trim() || caso.split("\n")[0].replace(/^(historia|caso|hu|us)\s*[:\-–]\s*/i, "").slice(0, 80);
    this.borrador = { caso, titulo };
    this.ocupado = true;
    await this.enviarEstado();
    let r;
    if (m.modo === "plantilla") {
      r = { escenarios: S.plantillaPorReglas(caso), fuente: "plantilla", aviso: null };
    } else {
      const c = await clave();
      r = await S.generarEscenarios(caso, { clave: c.clave, modelo: ajustes().modelo, cantidad: ajustes().cantidad, indicacion: m.indicacion });
    }
    const git = S.datosGit(this.raizProyecto);
    const carpeta = S.crearCarpetaPlan(path.join(this.raizProyecto, ajustes().carpeta), titulo);
    S.guardarPlan(carpeta, { titulo, caso, fuente: r.fuente, responsable: git.autor, escenarios: r.escenarios });
    this.ocupado = false;
    this.vincular(carpeta);
    await this.enviarEstado({ aviso: r.aviso });
    if (r.aviso) vscode.window.showWarningMessage("El Sol: " + r.aviso);
  }

  async mas(indicacion) {
    this.ocupado = true;
    await this.enviarEstado();
    try {
      const c = await clave();
      const r = await S.generarEscenarios(this.plan.caso, {
        clave: c.clave,
        modelo: ajustes().modelo,
        existentes: this.plan.escenarios.map((e) => e.titulo),
        indicacion,
      });
      const agregados = S.sumarEscenarios(this.plan, r.escenarios);
      if (agregados.length && r.fuente !== this.plan.fuente) this.plan.fuente = "mixta";
      this.guardar();
      this.ocupado = false;
      const aviso = agregados.length ? (r.aviso ? r.aviso + " " : "") + "Se agregaron " + agregados.length + " escenarios." : (r.aviso ? r.aviso + " " : "") + "No salieron escenarios nuevos que no estuvieran ya.";
      await this.enviarEstado({ aviso, enfocar: agregados.length ? agregados[0].id : null });
    } finally {
      this.ocupado = false;
    }
  }

  async pdf() {
    this.ocupado = true;
    await this.enviarEstado();
    try {
      await generarPdf(this.carpeta);
    } finally {
      this.ocupado = false;
      await this.enviarEstado();
    }
  }

  html() {
    const w = this.web.webview;
    const nonce = crypto.randomBytes(16).toString("base64");
    const recurso = (f) => w.asWebviewUri(vscode.Uri.file(path.join(contexto.extensionPath, "media", f)));
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data: blob:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${recurso("panel.css")}">
<title>XIX · El Sol</title>
</head>
<body>
<main id="app" aria-live="polite"><p class="cargando">Cargando…</p></main>
<script nonce="${nonce}" src="${recurso("panel.js")}"></script>
</body>
</html>`;
  }
}

module.exports = { activate, deactivate, _Panel: Panel, _paneles: paneles };
