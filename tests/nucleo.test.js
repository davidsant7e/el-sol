"use strict";
// Pruebas del núcleo y del PDF.  Uso: node tests/correr.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const S = require("../vscode/nucleo/sol.js");
const I = require("../vscode/nucleo/informe.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "elsol-"));

/** PNG mínimo válido de w×h de un color (sin librerías). */
function png(w, h, rgbColor) {
  const crcTabla = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTabla[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const trozo = (tipo, datos) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(datos.length);
    const td = Buffer.concat([Buffer.from(tipo), datos]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const fila = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgbColor).flat())]);
  const crudo = Buffer.concat(Array(h).fill(fila));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), trozo("IHDR", ihdr), trozo("IDAT", zlib.deflateSync(crudo)), trozo("IEND", Buffer.alloc(0))]);
}

function respuesta(status, cuerpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => cuerpo };
}

function geminiCon(lista) {
  return respuesta(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(lista) }] } }] });
}

const CASO = `Historia: Como usuario quiero iniciar sesión con Google en la app Android.
Criterios:
- El botón «Continuar con Google» aparece en la pantalla de login
- Si el correo no existe, se crea la cuenta
Sin internet debe mostrarse un aviso.`;

module.exports = {
  "slug y nombres seguros"() {
    assert.strictEqual(S.slug("Inicio de sesión con Google!"), "inicio-de-sesion-con-google");
    assert.strictEqual(S.slug("   "), "caso");
    assert.strictEqual(S.nombreSeguro("../../Captura de pantalla 2026.PNG"), "captura-de-pantalla-2026.png");
    assert.strictEqual(S.nombreSeguro("con:dos*puntos?.txt"), "con-dos-puntos.txt");
  },

  "normalizar arregla valores inválidos"() {
    const e = S.normalizarEscenario({ titulo: "  x ", tipo: "raro", prioridad: "urgente", estado: "ok", pasos: "1. uno\n- dos\n\n3) tres" }, "E07");
    assert.strictEqual(e.id, "E07");
    assert.strictEqual(e.tipo, "otro");
    assert.strictEqual(e.prioridad, "media");
    assert.strictEqual(e.estado, "pendiente");
    assert.deepStrictEqual(e.pasos, ["uno", "dos", "tres"]);
    const p = S.normalizarPlan({ escenarios: [{ id: "E01" }, { id: "E01" }, {}] });
    assert.deepStrictEqual(p.escenarios.map((x) => x.id), ["E01", "E02", "E03"]);
  },

  "adjuntos con ruta peligrosa se descartan"() {
    const e = S.normalizarEscenario({ adjuntos: [{ archivo: "../../secreto.txt" }, { archivo: "adjuntos\\E01-01-a.png" }] }, "E01");
    assert.strictEqual(e.adjuntos.length, 1);
    assert.strictEqual(e.adjuntos[0].archivo, "adjuntos/E01-01-a.png");
    assert.strictEqual(S.rutaAdjunto("/x/plan", "../fuera.txt"), null);
    assert.strictEqual(S.rutaAdjunto("/x/plan", "adjuntos/../sol.json"), null);
  },

  "criterios del caso"() {
    const c = S.criterios(CASO);
    assert.ok(c.some((x) => x.includes("Continuar con Google")));
    assert.ok(c.some((x) => x.startsWith("Si el correo")));
    assert.ok(c.some((x) => x.startsWith("Sin internet")));
  },

  "plantilla sin internet"() {
    const lista = S.plantillaPorReglas(CASO);
    assert.ok(lista.length >= 8, "pocos escenarios: " + lista.length);
    assert.ok(lista.some((e) => e.tipo === "permisos"), "inicio de sesión debería traer permisos");
    assert.ok(lista.some((e) => e.tipo === "ui"), "Android debería traer girar la pantalla");
    assert.ok(lista.find((e) => e.titulo.startsWith("Sin internet")).tipo === "error");
    assert.deepStrictEqual(lista.map((e) => e.id).slice(0, 3), ["E01", "E02", "E03"]);
    const sinRepetir = S.plantillaPorReglas(CASO, { existentes: lista.map((e) => e.titulo) });
    assert.strictEqual(sinRepetir.length, 0);
    const corto = S.plantillaPorReglas("Exportar el reporte mensual");
    assert.ok(corto[0].titulo.startsWith("Flujo principal"));
  },

  async "Gemini responde bien"() {
    let pedido = null;
    const r = await S.generarEscenarios(CASO, {
      clave: "k",
      fetch: async (url, op) => { pedido = { url, op }; return geminiCon([
        { titulo: "Login correcto", tipo: "feliz", prioridad: "alta", precondiciones: "Cuenta Google", pasos: ["Abrir", "Pulsar"], esperado: "Entra" },
        { titulo: "Sin pasos", tipo: "feliz", prioridad: "alta", pasos: [], esperado: "x" },
        { titulo: "Tipo raro", tipo: "zzz", prioridad: "alta", pasos: ["a"], esperado: "b" },
      ]); },
    });
    assert.strictEqual(r.fuente, "gemini");
    assert.strictEqual(r.escenarios.length, 2, "el escenario sin pasos se descarta");
    assert.strictEqual(r.escenarios[1].tipo, "otro");
    assert.ok(pedido.url.includes("gemini-3.5-flash-lite:generateContent"));
    assert.strictEqual(pedido.op.headers["x-goog-api-key"], "k");
    const cuerpo = JSON.parse(pedido.op.body);
    assert.strictEqual(cuerpo.generationConfig.responseMimeType, "application/json");
    assert.ok(cuerpo.contents[0].parts[0].text.includes("Continuar con Google"));
  },

  async "Gemini con más escenarios no repite"() {
    let prompt = "";
    const r = await S.generarEscenarios(CASO, {
      clave: "k", existentes: ["Login correcto"],
      fetch: async (u, op) => { prompt = JSON.parse(op.body).contents[0].parts[0].text; return geminiCon([
        { titulo: "Login  correcto", tipo: "feliz", prioridad: "alta", pasos: ["a"], esperado: "b" },
        { titulo: "Cuenta suspendida", tipo: "error", prioridad: "media", pasos: ["a"], esperado: "b" },
      ]); },
    });
    assert.ok(prompt.includes("NO los repitas") && prompt.includes("1. Login correcto"));
    assert.deepStrictEqual(r.escenarios.map((e) => e.titulo), ["Cuenta suspendida"]);
  },

  async "Gemini falla: usa la plantilla"() {
    const casos = [
      [async () => respuesta(429, {}), /límite gratuito/],
      [async () => respuesta(403, {}), /rechazó la clave/],
      [async () => respuesta(503, {}), /no está disponible/],
      [async () => respuesta(200, { promptFeedback: { blockReason: "SAFETY" } }), /SAFETY/],
      [async () => respuesta(200, { candidates: [{ content: { parts: [{ text: "no es json" }] } }] }), /No pude usar/],
      [async () => { throw new Error("ENOTFOUND"); }, /ENOTFOUND/],
    ];
    for (const [f, re] of casos) {
      const r = await S.generarEscenarios(CASO, { clave: "k", fetch: f });
      assert.strictEqual(r.fuente, "plantilla");
      assert.ok(re.test(r.aviso), r.aviso);
      assert.ok(r.escenarios.length >= 5);
    }
    const sin = await S.generarEscenarios(CASO, {});
    assert.ok(/Sin clave/.test(sin.aviso));
    const vacio = await S.generarEscenarios("   ", { clave: "k" });
    assert.strictEqual(vacio.escenarios.length, 0);
  },

  "extraer JSON con cercas"() {
    assert.deepStrictEqual(S.extraerJson("```json\n[1,2]\n```"), [1, 2]);
    assert.deepStrictEqual(S.extraerJson("Aquí van: [3] listo"), [3]);
  },

  "clave compartida con La Justicia"() {
    const antes = { APPDATA: process.env.APPDATA, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
    const dir = tmp();
    try {
      process.env.APPDATA = dir;
      delete process.env.GEMINI_API_KEY;
      assert.strictEqual(S.leerClaveGuardada().clave, "");
      fs.mkdirSync(path.join(dir, "Justicia"));
      fs.writeFileSync(path.join(dir, "Justicia", "config.json"), JSON.stringify({ clave: "de-justicia" }));
      assert.deepStrictEqual([S.leerClaveGuardada().clave, S.leerClaveGuardada().origen], ["de-justicia", "configuración de La Justicia"]);
      S.guardarClave("propia");
      assert.strictEqual(S.leerClaveGuardada().clave, "propia");
      process.env.GEMINI_API_KEY = "env";
      assert.strictEqual(S.leerClaveGuardada().clave, "env");
    } finally {
      for (const [k, v] of Object.entries(antes)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  },

  "crear, guardar, listar y adjuntar"() {
    const raiz = path.join(tmp(), "pruebas");
    const c1 = S.crearCarpetaPlan(raiz, "Login con Google", "2026-11-06T10:00:00");
    const c2 = S.crearCarpetaPlan(raiz, "Login con Google", "2026-11-06T10:00:00");
    assert.strictEqual(path.basename(c1), "2026-11-06-login-con-google");
    assert.strictEqual(path.basename(c2), "2026-11-06-login-con-google-2");
    const plan = S.normalizarPlan({ titulo: "Login", caso: CASO, escenarios: S.plantillaPorReglas(CASO).slice(0, 3) });
    const a1 = S.agregarAdjunto(c1, plan, "E01", "Captura 1.PNG", png(4, 3, [255, 0, 0]));
    const a2 = S.agregarAdjunto(c1, plan, "E01", "log.txt", Buffer.from("hola"));
    const a3 = S.agregarAdjunto(c1, plan, "E02", "Captura 1.PNG", png(4, 3, [0, 0, 255]));
    assert.deepStrictEqual([a1.archivo, a2.archivo, a3.archivo], ["adjuntos/E01-01-captura-1.png", "adjuntos/E01-02-log.txt", "adjuntos/E02-01-captura-1.png"]);
    assert.strictEqual(a1.tipo, "image/png");
    assert.throws(() => S.agregarAdjunto(c1, plan, "E99", "x.png", Buffer.from("x")), /No existe/);
    assert.throws(() => S.agregarAdjunto(c1, plan, "E01", "grande.bin", Buffer.alloc(S.MAX_ADJUNTO + 1)), /25 MB/);
    plan.escenarios[0].estado = "paso";
    S.guardarPlan(c1, plan);
    const leido = S.leerPlan(c1);
    assert.strictEqual(leido.escenarios[0].adjuntos.length, 2);
    assert.strictEqual(leido.escenarios[0].estado, "paso");
    // quitar adjunto borra el archivo; quitar escenario borra los suyos
    assert.ok(S.quitarAdjunto(c1, leido, "E01", a2.archivo));
    assert.ok(!fs.existsSync(path.join(c1, a2.archivo)));
    assert.ok(!S.quitarAdjunto(c1, leido, "E01", "adjuntos/no-existe.png"));
    assert.ok(S.quitarEscenario(c1, leido, "E02"));
    assert.ok(!fs.existsSync(path.join(c1, a3.archivo)));
    S.guardarPlan(c1, leido);
    fs.writeFileSync(path.join(c2, "sol.json"), "{dañado");
    const lista = S.listarPlanes(raiz);
    assert.strictEqual(lista.length, 2);
    assert.ok(lista.some((p) => p.error));
    assert.ok(!fs.readdirSync(c1).some((f) => f.endsWith(".tmp")), "no deben quedar temporales");
  },

  "nuevo escenario y sumar escenarios"() {
    const plan = S.normalizarPlan({ escenarios: [{ id: "E01" }, { id: "E03" }] });
    assert.strictEqual(S.nuevoEscenario(plan, { id: "E01", titulo: "x" }).id, "E02");
    const ag = S.sumarEscenarios(plan, [{ id: "E01", titulo: "a", estado: "paso", adjuntos: [{ archivo: "adjuntos/x.png" }] }]);
    assert.strictEqual(ag[0].id, "E04");
    assert.strictEqual(ag[0].estado, "pendiente");
    assert.strictEqual(ag[0].adjuntos.length, 0);
  },

  "resumen y veredicto"() {
    const p = (estados) => S.resumen(S.normalizarPlan({ escenarios: estados.map((estado) => ({ estado })) }));
    assert.strictEqual(p([]).veredicto, "vacio");
    assert.strictEqual(p(["paso", "no-aplica"]).veredicto, "aprobado");
    assert.strictEqual(p(["paso", "pendiente"]).veredicto, "incompleto");
    assert.strictEqual(p(["paso", "bloqueado"]).veredicto, "incompleto");
    assert.strictEqual(p(["paso", "fallo", "pendiente"]).veredicto, "fallos");
    assert.strictEqual(p(["paso", "pendiente"]).revisados, 1);
  },

  "texto seguro para el PDF"() {
    assert.strictEqual(I.seguro("Ñandú → ✅ “ok” – 5€ 😀"), "Ñandú -> OK “ok” – 5€ ");
    assert.strictEqual(I.seguro("Ł ż ő"), "L z o");
    assert.strictEqual(I.seguro("中文"), "??");
  },

  async "PDF completo con imágenes, archivos y textos largos"() {
    const raiz = path.join(tmp(), "pruebas");
    const c = S.crearCarpetaPlan(raiz, "Plan del PDF");
    const largo = Array(80).fill("Paso con mucho texto para obligar a que el informe pase de página. ").join("");
    const plan = S.normalizarPlan({
      titulo: "Plan del PDF — ñandú ✅", caso: CASO + "\n" + largo, responsable: "David", fuente: "gemini",
      escenarios: [
        { titulo: "Con captura", tipo: "feliz", prioridad: "alta", pasos: ["Uno", "Dos"], esperado: "Funciona", estado: "paso", observacion: "Todo bien 😀" },
        { titulo: "Con archivo y captura dañada", tipo: "error", prioridad: "media", pasos: [largo], esperado: "Aviso", estado: "fallo" },
        { titulo: "Sin evidencias", tipo: "borde", prioridad: "baja", pasos: ["x"], esperado: "y", estado: "bloqueado" },
        { titulo: "Pendiente", pasos: ["x"], esperado: "y" },
      ],
    });
    S.agregarAdjunto(c, plan, "E01", "alta.png", png(40, 400, [31, 42, 92]));
    S.agregarAdjunto(c, plan, "E01", "ancha.png", png(900, 60, [244, 165, 130]));
    S.agregarAdjunto(c, plan, "E02", "logcat.txt", Buffer.from("E/Auth: timeout\n"));
    S.agregarAdjunto(c, plan, "E02", "dañada.png", Buffer.from("no soy un png"));
    plan.escenarios[2].adjuntos.push({ archivo: "adjuntos/E03-01-se-borro.png", nombre: "se-borro.png", tipo: "image/png", bytes: 10 });
    S.guardarPlan(c, plan);
    const r = await I.generarInforme(c, { git: { repositorio: "codelock-android", rama: "main", commit: "abc1234", autor: "davidsant7e" }, fecha: "2026-11-06T13:30:00Z" });
    assert.strictEqual(path.basename(r.ruta), path.basename(c) + ".pdf");
    assert.ok(r.paginas >= 4, "páginas: " + r.paginas);
    assert.strictEqual(r.adjuntados, 2, "logcat y la imagen dañada van adjuntos dentro del PDF");
    assert.strictEqual(r.resumen.veredicto, "fallos");
    let txt = "";
    try {
      txt = execFileSync("pdftotext", ["-layout", r.ruta, "-"], { encoding: "utf8" });
    } catch (e) {
      return; // sin pdftotext (Windows): basta con que se haya generado
    }
    for (const t of ["Informe de pruebas", "CON FALLOS", "codelock-android", "abc1234", "Gemini (revisados", "Resumen de escenarios".toUpperCase(),
      "E01", "Con captura", "Todo bien", "alta.png", "logcat.txt", "va adjunto dentro de este PDF", "no se encontró el archivo", "Página 1 de", "ñandú OK"]) {
      assert.ok(txt.includes(t), "falta en el PDF: " + t);
    }
    const adj = execFileSync("pdfdetach", ["-list", r.ruta], { encoding: "utf8" });
    assert.ok(/E02-01-logcat\.txt/.test(adj) && /E02-02-danada\.png/.test(adj), adj);
    // regenerar reemplaza el anterior
    const r2 = await I.generarInforme(c);
    assert.strictEqual(r2.ruta, r.ruta);
  },

  async "PDF de un plan vacío"() {
    const c = S.crearCarpetaPlan(path.join(tmp(), "pruebas"), "Vacío");
    S.guardarPlan(c, { titulo: "Vacío" });
    const r = await I.generarInforme(c, { git: {} });
    assert.strictEqual(r.paginas, 1);
    assert.strictEqual(r.resumen.veredicto, "vacio");
  },

  "datos de git"() {
    const dir = tmp();
    const sinGit = S.datosGit(dir);
    assert.strictEqual(sinGit.commit, "");
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Prueba", "-c", "user.email=p@x", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Prueba"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "https://token123@github.com/davidsant7e/demo.git"], { cwd: dir });
    } catch (e) {
      return; // sin git
    }
    const g = S.datosGit(dir);
    assert.strictEqual(g.rama, "main");
    assert.strictEqual(g.commit.length >= 7, true);
    assert.strictEqual(g.autor, "Prueba");
    assert.strictEqual(g.repositorio, "demo");
    assert.ok(!g.remoto.includes("token123"), "no debe filtrar credenciales del remoto");
  },

  async "Gemini: si el fetch de VS Code falla, se repite en un proceso aparte"() {
    const S = require("../vscode/nucleo/sol.js");
    const roto = async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNRESET", message: "socket hang up" }; throw e; };
    const lista = [{ titulo: "Abre la app", tipo: "camino-feliz", prioridad: "alta", pasos: ["Abrir"], esperado: "Se ve el mazo" }];
    const cuerpo = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(lista) }] } }] });
    let pedido = null;
    const r = await S.generarEscenarios("El Mazo abre las apps", { clave: "k", fetch: roto, respaldo: async (p) => { pedido = p; return { status: 200, cuerpo }; } });
    assert.strictEqual(r.fuente, "gemini");
    assert.strictEqual(pedido.method, "POST");
    assert.ok(pedido.headers["x-goog-api-key"] === "k");
    const r2 = await S.generarEscenarios("El Mazo abre las apps", { clave: "k", fetch: roto, respaldo: async () => ({ error: "fetch failed", causa: "ENOTFOUND" }) });
    assert.strictEqual(r2.fuente, "plantilla");
    assert.ok(/ENOTFOUND/.test(r2.aviso) && /ECONNRESET/.test(r2.aviso), r2.aviso);
  },

  async "Gemini: peticion.js hace la petición en un proceso aparte"() {
    const http = require("http");
    const S = require("../vscode/nucleo/sol.js");
    const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { res.writeHead(201); res.end("eco:" + req.method + ":" + b); }); });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const url = "http://127.0.0.1:" + srv.address().port + "/x";
    try {
      const r = await S.fetchConRespaldo(url, { method: "POST", headers: {}, body: "hola" }, { fetch: async () => { throw new TypeError("fetch failed"); }, respaldo: null });
      assert.fail("sin respaldo explícito en pruebas debe relanzar");
    } catch (e) { assert.ok(/fetch failed/.test(e.message)); }
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    try {
      const r = await S.fetchConRespaldo(url, { method: "POST", headers: {}, body: "hola" }, {});
      assert.strictEqual(r.status, 201);
      assert.strictEqual(await r.text(), "eco:POST:hola");
    } finally { globalThis.fetch = orig; srv.close(); }
  },
};
