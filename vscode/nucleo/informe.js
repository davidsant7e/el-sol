"use strict";
/**
 * XIX · El Sol — informe PDF de un plan de pruebas.
 * Usa pdf-lib (MIT) incluido en vendor/, sin instalar nada.
 *
 *  Portada: veredicto, barra de resultados, datos del repositorio.
 *  Caso de desarrollo.
 *  Tabla resumen de escenarios.
 *  Detalle de cada escenario: pasos, resultado esperado, observación y evidencias
 *  (PNG/JPG dentro de la página; los demás archivos van adjuntos dentro del PDF).
 */

const fs = require("fs");
const path = require("path");
const S = require("./sol.js");
const { PDFDocument, StandardFonts, rgb } = require("../vendor/pdf-lib.min.js");

const A4 = [595.28, 841.89];
const MARGEN = 48;
const ANCHO = A4[0] - MARGEN * 2;
const PIE = 40; // espacio reservado abajo para el pie de página
const MAX_ADJUNTOS_PDF = 60 * 1024 * 1024;

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const C = {
  azul: hex("#1f2a5c"),
  durazno: hex("#f4a582"),
  texto: hex("#1b1f2e"),
  gris: hex("#5b6275"),
  linea: hex("#d5d9e4"),
  fondo: hex("#eef0f7"),
  blanco: rgb(1, 1, 1),
};

const COLOR_ESTADO = {
  paso: hex("#2f7d4f"),
  fallo: hex("#b3261e"),
  bloqueado: hex("#a85d00"),
  pendiente: hex("#6b7280"),
  "no-aplica": hex("#9aa0aa"),
};

const COLOR_VEREDICTO = {
  aprobado: COLOR_ESTADO.paso,
  fallos: COLOR_ESTADO.fallo,
  incompleto: COLOR_ESTADO.bloqueado,
  vacio: COLOR_ESTADO.pendiente,
};

// ---------------------------------------------------------------- texto seguro para las fuentes estándar (WinAnsi)

const EXTRA_WINANSI = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const REEMPLAZOS = {
  "→": "->", "←": "<-", "⇒": "=>", "↑": "^", "↓": "v", "≥": ">=", "≤": "<=", "≠": "!=", "≈": "~",
  "✓": "OK", "✔": "OK", "✅": "OK", "✗": "X", "✘": "X", "✖": "X", "❌": "X", "⚠": "!", "⚠️": "!",
  "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "ı": "i", "‐": "-", "‑": "-", "‒": "-", "−": "-", " ": " ", " ": " ", " ": " ", "\t": "    ",
};

function seguro(t) {
  let s = String(t == null ? "" : t).normalize("NFC");
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\n") out += ch;
    else if (REEMPLAZOS[ch] !== undefined) out += REEMPLAZOS[ch];
    else if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || EXTRA_WINANSI.includes(ch)) out += ch;
    else if (c === 0xfe0f || c === 0x200d) continue; // modificadores de emoji
    else {
      const sinTilde = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      out += /^[\x20-\x7e]$/.test(sinTilde) ? sinTilde : c > 0xffff ? "" : "?";
    }
  }
  return out;
}

/** Parte el texto en líneas que caben en `ancho` (respeta saltos de línea; corta palabras muy largas). */
function partir(t, fuente, tam, ancho) {
  const lineas = [];
  for (const parrafo of seguro(t).split("\n")) {
    if (!parrafo.trim()) { lineas.push(""); continue; }
    let actual = "";
    for (let palabra of parrafo.split(/ +/)) {
      while (fuente.widthOfTextAtSize(palabra, tam) > ancho) {
        let corte = palabra.length - 1;
        while (corte > 1 && fuente.widthOfTextAtSize(palabra.slice(0, corte), tam) > ancho) corte--;
        if (actual) { lineas.push(actual); actual = ""; }
        lineas.push(palabra.slice(0, corte));
        palabra = palabra.slice(corte);
      }
      const prueba = actual ? actual + " " + palabra : palabra;
      if (fuente.widthOfTextAtSize(prueba, tam) <= ancho) actual = prueba;
      else { lineas.push(actual); actual = palabra; }
    }
    lineas.push(actual);
  }
  while (lineas.length && lineas[lineas.length - 1] === "") lineas.pop();
  return lineas;
}

