#!/usr/bin/env node
"use strict";
/**
 * XIX · El Sol desde la terminal (sirve para Visual Studio, Android Studio o cualquier editor).
 *
 *   node cli.js nuevo "Título" caso.txt      crea pruebas/<fecha>-<título>/ con los escenarios
 *   node cli.js lista [carpeta-de-pruebas]    muestra los planes y su avance
 *   node cli.js pdf <carpeta-del-plan>        genera el PDF
 *   node cli.js clave <clave> [modelo]        guarda la clave de Gemini
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
    default:
      console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(3, 12).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
      return orden ? 1 : 0;
  }
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error("El Sol: " + e.message); process.exit(1); });
