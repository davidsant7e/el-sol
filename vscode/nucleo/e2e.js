"use strict";
/**
 * XIX · El Sol — pruebas end-to-end de los escenarios (sin dependencias, Node 18+).
 *
 *   Web      → Playwright (@playwright/test del proyecto). Grabar con codegen, generar con Gemini
 *              a partir del escenario y de lo que hay en la página, o vincular una prueba existente.
 *   Android  → Maestro (flujos YAML). Grabar con Maestro Studio, generar con Gemini a partir del
 *              escenario y de la pantalla actual, o vincular un flujo existente.
 *   Otros    → cualquier comando que deje un reporte JUnit (Cypress, Selenium, Maestro…).
 *
 * Todo vive dentro de la carpeta del plan:
 *   pruebas/<plan>/e2e/
 *     playwright.config.mjs   ← lo escribe El Sol (capturas siempre, video y traza si falla)
 *     E03.spec.ts             ← prueba web del escenario E03
 *     E05.yaml                ← flujo de Maestro del escenario E05
 *     .env                    ← datos de prueba (USUARIO=…), no se sube a git
 *     .resultados/            ← reportes y artefactos de la última ejecución (no se sube a git)
 *
 * Cada prueba se une a su escenario por el id («E03») en el nombre del archivo o en el título del test.
 * Al ejecutar, el escenario queda en Pasó o Falló, con el error en la observación y las capturas
 * (y el video si falló) como evidencias del PDF.
 */

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const S = require("./sol.js");

const CARPETA = "e2e";
const RESULTADOS = ".resultados";
const PLATAFORMAS = { web: "Web (Playwright)", android: "Android (Maestro)", junit: "Otro (reporte JUnit)" };
const ORIGENES = { grabada: "Grabada", gemini: "Generada con Gemini", existente: "Existente" };
const MARCA = "» E2E"; // el signo » sí existe en las fuentes del PDF
const PREFIJO_EVIDENCIA = "e2e-";

// ---------------------------------------------------------------- datos en sol.json

/** plan.e2e = { url, appId } */
function normalizarConfig(x) {
  const c = x && typeof x === "object" ? x : {};
  return {
    url: String(c.url || "").trim().slice(0, 500),
    appId: String(c.appId || "").trim().slice(0, 200),
  };
}

/** escenario.automatizacion = { plataforma, archivo, origen, ultima: { fecha, estado, duracionMs, error } } */
function normalizarAutomatizacion(x) {
  if (!x || typeof x !== "object" || !x.archivo) return null;
  const u = x.ultima && typeof x.ultima === "object" ? x.ultima : null;
  return {
    plataforma: PLATAFORMAS[x.plataforma] ? x.plataforma : "web",
    archivo: String(x.archivo).replace(/\\/g, "/").slice(0, 400),
    origen: ORIGENES[x.origen] ? x.origen : "existente",
    ultima: u ? {
      fecha: String(u.fecha || ""),
      estado: ["paso", "fallo", "omitida"].includes(u.estado) ? u.estado : "fallo",
      duracionMs: Number.isFinite(u.duracionMs) ? u.duracionMs : 0,
      error: String(u.error || "").slice(0, 2000),
    } : null,
  };
}

function carpetaE2E(carpetaPlan) {
  return path.join(carpetaPlan, CARPETA);
}

/** Ruta absoluta del archivo de una automatización (relativo a la carpeta del plan). */
function rutaArchivo(carpetaPlan, auto) {
  return path.resolve(carpetaPlan, auto.archivo);
}

/** Nombre sugerido para la prueba nueva de un escenario. */
function archivoNuevo(idEsc, plataforma) {
  return CARPETA + "/" + idEsc + (plataforma === "android" ? ".yaml" : ".spec.ts");
}

/** Deja la carpeta e2e lista: .gitignore y, para web, playwright.config.mjs. */
function prepararCarpeta(carpetaPlan, plan) {
  const dir = carpetaE2E(carpetaPlan);
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, ".env\n" + RESULTADOS + "/\n");
  fs.writeFileSync(path.join(dir, "playwright.config.mjs"), configPlaywright(plan));
  return dir;
}

