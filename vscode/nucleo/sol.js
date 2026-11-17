"use strict";
/**
 * XIX · El Sol — núcleo sin dependencias (Node 18+).
 *
 * Un plan de pruebas vive en una carpeta del repositorio:
 *   pruebas/<fecha>-<titulo>/
 *     sol.json        ← el caso, los escenarios, sus estados y observaciones
 *     adjuntos/       ← evidencias de cada escenario (E03-01-captura.png …)
 *     <carpeta>.pdf   ← el informe (se vuelve a generar cuando quieras)
 *
 * Este archivo no conoce VS Code: lo usan la extensión, la línea de comandos y las pruebas.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");

const VERSION_FORMATO = 1;
const ARCHIVO_PLAN = "sol.json";
const CARPETA_ADJUNTOS = "adjuntos";
const MODELO_POR_DEFECTO = "gemini-3.5-flash-lite";
const MAX_ADJUNTO = 25 * 1024 * 1024; // 25 MB por archivo

const ESTADOS = {
  pendiente: { etiqueta: "Pendiente", corto: "Pend." },
  paso: { etiqueta: "Pasó", corto: "Pasó" },
  fallo: { etiqueta: "Falló", corto: "Falló" },
  bloqueado: { etiqueta: "Bloqueado", corto: "Bloq." },
  "no-aplica": { etiqueta: "No aplica", corto: "N/A" },
};

const TIPOS = {
  feliz: "Camino feliz",
  validacion: "Validación",
  borde: "Caso borde",
  error: "Manejo de errores",
  permisos: "Permisos y seguridad",
  ui: "Interfaz y usabilidad",
  rendimiento: "Rendimiento",
  regresion: "Regresión",
  otro: "Otro",
};

const PRIORIDADES = { alta: "Alta", media: "Media", baja: "Baja" };

// ---------------------------------------------------------------- utilidades

function ahora() {
  return new Date().toISOString();
}

/** "Inicio de sesión con Google" → "inicio-de-sesion-con-google" */
function slug(texto, max) {
  const s = String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (s || "caso").slice(0, max || 50).replace(/-+$/, "");
}

/** Nombre de archivo seguro para Windows, Linux y Mac (conserva la extensión). */
function nombreSeguro(nombre) {
  const base = path.basename(String(nombre || "archivo"));
  const ext = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const sinExt = base.slice(0, base.length - path.extname(base).length);
  return slug(sinExt, 40) + (ext || "");
}

function fechaCorta(d) {
  const f = d ? new Date(d) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return f.getFullYear() + "-" + p(f.getMonth() + 1) + "-" + p(f.getDate());
}

function escribirAtomico(archivo, contenido) {
  const tmp = archivo + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, archivo);
}

function texto(v, max) {
  return String(v == null ? "" : v).replace(/\r\n?/g, "\n").trim().slice(0, max || 4000);
}

// ---------------------------------------------------------------- plan

function idEscenario(n) {
  return "E" + String(n).padStart(2, "0");
}

/** Deja un escenario con todos sus campos y valores válidos. */
function normalizarEscenario(e, id) {
  const x = e && typeof e === "object" ? e : {};
  let pasos = Array.isArray(x.pasos) ? x.pasos : typeof x.pasos === "string" ? x.pasos.split(/\n+/) : [];
  pasos = pasos.map((p) => texto(p, 600).replace(/^\s*(\d+[.)]|[-*•])\s*/, "")).filter(Boolean).slice(0, 30);
  const adjuntos = (Array.isArray(x.adjuntos) ? x.adjuntos : [])
    .filter((a) => a && typeof a.archivo === "string" && !a.archivo.includes(".."))
    .map((a) => ({
      archivo: a.archivo.replace(/\\/g, "/"),
      nombre: texto(a.nombre || path.basename(a.archivo), 200),
      tipo: texto(a.tipo, 100) || tipoMime(a.archivo),
      bytes: Number.isFinite(a.bytes) ? a.bytes : 0,
      agregado: a.agregado || ahora(),
    }));
  return {
    id: /^E\d{2,3}$/.test(x.id) ? x.id : id,
    titulo: texto(x.titulo, 200) || "Escenario sin título",
    tipo: TIPOS[x.tipo] ? x.tipo : "otro",
    prioridad: PRIORIDADES[x.prioridad] ? x.prioridad : "media",
    precondiciones: texto(x.precondiciones, 1500),
    pasos,
    esperado: texto(x.esperado, 1500),
    estado: ESTADOS[x.estado] ? x.estado : "pendiente",
    observacion: texto(x.observacion, 4000),
    adjuntos,
    automatizacion: require("./e2e.js").normalizarAutomatizacion(x.automatizacion),
  };
}