function recortarA(t, fuente, tam, ancho) {
  let s = seguro(t).replace(/\n/g, " ");
  if (fuente.widthOfTextAtSize(s, tam) <= ancho) return s;
  while (s.length > 1 && fuente.widthOfTextAtSize(s + "…", tam) > ancho) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

function tamanoLegible(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
}

function fechaLarga(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d)) return "";
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const p = (n) => String(n).padStart(2, "0");
  return d.getDate() + " de " + meses[d.getMonth()] + " de " + d.getFullYear() + ", " + p(d.getHours()) + ":" + p(d.getMinutes());
}

// ---------------------------------------------------------------- maquetador simple

class Lienzo {
  constructor(doc, fuentes) {
    this.doc = doc;
    this.f = fuentes;
    this.pagina = null;
    this.y = 0;
    this.nueva();
  }

  nueva() {
    this.pagina = this.doc.addPage(A4);
    this.y = A4[1] - MARGEN;
    return this.pagina;
  }

  /** Si no caben `alto` puntos, pasa a la página siguiente. Devuelve true si cambió de página. */
  espacio(alto) {
    if (this.y - alto < MARGEN + PIE) { this.nueva(); return true; }
    return false;
  }

  texto(t, x, y, o) {
    const op = Object.assign({ tam: 10, fuente: this.f.normal, color: C.texto }, o);
    this.pagina.drawText(seguro(t), { x, y, size: op.tam, font: op.fuente, color: op.color });
  }

  /** Letras separadas, como el nombre de las cartas. */
  espaciado(t, x, y, o) {
    const op = Object.assign({ tam: 10, fuente: this.f.negrita, color: C.durazno, sep: 3, centro: false }, o);
    const s = seguro(t);
    let ancho = 0;
    for (const ch of s) ancho += op.fuente.widthOfTextAtSize(ch, op.tam) + op.sep;
    ancho -= op.sep;
    let cx = op.centro ? x - ancho / 2 : x;
    for (const ch of s) {
      this.pagina.drawText(ch, { x: cx, y, size: op.tam, font: op.fuente, color: op.color });
      cx += op.fuente.widthOfTextAtSize(ch, op.tam) + op.sep;
    }
    return ancho;
  }

  /** Párrafo con salto de página automático. */
  parrafo(t, o) {
    const op = Object.assign({ tam: 10, fuente: this.f.normal, color: C.texto, x: MARGEN, ancho: ANCHO, interlineado: 1.38, sangria: 0 }, o);
    const alto = op.tam * op.interlineado;
    const lineas = partir(t, op.fuente, op.tam, op.ancho - op.sangria);
    lineas.forEach((l) => {
      this.espacio(alto);
      this.y -= alto;
      if (l) this.texto(l, op.x + op.sangria, this.y + op.tam * 0.25, { tam: op.tam, fuente: op.fuente, color: op.color });
    });
    return lineas.length;
  }

  subtitulo(t) {
    this.espacio(30);
    this.y -= 22;
    this.texto(t.toUpperCase(), MARGEN, this.y, { tam: 9, fuente: this.f.negrita, color: C.gris });
    this.y -= 6;
  }

  linea(y, color) {
    this.pagina.drawLine({ start: { x: MARGEN, y }, end: { x: MARGEN + ANCHO, y }, thickness: 0.6, color: color || C.linea });
  }

  /** Etiqueta de color con el estado (texto blanco sobre el color, para que no dependa solo del color). */
  chip(texto, color, xDerecha, yBase, tam) {
    const t = seguro(texto).toUpperCase();
    const s = tam || 8;
    const w = this.f.negrita.widthOfTextAtSize(t, s) + 12;
    const h = s + 7;
    this.pagina.drawRectangle({ x: xDerecha - w, y: yBase - 4, width: w, height: h, color });
    this.texto(t, xDerecha - w + 6, yBase, { tam: s, fuente: this.f.negrita, color: C.blanco });
    return w;
  }
}

// ---------------------------------------------------------------- el sol (símbolo de la carta XIX)

function dibujarSol(pagina, cx, cy, r, color) {
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * 2 * i) / 12;
    const r1 = r + 4;
    const r2 = r + (i % 2 ? 9 : 14);
    pagina.drawLine({
      start: { x: cx + Math.cos(a) * r1, y: cy + Math.sin(a) * r1 },
      end: { x: cx + Math.cos(a) * r2, y: cy + Math.sin(a) * r2 },
      thickness: 2.2, color,
    });
  }
  pagina.drawCircle({ x: cx, y: cy, size: r, color });
}