function configPlaywright(plan) {
  const url = normalizarConfig(plan && plan.e2e).url;
  return [
    "// Lo escribe El Sol: se vuelve a generar en cada ejecución (los cambios aquí se pierden).",
    "import { defineConfig } from \"@playwright/test\";",
    "",
    "export default defineConfig({",
    "  testDir: \".\",",
    "  testMatch: /.*\\.spec\\.(ts|js|mjs)$/,",
    "  outputDir: \"" + RESULTADOS + "/artefactos\",",
    "  timeout: 60_000,",
    "  workers: 1,",
    "  reporter: [[\"list\"], [\"json\", { outputFile: \"" + RESULTADOS + "/reporte.json\" }]],",
    "  use: {",
    url ? "    baseURL: " + JSON.stringify(url) + "," : "    // baseURL: \"https://…\" (se toma de la URL del plan en El Sol)",
    "    screenshot: \"on\",",
    "    video: \"retain-on-failure\",",
    "    trace: \"retain-on-failure\",",
    "    locale: \"es-CO\",",
    "  },",
    "});",
    "",
  ].join("\n");
}

/** Lee e2e/.env (CLAVE=valor por línea) para pasarlo a las pruebas como variables de entorno. */
function leerEnv(carpetaPlan) {
  const env = {};
  let txt = "";
  try { txt = fs.readFileSync(path.join(carpetaE2E(carpetaPlan), ".env"), "utf8"); } catch (e) { return env; }
  for (const linea of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(linea);
    if (!m || linea.trim().startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

// ---------------------------------------------------------------- comandos

/** npx playwright test con la configuración del plan. `archivos`: rutas relativas a la carpeta e2e (vacío = todas). */
function comandoPlaywright(carpetaPlan, archivos, opciones) {
  const o = opciones || {};
  const args = ["playwright", "test", "--config", path.join(carpetaE2E(carpetaPlan), "playwright.config.mjs")];
  for (const a of archivos || []) args.push(a.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]]/g, "\\$&") + "$");
  if (o.ventana) args.push("--headed");
  return { cmd: "npx", args, reporte: path.join(carpetaE2E(carpetaPlan), RESULTADOS, "reporte.json") };
}

/** npx playwright codegen para grabar un flujo en el navegador. */
function comandoGrabarWeb(carpetaPlan, auto, url) {
  const args = ["playwright", "codegen", "--target", "playwright-test", "--output", rutaArchivo(carpetaPlan, auto)];
  if (url) args.push(url);
  return { cmd: "npx", args };
}

/**
 * Dónde está maestro: en el PATH, o en %LOCALAPPDATA%\maestro (donde lo deja instalar-maestro.ps1),
 * para que funcione sin reiniciar el editor después de instalarlo.
 */
function binMaestro(entorno) {
  const env = entorno || process.env;
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    const bat = path.join(env.LOCALAPPDATA, "maestro", "bin", "maestro.bat");
    if (fs.existsSync(bat)) return bat;
  }
  return "maestro";
}

/**
 * Variables para correr maestro: JAVA_HOME con el Java de Android Studio si falta, y sin analítica.
 */