/** Renumera E01, E02… sin perder los adjuntos (los ids viejos se quedan si ya existían y no chocan). */
function normalizarPlan(p) {
  const x = p && typeof p === "object" ? p : {};
  const vistos = new Set();
  let n = 0;
  const escenarios = (Array.isArray(x.escenarios) ? x.escenarios : []).map((e) => {
    n++;
    let esc = normalizarEscenario(e, idEscenario(n));
    if (vistos.has(esc.id)) esc.id = siguienteId(vistos);
    vistos.add(esc.id);
    return esc;
  });
  return {
    version: VERSION_FORMATO,
    titulo: texto(x.titulo, 200) || "Plan de pruebas",
    caso: texto(x.caso, 20000),
    creado: x.creado || ahora(),
    actualizado: x.actualizado || ahora(),
    fuente: x.fuente === "gemini" ? "gemini" : x.fuente === "mixta" ? "mixta" : "plantilla",
    responsable: texto(x.responsable, 120),
    e2e: require("./e2e.js").normalizarConfig(x.e2e),
    escenarios,
  };
}

function siguienteId(usados) {
  let n = 1;
  while (usados.has(idEscenario(n))) n++;
  return idEscenario(n);
}

function rutaPlan(carpeta) {
  return path.join(carpeta, ARCHIVO_PLAN);
}

function leerPlan(carpeta) {
  const crudo = JSON.parse(fs.readFileSync(rutaPlan(carpeta), "utf8"));
  return normalizarPlan(crudo);
}

function guardarPlan(carpeta, plan) {
  const limpio = normalizarPlan(plan);
  limpio.actualizado = ahora();
  fs.mkdirSync(carpeta, { recursive: true });
  escribirAtomico(rutaPlan(carpeta), JSON.stringify(limpio, null, 2) + "\n");
  return limpio;
}

/** Crea pruebas/<fecha>-<titulo>/ (sin pisar una carpeta existente). */
function crearCarpetaPlan(raiz, titulo, fecha) {
  const base = fechaCorta(fecha) + "-" + slug(titulo, 45);
  let nombre = base;
  let i = 2;
  while (fs.existsSync(path.join(raiz, nombre))) nombre = base + "-" + i++;
  const carpeta = path.join(raiz, nombre);
  fs.mkdirSync(path.join(carpeta, CARPETA_ADJUNTOS), { recursive: true });
  return carpeta;
}

/** Busca planes (carpetas con sol.json) dentro de la raíz de pruebas. */
function listarPlanes(raiz) {
  if (!fs.existsSync(raiz)) return [];
  return fs.readdirSync(raiz, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(raiz, d.name, ARCHIVO_PLAN)))
    .map((d) => {
      const carpeta = path.join(raiz, d.name);
      try {
        const p = leerPlan(carpeta);
        return { carpeta, titulo: p.titulo, actualizado: p.actualizado, resumen: resumen(p) };
      } catch (e) {
        return { carpeta, titulo: d.name + " (sol.json dañado)", actualizado: "", resumen: null, error: e.message };
      }
    })
    .sort((a, b) => String(b.actualizado).localeCompare(String(a.actualizado)));
}

function resumen(plan) {
  const r = { total: 0, pendiente: 0, paso: 0, fallo: 0, bloqueado: 0, "no-aplica": 0, adjuntos: 0 };
  for (const e of plan.escenarios) {
    r.total++;
    r[e.estado]++;
    r.adjuntos += e.adjuntos.length;
  }
  r.revisados = r.total - r.pendiente;
  r.aplicables = r.total - r["no-aplica"];
  if (r.total === 0) r.veredicto = "vacio";
  else if (r.fallo > 0) r.veredicto = "fallos";
  else if (r.pendiente > 0 || r.bloqueado > 0) r.veredicto = "incompleto";
  else r.veredicto = "aprobado";
  return r;
}