// ---------------------------------------------------------------- partes del informe

function portada(L, plan, r, git, fecha) {
  const p = L.pagina;
  const altoBanda = 190;
  p.drawRectangle({ x: 0, y: A4[1] - altoBanda, width: A4[0], height: altoBanda, color: C.azul });
  dibujarSol(p, A4[0] - MARGEN - 34, A4[1] - 74, 20, C.durazno);
  L.espaciado("XIX · EL SOL", MARGEN, A4[1] - 52, { tam: 9, sep: 3.2 });
  L.texto("Informe de pruebas", MARGEN, A4[1] - 92, { tam: 26, fuente: L.f.negrita, color: C.blanco });
  const lineasTitulo = partir(plan.titulo, L.f.negrita, 15, ANCHO - 90).slice(0, 3);
  let yt = A4[1] - 120;
  for (const l of lineasTitulo) { L.texto(l, MARGEN, yt, { tam: 15, fuente: L.f.negrita, color: C.durazno }); yt -= 19; }
  L.y = A4[1] - altoBanda - 34;

  // veredicto
  const color = COLOR_VEREDICTO[r.veredicto];
  L.texto("Resultado", MARGEN, L.y, { tam: 9, fuente: L.f.negrita, color: C.gris });
  L.y -= 30;
  L.texto(S.VEREDICTOS[r.veredicto].toUpperCase(), MARGEN, L.y, { tam: 24, fuente: L.f.negrita, color });
  L.y -= 20;
  const partes = [r.total + (r.total === 1 ? " escenario" : " escenarios")];
  for (const k of ["paso", "fallo", "bloqueado", "pendiente", "no-aplica"]) if (r[k]) partes.push(r[k] + " " + S.ESTADOS[k].etiqueta.toLowerCase());
  L.texto(partes.join("  ·  "), MARGEN, L.y, { tam: 10.5, color: C.texto });

  // barra proporcional por estado
  L.y -= 26;
  const altoBarra = 14;
  let x = MARGEN;
  if (r.total) {
    for (const k of ["paso", "fallo", "bloqueado", "pendiente", "no-aplica"]) {
      if (!r[k]) continue;
      const w = (ANCHO * r[k]) / r.total;
      p.drawRectangle({ x, y: L.y, width: Math.max(w - 1.5, 1), height: altoBarra, color: COLOR_ESTADO[k] });
      x += w;
    }
  } else {
    p.drawRectangle({ x, y: L.y, width: ANCHO, height: altoBarra, color: C.fondo });
  }
  // leyenda
  L.y -= 18;
  x = MARGEN;
  for (const k of ["paso", "fallo", "bloqueado", "pendiente", "no-aplica"]) {
    p.drawRectangle({ x, y: L.y - 1, width: 8, height: 8, color: COLOR_ESTADO[k] });
    const et = S.ESTADOS[k].etiqueta + " (" + r[k] + ")";
    L.texto(et, x + 12, L.y, { tam: 8.5, color: C.gris });
    x += 12 + L.f.normal.widthOfTextAtSize(et, 8.5) + 18;
  }

  // ficha
  L.y -= 34;
  const filas = [
    ["Repositorio", git.repositorio || "—"],
    ["Rama", git.rama || "—"],
    ["Commit", git.commit || "—"],
    ["Responsable", plan.responsable || git.autor || "—"],
    ["Fecha del informe", fechaLarga(fecha)],
    ["Plan creado", fechaLarga(plan.creado)],
    ["Escenarios generados con", plan.fuente === "gemini" ? "Gemini (revisados por el probador)" : plan.fuente === "mixta" ? "Gemini y plantilla" : "Plantilla por reglas"],
    ["Evidencias", r.adjuntos + (r.adjuntos === 1 ? " archivo" : " archivos")],
  ];
  L.linea(L.y + 12);
  for (const [k, v] of filas) {
    L.texto(k, MARGEN, L.y, { tam: 9.5, color: C.gris });
    L.texto(recortarA(v, L.f.normal, 9.5, ANCHO - 160), MARGEN + 160, L.y, { tam: 9.5 });
    L.y -= 8;
    L.linea(L.y);
    L.y -= 13;
  }
}

function seccionCaso(L, plan) {
  if (!plan.caso) return;
  L.y -= 6;
  L.subtitulo("Caso de desarrollo");
  L.y -= 4;
  L.parrafo(plan.caso, { tam: 10 });
}