function entornoMaestro(entorno) {
  const env = Object.assign({}, entorno || process.env, { MAESTRO_CLI_NO_ANALYTICS: "true", MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true" });
  if (process.platform === "win32" && !env.JAVA_HOME) {
    const jbr = [path.join(env.ProgramFiles || "C:\\Program Files", "Android", "Android Studio", "jbr"),
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "Android Studio", "jbr") : null]
      .find((d) => d && fs.existsSync(path.join(d, "bin", "java.exe")));
    if (jbr) env.JAVA_HOME = jbr;
  }
  return env;
}

/**
 * Argumentos de maestro para un celular concreto. Con más de un dispositivo conectado (p. ej. el que da
 * internet por USB) maestro preguntaría cuál usar y la prueba se quedaría esperando.
 */
function conDispositivo(args, dispositivo) {
  const d = String(dispositivo || "").trim();
  return d ? ["--device", d].concat(args) : args.slice();
}

/** El dispositivo a usar: el ajuste de El Sol, o ANDROID_SERIAL. */
function dispositivoAndroid(ajuste, entorno) {
  return String(ajuste || (entorno || process.env).ANDROID_SERIAL || "").trim();
}

/** maestro test con reporte JUnit y carpeta de artefactos propia del escenario. */
function comandoMaestro(carpetaPlan, auto, idEsc, opciones) {
  const o = opciones || {};
  const salida = path.join(carpetaE2E(carpetaPlan), RESULTADOS, "maestro", idEsc);
  const datos = Object.entries(o.env || {}).flatMap(([k, v]) => ["-e", k + "=" + v]);
  return {
    cmd: o.bin || "maestro",
    args: conDispositivo(["test"].concat(datos, [rutaArchivo(carpetaPlan, auto), "--format", "junit", "--output", path.join(salida, "reporte.xml"), "--test-output-dir=" + salida]), o.dispositivo),
    salida,
    reporte: path.join(salida, "reporte.xml"),
  };
}

/** Une argumentos para mostrarlos o mandarlos a una terminal (comillas solo donde hacen falta). */
function lineaDeComando(c) {
  const q = (a) => (/[\s"&|<>^()]/.test(a) ? "\"" + a.replace(/"/g, "\\\"") + "\"" : a);
  return [c.cmd].concat(c.args).map(q).join(" ");
}

// ---------------------------------------------------------------- reportes

function sinColores(t) {
  // eslint-disable-next-line no-control-regex
  return String(t || "").replace(/\u001b\[[0-9;]*m/g, "");
}

/** Primeras líneas útiles de un error (sin la pila). */
function resumenError(t) {
  const lineas = sinColores(t).split(/\r?\n/).map((l) => l.trimEnd());
  const utiles = [];
  for (const l of lineas) {
    if (/^\s+at\s/.test(l) || /^Call log:/.test(l.trim())) break;
    if (l.trim()) utiles.push(l.trim());
    if (utiles.length >= 6) break;
  }
  return utiles.join("\n").slice(0, 1200);
}

/** El id del escenario («E03») en el título del test o en el nombre del archivo. */
function idDe(titulo, archivo) {
  const m = /\b(E\d{2,3})\b/.exec(titulo || "") || /(?:^|[\\/])(E\d{2,3})(?=[^\\/]*$)/.exec(archivo || "");
  return m ? m[1] : null;
}

/**
 * Reporte JSON de Playwright → [{ id, titulo, archivo, estado: paso|fallo|omitida, duracionMs, error, adjuntos: [{nombre, ruta, tipo}] }]
 */
function leerReportePlaywright(json) {
  const r = typeof json === "string" ? JSON.parse(json) : json;
  const salida = [];
  const recorrer = (suite, archivo) => {
    const arch = suite.file || archivo;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const res = (t.results || [])[Math.max(0, (t.results || []).length - 1)] || {};
        const st = t.status === "skipped" || res.status === "skipped" ? "omitida"
          : t.status === "expected" || t.status === "flaky" || res.status === "passed" ? "paso" : "fallo";
        const errores = [].concat(res.error ? [res.error] : [], res.errors || []);
        const titulo = spec.title;
        salida.push({
          id: idDe(spec.title, spec.file || arch),
          titulo,
          archivo: spec.file || arch || "",
          estado: st,
          duracionMs: (t.results || []).reduce((s, x) => s + (x.duration || 0), 0),
          error: st === "fallo" ? resumenError((errores[0] && (errores[0].message || errores[0].value)) || "Falló (sin mensaje)") : "",
          adjuntos: (res.attachments || []).filter((a) => a.path).map((a) => ({ nombre: a.name, ruta: a.path, tipo: a.contentType || "" })),
        });
      }
    }
    for (const s of suite.suites || []) recorrer(s, arch);
  };
  for (const s of r.suites || []) recorrer(s, s.file);
  // errores globales (p. ej. el archivo no compila): se atribuyen al archivo si trae id
  for (const e of r.errors || []) {
    const archivo = (e.location && e.location.file) || "";
    const id = idDe("", archivo);
    if (id && !salida.some((x) => x.id === id)) salida.push({ id, titulo: "", archivo, estado: "fallo", duracionMs: 0, error: resumenError(e.message || e.stack), adjuntos: [] });
  }
  return salida;
}

function desescapar(t) {
  return String(t || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function atributo(etiqueta, nombre) {
  const m = new RegExp("\\s" + nombre + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')").exec(etiqueta);
  return m ? desescapar(m[2] !== undefined ? m[2] : m[3]) : "";
}

/** Reporte JUnit XML (Maestro, Cypress, Selenium, …) → mismo formato que leerReportePlaywright. */
function leerJUnit(xml) {
  const salida = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const cab = m[1];
    const cuerpo = m[3] || "";
    const titulo = atributo(cab, "name");
    const clase = atributo(cab, "classname");
    const archivo = atributo(cab, "file");
    const falla = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(cuerpo);
    const omitida = /<skipped\b/.test(cuerpo);
    const texto = falla ? (atributo(falla[2], "message") + "\n" + desescapar((falla[4] || "").replace(/<!\[CDATA\[|\]\]>/g, ""))).trim() : "";
    salida.push({
      id: idDe(titulo, archivo) || idDe(clase, "") || idDe("", clase),
      titulo,
      archivo: archivo || clase,
      estado: falla ? "fallo" : omitida ? "omitida" : "paso",
      duracionMs: Math.round((parseFloat(atributo(cab, "time")) || 0) * 1000),
      error: falla ? resumenError(texto || "Falló") : "",
      adjuntos: [],
    });
  }
  return salida;
}

/** Imágenes y videos de una carpeta (recursivo), para las evidencias de Maestro. */
function artefactosEn(dir) {
  const salida = [];
  const recorrer = (d) => {
    let lista = [];
    try { lista = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const x of lista) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) recorrer(p);
      else if (/\.(png|jpe?g|mp4|webm)$/i.test(x.name)) salida.push({ nombre: x.name, ruta: p, tipo: S.tipoMime(x.name) });
    }
  };
  recorrer(dir);
  return salida.sort((a, b) => a.ruta.localeCompare(b.ruta));
}

// ---------------------------------------------------------------- aplicar al plan

/** Quita del escenario las evidencias de una ejecución anterior (las que empiezan por «e2e-»). */
function quitarEvidenciasAnteriores(carpetaPlan, plan, esc) {
  for (const a of esc.adjuntos.slice()) {
    if (path.basename(a.archivo).slice(esc.id.length + 4).startsWith(PREFIJO_EVIDENCIA)) S.quitarAdjunto(carpetaPlan, plan, esc.id, a.archivo);
  }
}

/** Reemplaza (o agrega) el bloque automático de la observación sin tocar lo que escribió el probador. */
function observacionConResultado(observacion, linea) {
  const propia = String(observacion || "").split("\n" + MARCA)[0].replace(new RegExp("^" + MARCA + "[\\s\\S]*$"), "").trimEnd();
  return (propia ? propia + "\n" : "") + linea;
}

function duracionLegible(ms) {
  if (ms < 1000) return ms + " ms";
  const s = ms / 1000;
  return s < 60 ? s.toFixed(1).replace(".", ",") + " s" : Math.floor(s / 60) + " min " + Math.round(s % 60) + " s";
}

/**
 * Lleva los resultados al plan: estado, observación, evidencias (capturas; video y traza solo si falló).
 * Devuelve { aplicados: [{id, estado}], sinEscenario: [titulos] }. No guarda: el que llama guarda el plan.
 */
function aplicarResultados(carpetaPlan, plan, resultados, opciones) {
  const o = opciones || {};
  const fecha = o.fecha || new Date().toISOString();
  const porId = new Map();
  const sinEscenario = [];
  for (const r of resultados) {
    const esc = r.id && plan.escenarios.find((e) => e.id === r.id);
    if (!esc) { sinEscenario.push(r.titulo || r.archivo); continue; }
    // si un escenario tiene varios tests, falla si cualquiera falla
    const previo = porId.get(esc.id);
    if (!previo) porId.set(esc.id, { esc, estado: r.estado, duracionMs: r.duracionMs, errores: r.error ? [r.error] : [], adjuntos: r.adjuntos.slice(), extra: o.extra && o.extra[esc.id] || [] });
    else {
      if (r.estado === "fallo" || previo.estado === "omitida") previo.estado = r.estado;
      previo.duracionMs += r.duracionMs;
      if (r.error) previo.errores.push(r.error);
      previo.adjuntos.push(...r.adjuntos);
    }
  }
  const aplicados = [];
  for (const { esc, estado, duracionMs, errores, adjuntos, extra } of porId.values()) {
    quitarEvidenciasAnteriores(carpetaPlan, plan, esc);
    const todos = adjuntos.concat(extra);
    let n = 0;
    for (const a of todos) {
      const esImagen = /^image\//.test(a.tipo) || /\.(png|jpe?g)$/i.test(a.ruta);
      const esVideoOTraza = /video|zip/.test(a.tipo) || /\.(webm|mp4|zip)$/i.test(a.ruta);
      if (!esImagen && !(esVideoOTraza && estado === "fallo")) continue;
      let datos;
      try { datos = fs.readFileSync(a.ruta); } catch (e) { continue; }
      if (datos.length > S.MAX_ADJUNTO) continue;
      const ext = path.extname(a.ruta) || (esImagen ? ".png" : "");
      const base = (a.nombre || path.basename(a.ruta, ext)).replace(/\.[a-z0-9]+$/i, "");
      try { S.agregarAdjunto(carpetaPlan, plan, esc.id, PREFIJO_EVIDENCIA + (++n) + "-" + base + ext, datos); } catch (e) { /* demasiado grande u otro: se omite */ }
    }
    if (estado !== "omitida") esc.estado = estado;
    const d = new Date(fecha);
    const dos = (n) => String(n).padStart(2, "0");
    const cuando = isNaN(d) ? fecha : d.getFullYear() + "-" + dos(d.getMonth() + 1) + "-" + dos(d.getDate()) + " " + dos(d.getHours()) + ":" + dos(d.getMinutes());
    const linea = MARCA + " " + cuando + " · " + (estado === "paso" ? "Pasó" : estado === "fallo" ? "Falló" : "Omitida") +
      " en " + duracionLegible(duracionMs) + (errores.length ? ":\n" + errores.join("\n---\n") : ".");
    esc.observacion = observacionConResultado(esc.observacion, linea);
    if (esc.automatizacion) esc.automatizacion.ultima = { fecha, estado, duracionMs, error: errores.join("\n").slice(0, 2000) };
    aplicados.push({ id: esc.id, estado });
  }
  return { aplicados, sinEscenario };
}

// ---------------------------------------------------------------- grabadas: el título del test lleva el id

/** codegen escribe test('test', …): se cambia por test('E03 · título', …) para unirlo a su escenario. */
function ponerTitulo(codigo, esc) {
  const nombre = esc.id + " · " + esc.titulo.replace(/[`'"\\]/g, "");
  const m = /\btest\s*\(\s*(['"`])([^'"`]*)\1/.exec(codigo);
  if (!m || idDe(m[2], "") === esc.id) return codigo;
  return codigo.slice(0, m.index) + "test('" + nombre + "'" + codigo.slice(m.index + m[0].length);
}

// ---------------------------------------------------------------- ejecutar

/**
 * Corre un comando y junta la salida. En Windows va por la consola (npx y maestro son .cmd/.bat).
 * opciones: { cwd, env, alSalir(texto), spawn, señal: AbortSignal }
 */
function correr(c, opciones) {
  const o = opciones || {};
  const lanzar = o.spawn || childProcess.spawn;
  return new Promise((ok) => {
    const env = Object.assign({}, process.env, o.env || {}, { FORCE_COLOR: "0" });
    const hijo = process.platform === "win32"
      ? lanzar(lineaDeComando(c), [], { cwd: o.cwd, env, shell: true, windowsHide: true })
      : lanzar(c.cmd, c.args, { cwd: o.cwd, env });
    let salida = "";
    const recibir = (d) => { const t = d.toString(); salida += t; if (o.alSalir) o.alSalir(t); };
    if (hijo.stdout) hijo.stdout.on("data", recibir);
    if (hijo.stderr) hijo.stderr.on("data", recibir);
    if (o.senal) o.senal.addEventListener("abort", () => { try { hijo.kill(); } catch (e) { /* ya terminó */ } });
    hijo.on("error", (e) => ok({ codigo: -1, salida: salida + "\n" + e.message, noEncontrado: e.code === "ENOENT" }));
    hijo.on("close", (codigo) => ok({ codigo, salida, noEncontrado: codigo === 127 || /no se reconoce|not recognized|command not found/i.test(salida.slice(0, 600)) }));
  });
}

/** Los escenarios automatizados de una plataforma (todos o los ids pedidos). */
function automatizados(plan, plataforma, ids) {
  return plan.escenarios.filter((e) => e.automatizacion && e.automatizacion.plataforma === plataforma && (!ids || !ids.length || ids.includes(e.id)));
}

/** ¿El archivo está dentro de la carpeta e2e del plan? (si no, es una prueba existente del proyecto) */
function dentroDeE2E(carpetaPlan, ruta) {
  const rel = path.relative(carpetaE2E(carpetaPlan), ruta);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Ejecuta las pruebas web (Playwright) de los escenarios y devuelve los resultados por escenario.
 * Las del plan corren con la configuración de El Sol; las existentes del proyecto, con la del proyecto.
 * opciones: { raiz (carpeta del proyecto), ventana, alSalir, spawn, senal }
 */
async function ejecutarWeb(carpetaPlan, plan, ids, opciones) {
  const o = opciones || {};
  const lista = automatizados(plan, "web", ids);
  const faltan = [];
  const propias = [];
  const ajenas = new Map(); // ruta absoluta → id
  prepararCarpeta(carpetaPlan, plan);
  for (const e of lista) {
    const ruta = rutaArchivo(carpetaPlan, e.automatizacion);
    if (!fs.existsSync(ruta)) { faltan.push(e.id); continue; }
    if (dentroDeE2E(carpetaPlan, ruta)) {
      // las grabadas con codegen se llaman 'test': se les pone el id para unirlas al escenario
      const codigo = fs.readFileSync(ruta, "utf8");
      const nuevo = ponerTitulo(codigo, e);
      if (nuevo !== codigo) fs.writeFileSync(ruta, nuevo);
      propias.push(path.relative(carpetaE2E(carpetaPlan), ruta));
    } else ajenas.set(path.resolve(ruta), e.id);
  }
  const env = leerEnv(carpetaPlan);
  const resultados = [];
  let salida = "";
  let noEncontrado = false;
  if (propias.length) {
    const c = comandoPlaywright(carpetaPlan, propias, { ventana: o.ventana });
    try { fs.rmSync(c.reporte, { force: true }); } catch (e) { /* */ }
    const r = await correr(c, { cwd: o.raiz || carpetaPlan, env, alSalir: o.alSalir, spawn: o.spawn, senal: o.senal });
    salida += r.salida;
    noEncontrado = noEncontrado || r.noEncontrado;
    if (fs.existsSync(c.reporte)) resultados.push(...leerReportePlaywright(fs.readFileSync(c.reporte, "utf8")));
  }
  if (ajenas.size) {
    const reporte = path.join(carpetaE2E(carpetaPlan), RESULTADOS, "reporte-proyecto.json");
    try { fs.rmSync(reporte, { force: true }); } catch (e) { /* */ }
    const c = { cmd: "npx", args: ["playwright", "test", "--reporter=list,json"].concat([...ajenas.keys()].map((r) => path.relative(o.raiz || process.cwd(), r).replace(/\\/g, "/"))) };
    const r = await correr(c, { cwd: o.raiz, env: Object.assign({}, env, { PLAYWRIGHT_JSON_OUTPUT_FILE: reporte }), alSalir: o.alSalir, spawn: o.spawn, senal: o.senal });
    salida += r.salida;
    noEncontrado = noEncontrado || r.noEncontrado;
    if (fs.existsSync(reporte)) {
      for (const x of leerReportePlaywright(fs.readFileSync(reporte, "utf8"))) {
        const id = ajenas.get(path.resolve(o.raiz || process.cwd(), x.archivo)) || [...ajenas.entries()].find(([ruta]) => ruta.endsWith(x.archivo.replace(/\\/g, "/").replace(/\//g, path.sep)))?.[1];
        resultados.push(Object.assign(x, { id: id || x.id }));
      }
    }
  }
  return { resultados, salida, faltan, noEncontrado, ejecutadas: propias.length + ajenas.size };
}

/** Ejecuta los flujos de Maestro de los escenarios, uno por uno (cada uno con su carpeta de capturas). */
async function ejecutarAndroid(carpetaPlan, plan, ids, opciones) {
  const o = opciones || {};
  const lista = automatizados(plan, "android", ids);
  const resultados = [];
  const extra = {};
  const faltan = [];
  let salida = "";
  let noEncontrado = false;
  prepararCarpeta(carpetaPlan, plan);
  const env = leerEnv(carpetaPlan);
  for (const e of lista) {
    if (!fs.existsSync(rutaArchivo(carpetaPlan, e.automatizacion))) { faltan.push(e.id); continue; }
    // Maestro recibe los datos de .env como -e CLAVE=valor
    const c = comandoMaestro(carpetaPlan, e.automatizacion, e.id, { env, dispositivo: dispositivoAndroid(o.dispositivo), bin: binMaestro() });
    fs.rmSync(c.salida, { recursive: true, force: true });
    fs.mkdirSync(c.salida, { recursive: true });
    const r = await correr(c, { cwd: c.salida, env: entornoMaestro(), alSalir: o.alSalir, spawn: o.spawn, senal: o.senal });
    salida += r.salida;
    if (r.noEncontrado) { noEncontrado = true; break; }
    let res = fs.existsSync(c.reporte) ? leerJUnit(fs.readFileSync(c.reporte, "utf8")) : [];
    if (!res.length) res = [{ id: e.id, titulo: e.titulo, archivo: e.automatizacion.archivo, estado: r.codigo === 0 ? "paso" : "fallo", duracionMs: 0, error: r.codigo === 0 ? "" : resumenError(r.salida.split("\n").slice(-12).join("\n")), adjuntos: [] }];
    // un flujo = un escenario, aunque Maestro le ponga otro nombre
    for (const x of res) resultados.push(Object.assign(x, { id: e.id }));
    extra[e.id] = artefactosEn(c.salida);
    if (o.senal && o.senal.aborted) break;
  }
  return { resultados, extra, salida, faltan, noEncontrado, ejecutadas: lista.length - faltan.length };
}

/** Corre un comando propio (Cypress, Selenium…) y lee su reporte JUnit. */
async function ejecutarJUnit(comando, reporte, opciones) {
  const o = opciones || {};
  try { fs.rmSync(reporte, { force: true }); } catch (e) { /* */ }
  // el comando lo escribe el probador tal cual lo usaría en la terminal: va completo a la consola
  const lanzar = o.spawn || ((_cmd, _args, op) => childProcess.spawn(comando, Object.assign({}, op, { shell: true })));
  const r = await correr({ cmd: comando, args: [] }, Object.assign({}, o, { spawn: lanzar }));
  const resultados = fs.existsSync(reporte) ? leerJUnit(fs.readFileSync(reporte, "utf8")) : [];
  return { resultados, salida: r.salida, noEncontrado: r.noEncontrado, ejecutadas: resultados.length };
}

// ---------------------------------------------------------------- generar con Gemini

function instruccionesWeb(esc, plan, pagina) {
  const c = normalizarConfig(plan.e2e);
  return [
    "Escribe una prueba end-to-end con Playwright Test (TypeScript) para este escenario de prueba manual.",
    "",
    "Reglas:",
    "- Un archivo completo: import { test, expect } from '@playwright/test'; y un solo test con el título exacto '" + esc.id + " · " + esc.titulo.replace(/'/g, "") + "'.",
    "- Cada paso del escenario es un await test.step('…', async () => { … }) con el texto del paso.",
    "- Usa localizadores accesibles (getByRole, getByLabel, getByPlaceholder, getByText) tomados de la página real de abajo; evita selectores CSS frágiles.",
    "- Verifica el resultado esperado con expect (toBeVisible, toHaveURL, toHaveText…). Espera de forma explícita, nunca con waitForTimeout.",
    c.url ? "- La aplicación está en baseURL: navega con page.goto('/ruta') o page.goto('/')." : "- Navega con page.goto a la URL completa del escenario.",
    "- Si hacen falta datos (usuario, clave, correo…), léelos de process.env (por ejemplo process.env.E2E_USUARIO) y nunca escribas valores reales. Lista al inicio, en un comentario, las variables que usaste.",
    "- No agregues capturas: la configuración ya toma una al final.",
    "- Responde solo con el código, sin explicaciones ni ```.",
    "",
    "Escenario " + esc.id + ": " + esc.titulo,
    esc.precondiciones ? "Precondiciones: " + esc.precondiciones : "",
    "Pasos:\n" + esc.pasos.map((p, i) => (i + 1) + ". " + p).join("\n"),
    "Resultado esperado: " + esc.esperado,
    "",
    "Caso de desarrollo (contexto):",
    String(plan.caso || "").slice(0, 4000),
    "",
    pagina ? "Página real (" + (pagina.url || c.url) + ", árbol de accesibilidad de Playwright):\n" + String(pagina.snapshot || "").slice(0, 15000) : "No se pudo leer la página: usa localizadores accesibles razonables según los pasos.",
  ].filter((x) => x !== "").join("\n");
}

function instruccionesAndroid(esc, plan, pantalla) {
  const c = normalizarConfig(plan.e2e);
  return [
    "Escribe un flujo de Maestro (YAML) para este escenario de prueba manual en una app Android.",
    "",
    "Reglas:",
    "- Empieza con appId: " + (c.appId || "<paquete de la app>") + ", una línea name: \"" + esc.id + " · " + esc.titulo.replace(/"/g, "") + "\" y luego ---.",
    "- Primero - launchApp (con clearState: true si el escenario lo necesita).",
    "- Usa tapOn, inputText, scrollUntilVisible, assertVisible, assertNotVisible, back, waitForAnimationToEnd. Toca los elementos por su texto visible o por id, según la pantalla real de abajo.",
    "- Después de cada paso importante agrega - takeScreenshot: " + esc.id + "-<n>-<nombre-corto> (sin espacios), y al final - takeScreenshot: " + esc.id + "-final.",
    "- Verifica el resultado esperado con assertVisible.",
    "- Si hacen falta datos (usuario, clave…), usa variables ${E2E_USUARIO} y nunca escribas valores reales.",
    "- Responde solo con el YAML, sin explicaciones ni ```.",
    "",
    "Escenario " + esc.id + ": " + esc.titulo,
    esc.precondiciones ? "Precondiciones: " + esc.precondiciones : "",
    "Pasos:\n" + esc.pasos.map((p, i) => (i + 1) + ". " + p).join("\n"),
    "Resultado esperado: " + esc.esperado,
    "",
    "Caso de desarrollo (contexto):",
    String(plan.caso || "").slice(0, 4000),
    "",
    pantalla ? "Pantalla actual de la app (elementos con texto o id):\n" + String(pantalla).slice(0, 12000) : "",
  ].filter((x) => x !== "").join("\n");
}

function sinCerco(t) {
  return String(t || "").replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim() + "\n";
}

/** Revisa que lo que devolvió Gemini parezca una prueba de verdad (y le pone el título con el id). */
function validarCodigo(codigo, plataforma, esc) {
  if (plataforma === "android") {
    if (!/^\s*appId\s*:/m.test(codigo) || !/^---\s*$/m.test(codigo)) throw new Error("Gemini no devolvió un flujo de Maestro válido (falta appId o ---).");
    if (!/launchApp/.test(codigo)) throw new Error("El flujo no abre la app (falta launchApp).");
    return codigo;
  }
  if (!/@playwright\/test/.test(codigo) || !/\btest\s*\(/.test(codigo)) throw new Error("Gemini no devolvió una prueba de Playwright (falta import o test()).");
  return ponerTitulo(codigo, esc);
}

/**
 * Pide el código a Gemini. opciones: { clave, modelo, fetch, pagina: {url, snapshot}, pantalla }.
 * Devuelve el código ya validado o lanza un Error con un mensaje para el probador.
 */
async function generarCodigo(plataforma, esc, plan, opciones) {
  const o = opciones || {};
  if (!o.clave) throw new Error("Para generar la prueba hace falta la clave de Gemini (El Sol: Configurar clave de Gemini).");
  if (!esc.pasos.length) throw new Error(esc.id + " no tiene pasos: escríbelos primero.");
  const instrucciones = plataforma === "android" ? instruccionesAndroid(esc, plan, o.pantalla) : instruccionesWeb(esc, plan, o.pagina);
  const hacerFetch = o.fetch || globalThis.fetch;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(o.modelo || S.MODELO_POR_DEFECTO) + ":generateContent";
  const r = await hacerFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": o.clave },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instrucciones }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    }),
  });
  if (!r.ok) {
    throw new Error(r.status === 429 ? "Gemini llegó al límite gratuito por ahora." : r.status === 400 || r.status === 403 ? "Gemini rechazó la clave o el modelo." : "Gemini respondió " + r.status + ".");
  }
  const j = await r.json();
  const cand = j && j.candidates && j.candidates[0];
  const texto = cand && cand.content && (cand.content.parts || []).map((p) => p.text || "").join("");
  if (!texto) throw new Error("Gemini no devolvió código" + (cand && cand.finishReason ? " (" + cand.finishReason + ")" : "") + ".");
  return validarCodigo(sinCerco(texto), plataforma, esc);
}

/** Resume la jerarquía de `maestro hierarchy` a una lista legible (texto, id, descripción, si se puede tocar). */
function resumirJerarquia(json) {
  let raiz;
  try { raiz = typeof json === "string" ? JSON.parse(json.slice(json.indexOf("{"))) : json; } catch (e) { return String(json || "").slice(0, 8000); }
  const lineas = [];
  const recorrer = (n) => {
    if (!n || lineas.length > 250) return;
    const a = n.attributes || {};
    const texto = a.text || a.accessibilityText || a["content-desc"] || a.hintText || "";
    const id = a["resource-id"] || a.id || "";
    if (texto || id) lineas.push("- " + [texto && "texto=\"" + texto + "\"", id && "id=" + id, a.clickable === "true" && "tocable", a.enabled === "false" && "deshabilitado"].filter(Boolean).join(" "));
    for (const h of n.children || []) recorrer(h);
  };
  recorrer(raiz);
  return lineas.join("\n");
}

module.exports = {
  CARPETA, RESULTADOS, PLATAFORMAS, ORIGENES, MARCA, PREFIJO_EVIDENCIA,
  normalizarConfig, normalizarAutomatizacion, carpetaE2E, rutaArchivo, archivoNuevo, prepararCarpeta, configPlaywright, leerEnv,
  comandoPlaywright, comandoGrabarWeb, comandoMaestro, binMaestro, entornoMaestro, conDispositivo, dispositivoAndroid, lineaDeComando, correr, automatizados,
  ejecutarWeb, ejecutarAndroid, ejecutarJUnit,
  leerReportePlaywright, leerJUnit, artefactosEn, idDe, resumenError,
  aplicarResultados, observacionConResultado, ponerTitulo,
  instruccionesWeb, instruccionesAndroid, generarCodigo, validarCodigo, resumirJerarquia, duracionLegible,
};