const VEREDICTOS = {
  vacio: "Sin escenarios",
  fallos: "Con fallos",
  incompleto: "Incompleto",
  aprobado: "Aprobado",
};

// ---------------------------------------------------------------- adjuntos

const MIMES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain",
  ".json": "application/json", ".xml": "application/xml", ".csv": "text/csv", ".html": "text/html", ".md": "text/markdown",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".zip": "application/zip", ".har": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function tipoMime(nombre) {
  return MIMES[path.extname(String(nombre)).toLowerCase()] || "application/octet-stream";
}

function esImagenIncrustable(adj) {
  return /^image\/(png|jpeg)$/.test(adj.tipo) || /\.(png|jpe?g)$/i.test(adj.archivo);
}

/**
 * Copia una evidencia a adjuntos/ con un nombre como E03-02-captura.png y la anota en el escenario.
 * datos: Buffer. Devuelve el adjunto agregado.
 */
function agregarAdjunto(carpeta, plan, idEsc, nombreOriginal, datos) {
  const esc = plan.escenarios.find((e) => e.id === idEsc);
  if (!esc) throw new Error("No existe el escenario " + idEsc);
  if (!Buffer.isBuffer(datos)) throw new Error("El adjunto llegó vacío");
  if (datos.length > MAX_ADJUNTO) throw new Error("El archivo pasa de 25 MB; guárdalo aparte y anota la ruta en la observación");
  const dir = path.join(carpeta, CARPETA_ADJUNTOS);
  fs.mkdirSync(dir, { recursive: true });
  const limpio = nombreSeguro(nombreOriginal);
  const usados = new Set(fs.readdirSync(dir).filter((f) => f.startsWith(idEsc + "-")).map((f) => f.slice(0, idEsc.length + 3)));
  let n = esc.adjuntos.length + 1;
  while (usados.has(idEsc + "-" + String(n).padStart(2, "0"))) n++;
  let nombre;
  do {
    nombre = idEsc + "-" + String(n++).padStart(2, "0") + "-" + limpio;
  } while (fs.existsSync(path.join(dir, nombre)));
  fs.writeFileSync(path.join(dir, nombre), datos);
  const adj = {
    archivo: CARPETA_ADJUNTOS + "/" + nombre,
    nombre: texto(path.basename(String(nombreOriginal || nombre)), 200),
    tipo: tipoMime(nombre),
    bytes: datos.length,
    agregado: ahora(),
  };
  esc.adjuntos.push(adj);
  return adj;
}

/** Quita el adjunto del escenario y borra el archivo (solo si está dentro de adjuntos/). */
function quitarAdjunto(carpeta, plan, idEsc, archivo) {
  const esc = plan.escenarios.find((e) => e.id === idEsc);
  if (!esc) return false;
  const i = esc.adjuntos.findIndex((a) => a.archivo === archivo);
  if (i < 0) return false;
  esc.adjuntos.splice(i, 1);
  const ruta = rutaAdjunto(carpeta, archivo);
  const enUso = plan.escenarios.some((e) => e.adjuntos.some((a) => a.archivo === archivo));
  if (ruta && !enUso && fs.existsSync(ruta)) fs.unlinkSync(ruta);
  return true;
}

/** Ruta absoluta de un adjunto, o null si intenta salir de la carpeta del plan. */
function rutaAdjunto(carpeta, archivo) {
  const ruta = path.resolve(carpeta, String(archivo || ""));
  const base = path.resolve(carpeta, CARPETA_ADJUNTOS) + path.sep;
  return ruta.startsWith(base) ? ruta : null;
}

/** Quita el escenario y sus archivos. */
function quitarEscenario(carpeta, plan, idEsc) {
  const i = plan.escenarios.findIndex((e) => e.id === idEsc);
  if (i < 0) return false;
  const [esc] = plan.escenarios.splice(i, 1);
  for (const a of esc.adjuntos) {
    const ruta = rutaAdjunto(carpeta, a.archivo);
    if (ruta && fs.existsSync(ruta)) fs.unlinkSync(ruta);
  }
  return true;
}