function tablaResumen(L, plan) {
  L.nueva();
  L.subtitulo("Resumen de escenarios");
  const col = { id: MARGEN, titulo: MARGEN + 36, tipo: MARGEN + 276, prio: MARGEN + 366, evid: MARGEN + 418, estado: MARGEN + ANCHO };
  const cabecera = () => {
    L.y -= 18;
    L.pagina.drawRectangle({ x: MARGEN, y: L.y - 5, width: ANCHO, height: 18, color: C.azul });
    const op = { tam: 8, fuente: L.f.negrita, color: C.blanco };
    L.texto("ID", col.id + 4, L.y, op);
    L.texto("ESCENARIO", col.titulo, L.y, op);
    L.texto("TIPO", col.tipo, L.y, op);
    L.texto("PRIORIDAD", col.prio, L.y, op);
    L.texto("EVID.", col.evid, L.y, op);
    const w = L.f.negrita.widthOfTextAtSize("ESTADO", 8);
    L.texto("ESTADO", col.estado - w - 4, L.y, op);
    L.y -= 8;
  };
  cabecera();
  plan.escenarios.forEach((e, i) => {
    const lineas = partir(e.titulo, L.f.normal, 9, col.tipo - col.titulo - 10).slice(0, 3);
    const alto = Math.max(lineas.length * 12, 12) + 9;
    if (L.espacio(alto)) cabecera();
    if (i % 2 === 1) L.pagina.drawRectangle({ x: MARGEN, y: L.y - alto, width: ANCHO, height: alto, color: C.fondo });
    const yb = L.y - 13;
    L.texto(e.id, col.id + 4, yb, { tam: 9, fuente: L.f.negrita, color: C.azul });
    lineas.forEach((l, j) => L.texto(l, col.titulo, yb - j * 12, { tam: 9 }));
    L.texto(S.TIPOS[e.tipo], col.tipo, yb, { tam: 8.5, color: C.gris });
    L.texto(S.PRIORIDADES[e.prioridad], col.prio, yb, { tam: 8.5, color: C.gris });
    L.texto(e.adjuntos.length ? String(e.adjuntos.length) : "—", col.evid + 6, yb, { tam: 8.5, color: C.gris });
    L.chip(S.ESTADOS[e.estado].etiqueta, COLOR_ESTADO[e.estado], col.estado - 2, yb, 7.5);
    L.y -= alto;
  });
}

