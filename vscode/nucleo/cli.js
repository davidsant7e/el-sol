#!/usr/bin/env node
"use strict";
/**
 * XIX · El Sol desde la terminal (sirve para Visual Studio, Android Studio o cualquier editor).
 *
 *   node cli.js nuevo "Título" caso.txt      crea pruebas/<fecha>-<título>/ con los escenarios
 *   node cli.js lista [carpeta-de-pruebas]    muestra los planes y su avance
 *   node cli.js pdf <carpeta-del-plan>        genera el PDF
 *   node cli.js clave <clave> [modelo]        guarda la clave de Gemini
 *   node cli.js e2e <carpeta-del-plan> [E03…] ejecuta las pruebas end-to-end y marca los escenarios
 *   node cli.js junit <carpeta-del-plan> <reporte.xml> "<comando>"
 *                                             corre tus pruebas (Cypress, Selenium…) y lee su JUnit
 *
 * Los estados y las evidencias se marcan en VS Code o Kiro, o editando sol.json.
 */
const fs = require("fs");
const path = require("path");
const S = require("./sol.js");

async function main(args) {
  const [orden, ...resto] = args;
  switch (orden) {
    case "nuevo": {
      const [titulo, archivo] = resto;
      if (!titulo) { console.log('Uso: node cli.js nuevo "Título" [caso.txt]   (sin archivo, lee el caso de la entrada estándar)'); return 1; }
      const caso = archivo && archivo !== "-" ? fs.readFileSync(archivo, "utf8") : fs.readFileSync(0, "utf8");
      const c = S.leerClaveGuardada();
      const r = await S.generarEscenarios(caso, { clave: c.clave, modelo: c.modelo });
      if (r.aviso) console.log("Aviso: " + r.aviso);
      const raiz = path.join(process.cwd(), "pruebas");
      const carpeta = S.crearCarpetaPlan(raiz, titulo);
      S.guardarPlan(carpeta, { titulo, caso, fuente: r.fuente, responsable: S.datosGit(process.cwd()).autor, escenarios: r.escenarios });
      console.log(r.escenarios.length + " escenarios (" + r.fuente + ") en " + path.relative(process.cwd(), carpeta));
      return 0;
    }
    case "lista": {
      const raiz = resto[0] || path.join(process.cwd(), "pruebas");
      const planes = S.listarPlanes(raiz);
      if (!planes.length) console.log("No hay planes en " + raiz);
      for (const p of planes) {
        const r = p.resumen;
        console.log((r ? S.VEREDICTOS[r.veredicto].padEnd(14) + (r.revisados + "/" + r.total).padEnd(7) : "¿dañado?".padEnd(21)) + p.titulo + "  →  " + path.relative(process.cwd(), p.carpeta));
      }
      return 0;
    }
    case "pdf": {
      if (!resto[0]) { console.log("Uso: node cli.js pdf <carpeta-del-plan>"); return 1; }
      const { generarInforme } = require("./informe.js");
      const r = await generarInforme(path.resolve(resto[0]));
      console.log("PDF: " + r.ruta + " (" + r.paginas + " páginas, " + S.VEREDICTOS[r.resumen.veredicto].toLowerCase() + ")");
      return 0;
    }
    case "clave": {
      if (!resto[0]) { console.log("Uso: node cli.js clave <clave-de-gemini> [modelo]"); return 1; }
      console.log("Clave guardada en " + S.guardarClave(resto[0], resto[1]));
      return 0;
    }
    case "e2e":
    case "junit": {
      const E = require("./e2e.js");
      const carpeta = resto[0] && path.resolve(resto[0]);
      if (!carpeta || !fs.existsSync(S.rutaPlan(carpeta))) { console.log("Uso: node cli.js " + orden + " <carpeta-del-plan> …"); return 1; }
      const plan = S.leerPlan(carpeta);
      const eco = (t) => process.stdout.write(t);
      let resultados = [];
      let extra = {};
      if (orden === "junit") {
        const [, reporte, comando] = resto;
        if (!reporte || !comando) { console.log('Uso: node cli.js junit <carpeta-del-plan> <reporte.xml> "<comando>"'); return 1; }
        resultados = (await E.ejecutarJUnit(comando, path.resolve(reporte), { cwd: process.cwd(), alSalir: eco })).resultados;
      } else {
        const ids = resto.slice(1);
        const web = await E.ejecutarWeb(carpeta, plan, ids, { raiz: process.cwd(), alSalir: eco });
        const android = await E.ejecutarAndroid(carpeta, plan, ids, { alSalir: eco });
        resultados = web.resultados.concat(android.resultados);
        extra = android.extra;
        const faltan = web.faltan.concat(android.faltan);
        if (faltan.length) console.log("\nSin archivo de prueba todavía: " + faltan.join(", "));
        if (!web.ejecutadas && !android.ejecutadas) { console.log("No hay escenarios automatizados en este plan."); return 1; }
      }
      const r = E.aplicarResultados(carpeta, plan, resultados, { extra });
      S.guardarPlan(carpeta, plan);
      console.log("\n" + r.aplicados.map((x) => x.id + " " + S.ESTADOS[x.estado === "omitida" ? "pendiente" : x.estado].etiqueta).join(" · "));
      if (r.sinEscenario.length) console.log("Sin escenario (falta «E03» en el título o el archivo): " + r.sinEscenario.join(", "));
      return r.aplicados.some((x) => x.estado === "fallo") ? 2 : 0;
    }
    default:
      console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(3, 14).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
      return orden ? 1 : 0;
  }
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error("El Sol: " + e.message); process.exit(1); });