function nuevoEscenario(plan, datos) {
  const usados = new Set(plan.escenarios.map((e) => e.id));
  const esc = normalizarEscenario(Object.assign({ titulo: "Nuevo escenario", tipo: "otro" }, datos), siguienteId(usados));
  esc.id = siguienteId(usados);
  plan.escenarios.push(esc);
  return esc;
}

// ---------------------------------------------------------------- git

/** Rama, commit, autor y remoto del repositorio donde está la carpeta (todo opcional). */
function datosGit(carpeta) {
  const correr = (args) => {
    try {
      return execFileSync("git", args, { cwd: carpeta, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }).trim();
    } catch (e) {
      return "";
    }
  };
  const remoto = correr(["config", "--get", "remote.origin.url"]).replace(/\/\/[^@/]+@/, "//");
  return {
    rama: correr(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: correr(["rev-parse", "--short", "HEAD"]),
    autor: correr(["config", "user.name"]),
    remoto,
    repositorio: remoto ? remoto.replace(/\.git$/, "").split(/[/:]/).pop() : path.basename(correr(["rev-parse", "--show-toplevel"]) || ""),
  };
}

// ---------------------------------------------------------------- clave de Gemini

/** Archivo de configuración compartido con La Justicia: si ya guardaste la clave allá, El Sol la usa. */
function rutasConfig() {
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  return { sol: path.join(base, "ElSol", "config.json"), justicia: path.join(base, "Justicia", "config.json") };
}

function leerClaveGuardada() {
  if (process.env.GEMINI_API_KEY) return { clave: process.env.GEMINI_API_KEY, origen: "variable GEMINI_API_KEY" };
  const r = rutasConfig();
  for (const [origen, archivo] of [["El Sol", r.sol], ["La Justicia", r.justicia]]) {
    try {
      const c = JSON.parse(fs.readFileSync(archivo, "utf8"));
      if (c && c.clave) return { clave: String(c.clave), origen: "configuración de " + origen, modelo: c.modelo };
    } catch (e) { /* no existe */ }
  }
  return { clave: "", origen: "" };
}

function guardarClave(clave, modelo) {
  const archivo = rutasConfig().sol;
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const datos = { clave: String(clave || "").trim() };
  if (modelo) datos.modelo = modelo;
  escribirAtomico(archivo, JSON.stringify(datos, null, 2));
  return archivo;
}

// ---------------------------------------------------------------- escenarios con Gemini

const ESQUEMA_GEMINI = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      titulo: { type: "STRING" },
      tipo: { type: "STRING", enum: Object.keys(TIPOS) },
      prioridad: { type: "STRING", enum: Object.keys(PRIORIDADES) },
      precondiciones: { type: "STRING" },
      pasos: { type: "ARRAY", items: { type: "STRING" } },
      esperado: { type: "STRING" },
    },
    required: ["titulo", "tipo", "prioridad", "pasos", "esperado"],
  },
};

function instruccionesGemini(caso, opciones) {
  const o = opciones || {};
  const existentes = (o.existentes || []).map((t, i) => (i + 1) + ". " + t);
  const cantidad = existentes.length ? "entre 3 y 6 escenarios NUEVOS" : (o.cantidad || "entre 8 y 15 escenarios");
  return [
    "Eres un analista de QA con experiencia. A partir del caso de desarrollo de abajo, arma " + cantidad + " de prueba manual en español.",
    "",
    "Cubre, según aplique: camino feliz (feliz), validaciones de datos (validacion), casos borde y límites (borde),",
    "errores de red, servidor o datos (error), permisos y seguridad (permisos), interfaz (ui), rendimiento y regresión.",
    "No inventes funciones que el caso no menciona; si algo es ambiguo, escribe el escenario para aclararlo.",
    "",
    "Cada escenario:",
    "- titulo: corto y concreto (máx. 90 caracteres), sin numerar.",
    "- tipo: feliz | validacion | borde | error | permisos | ui | rendimiento | regresion | otro.",
    "- prioridad: alta (bloquea el uso o pierde datos) | media | baja.",
    "- precondiciones: estado inicial y datos necesarios (puede ir vacío).",
    "- pasos: acciones que hace el probador, una por elemento, sin numerar, de 2 a 8 pasos.",
    "- esperado: lo que se debe ver o pasar, verificable.",
    "",
    existentes.length ? "Ya existen estos escenarios; NO los repitas ni los reformules:\n" + existentes.join("\n") + "\n" : "",
    o.indicacion ? "Indicación extra del probador: " + texto(o.indicacion, 500) + "\n" : "",
    "Caso de desarrollo:",
    '"""',
    texto(caso, 15000),
    '"""',
  ].join("\n");
}