async function detalleEscenario(L, e, carpeta, contexto) {
  // encabezado del escenario (que no quede solo al pie de una página)
  const lineasTitulo = partir(e.titulo, L.f.negrita, 12, ANCHO - 120);
  const altoCab = lineasTitulo.length * 15 + 16;
  L.espacio(altoCab + 60);
  L.y -= 14;
  L.pagina.drawRectangle({ x: MARGEN, y: L.y - altoCab + 10, width: ANCHO, height: altoCab, color: C.fondo });
  L.pagina.drawRectangle({ x: MARGEN, y: L.y - altoCab + 10, width: 3, height: altoCab, color: COLOR_ESTADO[e.estado] });
  let yt = L.y - 8;
  L.texto(e.id, MARGEN + 12, yt, { tam: 12, fuente: L.f.negrita, color: C.azul });
  lineasTitulo.forEach((l, j) => L.texto(l, MARGEN + 48, yt - j * 15, { tam: 12, fuente: L.f.negrita }));
  L.chip(S.ESTADOS[e.estado].etiqueta, COLOR_ESTADO[e.estado], MARGEN + ANCHO - 8, yt, 8);
  L.y -= altoCab;
  L.texto(S.TIPOS[e.tipo] + "  ·  Prioridad " + S.PRIORIDADES[e.prioridad].toLowerCase(), MARGEN + 12, L.y, { tam: 8.5, color: C.gris });
  if (e.automatizacion) {
    const E = require("./e2e.js");
    const a = e.automatizacion;
    const u = a.ultima;
    L.y -= 12;
    L.texto(recortarA("Prueba automática: " + E.PLATAFORMAS[a.plataforma] + " · " + E.ORIGENES[a.origen] + " · " + a.archivo +
      (u ? " · última ejecución: " + (u.estado === "paso" ? "pasó" : u.estado === "fallo" ? "falló" : "omitida") + " en " + E.duracionLegible(u.duracionMs) : " · sin ejecutar"),
      L.f.normal, 8.5, ANCHO - 12), MARGEN + 12, L.y, { tam: 8.5, color: C.gris });
  }
  L.y -= 6;

  const etiqueta = (t) => {
    L.espacio(28);
    L.y -= 16;
    L.texto(t, MARGEN + 12, L.y, { tam: 8.5, fuente: L.f.negrita, color: C.azul });
    L.y -= 2;
  };
  const cuerpo = { tam: 9.8, x: MARGEN + 12, ancho: ANCHO - 12 };

  if (e.precondiciones) { etiqueta("PRECONDICIONES"); L.parrafo(e.precondiciones, cuerpo); }
  if (e.pasos.length) {
    etiqueta("PASOS");
    e.pasos.forEach((paso, i) => {
      const alto = cuerpo.tam * 1.38;
      L.espacio(alto); // así la primera línea del paso y su número quedan en la misma página
      const pagina = L.pagina;
      const yNum = L.y - alto + cuerpo.tam * 0.25;
      L.parrafo(paso, Object.assign({}, cuerpo, { sangria: 18 }));
      pagina.drawText((i + 1) + ".", { x: cuerpo.x, y: yNum, size: cuerpo.tam, font: L.f.negrita, color: C.gris });
    });
  }
  if (e.esperado) { etiqueta("RESULTADO ESPERADO"); L.parrafo(e.esperado, cuerpo); }
  etiqueta("OBSERVACIÓN");
  L.parrafo(e.observacion || "Sin observaciones.", Object.assign({}, cuerpo, e.observacion ? {} : { fuente: L.f.cursiva, color: C.gris }));

  if (e.adjuntos.length) {
    const preparadas = [];
    for (const a of e.adjuntos) preparadas.push(await prepararEvidencia(L, a, carpeta));
    // la etiqueta no se queda sola al pie: reserva lugar para la primera evidencia
    L.espacio(28 + (preparadas[0].img ? preparadas[0].h + 30 : 14));
    etiqueta("EVIDENCIAS DE " + e.id + " (" + e.adjuntos.length + ")");
    for (const p of preparadas) await evidencia(L, p, contexto);
  }
  L.y -= 10;
}

/** Lee el archivo y, si es PNG/JPG válido, lo incrusta y calcula su tamaño en la página. */
async function prepararEvidencia(L, a, carpeta) {
  const ruta = S.rutaAdjunto(carpeta, a.archivo);
  const existe = !!ruta && fs.existsSync(ruta);
  const pie = path.basename(a.archivo) + (a.bytes ? "  ·  " + tamanoLegible(a.bytes) : "") + (a.nombre && a.nombre !== path.basename(a.archivo) ? "  ·  original: " + a.nombre : "");
  const prep = { a, existe, pie, datos: null, img: null, w: 0, h: 0 };
  if (!existe) return prep;
  prep.datos = fs.readFileSync(ruta);
  if (S.esImagenIncrustable(a)) {
    try {
      prep.img = prep.datos.slice(0, 4).toString("hex") === "89504e47" ? await L.doc.embedPng(prep.datos) : await L.doc.embedJpg(prep.datos);
    } catch (e) {
      prep.img = null; // imagen dañada o formato raro: se adjunta como archivo
    }
    if (prep.img) {
      const esc = Math.min((ANCHO - 24) / prep.img.width, 330 / prep.img.height, 1);
      prep.w = prep.img.width * esc;
      prep.h = prep.img.height * esc;
    }
  }
  return prep;
}

async function evidencia(L, prep, ctx) {
  const { a, pie, datos, img, w, h } = prep;
  if (!prep.existe) {
    L.parrafo("• " + pie + " — no se encontró el archivo en la carpeta del plan.", { tam: 9, x: MARGEN + 12, ancho: ANCHO - 12, color: COLOR_ESTADO.fallo });
    return;
  }
  if (img) {
    L.espacio(h + 30);
    L.y -= 8 + h;
    const x = MARGEN + 12;
    L.pagina.drawRectangle({ x: x - 0.6, y: L.y - 0.6, width: w + 1.2, height: h + 1.2, color: C.linea });
    L.pagina.drawImage(img, { x, y: L.y, width: w, height: h });
    L.y -= 12;
    L.texto(recortarA(pie, L.f.normal, 8, ANCHO - 24), x, L.y, { tam: 8, color: C.gris });
    L.y -= 4;
    return;
  }
  // otro tipo de archivo: va adjunto dentro del PDF
  let nota = "no se incluyó (el PDF ya lleva demasiados adjuntos)";
  if (ctx.bytesAdjuntos + datos.length <= MAX_ADJUNTOS_PDF) {
    await L.doc.attach(datos, path.basename(a.archivo), {
      mimeType: a.tipo || S.tipoMime(a.archivo),
      description: "Evidencia de " + a.archivo.split("/").pop().slice(0, 3),
      creationDate: new Date(a.agregado || Date.now()),
      modificationDate: new Date(a.agregado || Date.now()),
    });
    ctx.bytesAdjuntos += datos.length;
    ctx.adjuntados++;
    nota = "va adjunto dentro de este PDF (panel de adjuntos del lector)";
  }
  L.parrafo("• " + pie + " — " + nota + ".", { tam: 9, x: MARGEN + 12, ancho: ANCHO - 12, sangria: 0 });
}