function extraerJson(t) {
  const limpio = String(t || "").replace(/^```[a-z]*\s*|```\s*$/gim, "").trim();
  try {
    return JSON.parse(limpio);
  } catch (e) {
    const i = limpio.indexOf("[");
    const f = limpio.lastIndexOf("]");
    if (i >= 0 && f > i) return JSON.parse(limpio.slice(i, f + 1));
    throw e;
  }
}

/** Texto de un error de red con su causa ("fetch failed (ECONNRESET …)"). */
function mensajeRed(e) {
  const c = e && e.cause;
  const causa = c ? [c.code, c.message].filter(Boolean).join(" ") : "";
  return String(e && e.message) + (causa ? " (" + causa + ")" : "");
}

/**
 * fetch con respaldo: si la conexión dentro de VS Code falla (VS Code envuelve las conexiones de las
 * extensiones por el proxy y los certificados, y a veces eso es lo que se cae), se repite la petición
 * en un proceso Node aparte (peticion.js). o: { fetch, respaldo, espera }.
 */
async function fetchConRespaldo(url, init, o) {
  const opc = o || {};
  const hacerFetch = opc.fetch || globalThis.fetch;
  try {
    return await hacerFetch(url, init);
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    if (opc.fetch && !opc.respaldo) throw e;
    const r = await (opc.respaldo || peticionAparte)({ url, method: init.method, headers: init.headers, body: init.body, esperaMs: opc.espera || 60000 });
    if (r.error) throw new Error("sin conexión con Gemini: " + r.error + (r.causa ? " (" + r.causa + ")" : "") + "; dentro de VS Code: " + mensajeRed(e));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, porRespaldo: true, text: async () => r.cuerpo, json: async () => JSON.parse(r.cuerpo) };
  }
}

/** Corre peticion.js con el Node de VS Code (Electron en modo Node) o el node actual. */
function peticionAparte(p) {
  return new Promise((resolve) => {
    let salida = "";
    let hijo;
    try {
      hijo = spawn(process.execPath, [path.join(__dirname, "peticion.js")], {
        env: Object.assign({}, process.env, process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        windowsHide: true,
      });
    } catch (e) { return resolve({ error: e.message }); }
    hijo.stdout.on("data", (d) => { salida += d; });
    hijo.on("error", (e) => resolve({ error: e.message }));
    hijo.on("close", () => {
      try { resolve(JSON.parse(salida)); } catch (e) { resolve({ error: "el proceso aparte no respondió" }); }
    });
    hijo.stdin.end(JSON.stringify(p));
  });
}

/**
 * Pide los escenarios a Gemini. Si no hay clave, falla o responde mal, usa la plantilla por reglas.
 * opciones: { clave, modelo, fetch, existentes: [títulos], indicacion, cantidad }
 * Devuelve { escenarios, fuente: "gemini"|"plantilla", aviso }.
 */
async function generarEscenarios(caso, opciones) {
  const o = opciones || {};
  const respaldo = () => plantillaPorReglas(caso, { existentes: o.existentes });
  if (!texto(caso)) return { escenarios: [], fuente: "plantilla", aviso: "Escribe el caso de desarrollo primero." };
  if (!o.clave) return { escenarios: respaldo(), fuente: "plantilla", aviso: "Sin clave de Gemini: escenarios armados con la plantilla." };
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(o.modelo || MODELO_POR_DEFECTO) + ":generateContent";
  const control = typeof AbortController === "function" ? new AbortController() : null;
  const reloj = control ? setTimeout(() => control.abort(), o.espera || 60000) : null;
  try {
    const r = await fetchConRespaldo(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": o.clave },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: instruccionesGemini(caso, o) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: "application/json", responseSchema: ESQUEMA_GEMINI },
      }),
      signal: control ? control.signal : undefined,
    }, o);
    if (!r.ok) {
      const motivo = r.status === 429 ? "Gemini llegó al límite gratuito por ahora"
        : r.status === 400 || r.status === 403 ? "Gemini rechazó la clave o el modelo"
        : r.status >= 500 ? "Gemini no está disponible en este momento (" + r.status + ")"
        : "Gemini respondió " + r.status;
      return { escenarios: respaldo(), fuente: "plantilla", aviso: motivo + ": escenarios armados con la plantilla." };
    }
    const j = await r.json();
    const cand = j && j.candidates && j.candidates[0];
    const crudo = cand && cand.content && (cand.content.parts || []).map((p) => p.text || "").join("");
    if (!crudo) {
      const bloqueo = (j && j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason);
      return { escenarios: respaldo(), fuente: "plantilla", aviso: "Gemini no devolvió escenarios" + (bloqueo ? " (" + bloqueo + ")" : "") + ": se usó la plantilla." };
    }
    let lista = extraerJson(crudo);
    if (lista && !Array.isArray(lista) && Array.isArray(lista.escenarios)) lista = lista.escenarios;
    if (!Array.isArray(lista) || !lista.length) throw new Error("respuesta sin lista");
    const repetido = new Set((o.existentes || []).map(claveTitulo));
    const escenarios = lista
      .map((e, i) => normalizarEscenario(e, idEscenario(i + 1)))
      .filter((e) => e.pasos.length && e.esperado && !repetido.has(claveTitulo(e.titulo)))
      .slice(0, 30);
    if (!escenarios.length) throw new Error("ningún escenario completo");
    return { escenarios, fuente: "gemini", aviso: null };
  } catch (e) {
    const motivo = e && e.name === "AbortError" ? "Gemini tardó demasiado" : "No pude usar Gemini (" + mensajeRed(e) + ")";
    return { escenarios: respaldo(), fuente: "plantilla", aviso: motivo + ": escenarios armados con la plantilla." };
  } finally {
    if (reloj) clearTimeout(reloj);
  }
}

function claveTitulo(t) {
  return slug(t, 200);
}

// ---------------------------------------------------------------- plantilla por reglas (sin internet)

/** Saca los criterios del caso: viñetas, líneas numeradas, "Dado/Cuando/Entonces" y frases con "debe". */
function criterios(caso) {
  const lineas = texto(caso, 20000).split("\n").map((l) => l.trim()).filter(Boolean);
  const salida = [];
  for (const l of lineas) {
    const vineta = l.match(/^(?:[-*•]|\d+[.)]|\[ ?\])\s+(.+)/);
    if (vineta) { salida.push(vineta[1]); continue; }
    if (/^(dado|cuando|entonces|given|when|then)\b/i.test(l)) { salida.push(l); continue; }
    for (const frase of l.split(/(?<=[.;])\s+/)) {
      if (/\b(debe|deben|debería|deberá|tiene que|puede|podrá|permite|must|should)\b/i.test(frase) && frase.length > 12) salida.push(frase);
    }
  }
  const vistos = new Set();
  return salida
    .map((c) => c.replace(/[.;:]+$/, "").trim())
    .filter((c) => c.length > 3 && !vistos.has(c.toLowerCase()) && vistos.add(c.toLowerCase()))
    .slice(0, 10);
}

function minusculaInicial(t) {
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

function recortar(t, n) {
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

const REGLAS_TEMA = [
  {
    clave: /\b(formulario|campo|campos|correo|email|e-mail|contrase[nñ]a|password|tel[eé]fono|fecha|monto|n[uú]mero|registro|registrar)\b/i,
    escenarios: [
      { titulo: "Campos obligatorios vacíos", tipo: "validacion", prioridad: "alta", pasos: ["Abrir el formulario del caso", "Dejar vacíos los campos obligatorios", "Intentar guardar o enviar"], esperado: "No se envía; cada campo obligatorio muestra un mensaje claro de qué falta." },
      { titulo: "Formato inválido en los datos", tipo: "validacion", prioridad: "media", pasos: ["Escribir datos con formato incorrecto (correo sin @, letras en un número, fecha imposible)", "Intentar guardar o enviar"], esperado: "Se rechaza el dato y el mensaje explica el formato correcto, sin perder lo ya escrito." },
      { titulo: "Valores en el límite (mínimo, máximo y uno más)", tipo: "borde", prioridad: "media", pasos: ["Probar el valor mínimo permitido", "Probar el máximo permitido", "Probar uno por encima del máximo y textos muy largos"], esperado: "Los límites se aceptan; lo que los pasa se rechaza con un mensaje, sin cortar datos en silencio." },
    ],
  },
  {
    clave: /\b(login|inicio de sesi[oó]n|iniciar sesi[oó]n|usuario|rol|roles|permiso|permisos|admin|administrador|autenticaci[oó]n|token)\b/i,
    escenarios: [
      { titulo: "Usuario sin permiso intenta la acción", tipo: "permisos", prioridad: "alta", pasos: ["Entrar con un usuario que no tiene el rol o permiso necesario", "Intentar la acción del caso (también por URL o llamada directa)"], esperado: "Se niega el acceso con un mensaje adecuado y no se modifica ningún dato." },
      { titulo: "Sesión vencida durante la acción", tipo: "permisos", prioridad: "media", pasos: ["Iniciar la acción del caso", "Hacer que la sesión venza (cerrar sesión en otra pestaña o esperar)", "Terminar la acción"], esperado: "Pide iniciar sesión de nuevo sin perder lo que se estaba haciendo, o avisa con claridad." },
    ],
  },
  {
    clave: /\b(api|servicio|endpoint|servidor|internet|red|conexi[oó]n|sincroniza|petici[oó]n|backend|http)\b/i,
    escenarios: [
      { titulo: "Sin conexión o servidor caído", tipo: "error", prioridad: "alta", pasos: ["Cortar la conexión o detener el servicio", "Ejecutar la acción del caso"], esperado: "Se muestra un error comprensible, se puede reintentar y no quedan datos a medias." },
      { titulo: "Respuesta lenta o tiempo de espera agotado", tipo: "error", prioridad: "media", pasos: ["Simular una respuesta lenta (limitar la red)", "Ejecutar la acción y esperar"], esperado: "Hay un indicador de carga; al vencer el tiempo se avisa y se puede reintentar." },
    ],
  },
  {
    clave: /\b(lista|listado|b[uú]squeda|buscar|filtro|filtrar|paginaci[oó]n|tabla|resultados|ordenar)\b/i,
    escenarios: [
      { titulo: "Lista sin resultados", tipo: "borde", prioridad: "media", pasos: ["Buscar o filtrar algo que no existe"], esperado: "Se muestra un estado vacío claro, sin errores ni pantalla en blanco." },
      { titulo: "Muchos resultados", tipo: "rendimiento", prioridad: "baja", pasos: ["Preparar una cantidad grande de datos", "Abrir la lista, desplazarse y paginar"], esperado: "Carga en un tiempo razonable y la paginación o el desplazamiento funcionan bien." },
    ],
  },
  {
    clave: /\b(archivo|adjunto|adjuntar|imagen|foto|subir|cargar|descargar|exportar|importar|pdf|excel)\b/i,
    escenarios: [
      { titulo: "Archivo de tipo no permitido", tipo: "validacion", prioridad: "media", pasos: ["Elegir un archivo con un tipo no permitido", "Intentar subirlo o importarlo"], esperado: "Se rechaza con un mensaje que dice qué tipos se aceptan." },
      { titulo: "Archivo muy grande o vacío", tipo: "borde", prioridad: "media", pasos: ["Intentar con un archivo más grande que el límite", "Intentar con un archivo vacío"], esperado: "Se avisa del tamaño máximo o del archivo vacío, sin colgar la aplicación." },
    ],
  },
  {
    clave: /\b(android|celular|m[oó]vil|app|pantalla|notificaci[oó]n|tablet)\b/i,
    escenarios: [
      { titulo: "Girar la pantalla a mitad de la acción", tipo: "ui", prioridad: "media", pasos: ["Empezar la acción del caso", "Girar el dispositivo", "Terminar la acción"], esperado: "No se pierden los datos escritos ni se repite la acción." },
      { titulo: "Ir a segundo plano y volver", tipo: "borde", prioridad: "media", pasos: ["Empezar la acción del caso", "Ir a otra app unos minutos", "Volver a la app"], esperado: "La pantalla conserva su estado o se recupera sin errores." },
    ],
  },
  {
    clave: /\b(pago|pagar|cobro|factura|compra|precio|total|descuento|saldo|transferencia)\b/i,
    escenarios: [
      { titulo: "Cálculo de montos con decimales y redondeo", tipo: "borde", prioridad: "alta", pasos: ["Usar montos con decimales, descuentos y cantidades distintas", "Revisar el total calculado"], esperado: "El total coincide con el cálculo manual y el redondeo es el acordado." },
    ],
  },
];

const GENERICOS = [
  { titulo: "Repetir la acción rápido (doble clic o doble envío)", tipo: "borde", prioridad: "media", pasos: ["Ejecutar la acción del caso", "Pulsar el botón dos veces seguidas o reenviar enseguida"], esperado: "La acción se aplica una sola vez; no quedan registros duplicados." },
  { titulo: "Cancelar a mitad del proceso", tipo: "borde", prioridad: "baja", pasos: ["Empezar la acción del caso", "Cancelar, cerrar o volver atrás antes de terminar"], esperado: "No queda nada a medias y se puede empezar otra vez sin errores." },
  { titulo: "Lo que ya funcionaba sigue igual", tipo: "regresion", prioridad: "media", pasos: ["Identificar las pantallas o funciones cercanas al cambio", "Usarlas con normalidad"], esperado: "Siguen funcionando como antes del cambio." },
];

function plantillaPorReglas(caso, opciones) {
  const o = opciones || {};
  const t = texto(caso, 20000);
  const lista = [];
  const crit = criterios(t);
  if (crit.length) {
    for (const c of crit) {
      const negativo = /\b(no hay|sin |error|falla|fallo|inv[aá]lid|incorrect|rechaz)/i.test(c);
      lista.push({
        titulo: recortar(c.charAt(0).toUpperCase() + c.slice(1), 90),
        tipo: negativo ? "error" : "feliz",
        prioridad: "alta",
        precondiciones: "Datos y entorno listos para el caso.",
        pasos: ["Preparar los datos necesarios", "Realizar la acción: " + minusculaInicial(c), "Revisar el resultado"],
        esperado: "Se cumple el criterio: " + c + ".",
      });
    }
  } else {
    const primera = recortar(t.split("\n")[0].replace(/[.:]+$/, ""), 80);
    lista.push({
      titulo: "Flujo principal: " + minusculaInicial(primera),
      tipo: "feliz",
      prioridad: "alta",
      precondiciones: "Datos y entorno listos para el caso.",
      pasos: ["Preparar los datos necesarios", "Realizar el flujo descrito en el caso", "Revisar el resultado"],
      esperado: "El resultado es el descrito en el caso, sin errores.",
    });
  }
  for (const regla of REGLAS_TEMA) if (regla.clave.test(t)) lista.push(...regla.escenarios);
  lista.push(...GENERICOS);
  const repetido = new Set((o.existentes || []).map(claveTitulo));
  return lista
    .filter((e) => !repetido.has(claveTitulo(e.titulo)))
    .map((e, i) => normalizarEscenario(e, idEscenario(i + 1)));
}

/** Agrega escenarios al plan con ids nuevos. */
function sumarEscenarios(plan, escenarios) {
  const agregados = [];
  for (const e of escenarios) {
    const { id, estado, observacion, adjuntos, automatizacion, ...resto } = e;
    agregados.push(nuevoEscenario(plan, resto));
  }
  return agregados;
}

module.exports = {
  VERSION_FORMATO, ARCHIVO_PLAN, CARPETA_ADJUNTOS, MODELO_POR_DEFECTO, MAX_ADJUNTO,
  ESTADOS, TIPOS, PRIORIDADES, VEREDICTOS,
  slug, nombreSeguro, fechaCorta,
  normalizarEscenario, normalizarPlan, leerPlan, guardarPlan, crearCarpetaPlan, listarPlanes, rutaPlan, resumen,
  agregarAdjunto, quitarAdjunto, rutaAdjunto, quitarEscenario, nuevoEscenario, sumarEscenarios,
  tipoMime, esImagenIncrustable,
  datosGit, rutasConfig, leerClaveGuardada, guardarClave,
  instruccionesGemini, generarEscenarios, fetchConRespaldo, mensajeRed, plantillaPorReglas, criterios, extraerJson,
};