function pies(doc, fuentes, plan) {
  const paginas = doc.getPages();
  const total = paginas.length;
  paginas.forEach((p, i) => {
    const y = 26;
    p.drawLine({ start: { x: MARGEN, y: y + 12 }, end: { x: MARGEN + ANCHO, y: y + 12 }, thickness: 0.5, color: C.linea });
    p.drawText(recortarA(plan.titulo, fuentes.normal, 7.5, 200), { x: MARGEN, y, size: 7.5, font: fuentes.normal, color: C.gris });
    const marca = "XIX · El Sol";
    const wm = fuentes.negrita.widthOfTextAtSize(marca, 7.5);
    p.drawText(marca, { x: A4[0] / 2 - wm / 2, y, size: 7.5, font: fuentes.negrita, color: C.durazno });
    const num = "Página " + (i + 1) + " de " + total;
    const wn = fuentes.normal.widthOfTextAtSize(num, 7.5);
    p.drawText(num, { x: MARGEN + ANCHO - wn, y, size: 7.5, font: fuentes.normal, color: C.gris });
  });
}

/**
 * Genera el PDF del plan que está en `carpeta`.
 * opciones: { git, fecha (ISO), salida (ruta del PDF) }
 * Devuelve { ruta, paginas, adjuntados }.
 */
async function generarInforme(carpeta, opciones) {
  const o = opciones || {};
  const plan = S.leerPlan(carpeta);
  const r = S.resumen(plan);
  const git = o.git || S.datosGit(carpeta);
  const fecha = o.fecha || new Date().toISOString();

  const doc = await PDFDocument.create();
  doc.setTitle(seguro("Informe de pruebas — " + plan.titulo));
  doc.setSubject(seguro(S.VEREDICTOS[r.veredicto] + ": " + r.paso + " de " + r.total + " escenarios pasaron"));
  doc.setAuthor(seguro(plan.responsable || git.autor || ""));
  doc.setCreator("XIX · El Sol");
  doc.setProducer("XIX · El Sol (pdf-lib)");
  doc.setLanguage("es");
  doc.setCreationDate(new Date(fecha));
  doc.setModificationDate(new Date(fecha));
  doc.setKeywords(["pruebas", "QA", "El Sol", git.repositorio || ""].filter(Boolean));

  const fuentes = {
    normal: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
    cursiva: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const L = new Lienzo(doc, fuentes);
  const ctx = { bytesAdjuntos: 0, adjuntados: 0 };

  portada(L, plan, r, git, fecha);
  seccionCaso(L, plan);
  if (plan.escenarios.length) {
    tablaResumen(L, plan);
    L.nueva();
    L.subtitulo("Detalle de los escenarios");
    for (const e of plan.escenarios) await detalleEscenario(L, e, carpeta, ctx);
  }
  pies(doc, fuentes, plan);

  const bytes = await doc.save();
  const ruta = o.salida || path.join(carpeta, path.basename(path.resolve(carpeta)) + ".pdf");
  const tmp = ruta + ".tmp";
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, ruta);
  } catch (e) {
    // en Windows falla si el PDF está abierto en un lector
    fs.unlinkSync(tmp);
    if (e.code === "EPERM" || e.code === "EBUSY") throw new Error("No pude reemplazar el PDF: ciérralo en el lector y vuelve a intentarlo.");
    throw e;
  }
  return { ruta, paginas: doc.getPageCount(), adjuntados: ctx.adjuntados, resumen: r };
}

module.exports = { generarInforme, seguro, partir };
