"use strict";
// Corre todas las pruebas: node tests/correr.js
const archivos = ["./nucleo.test.js", "./extension.test.js", "./panel.test.js"];
(async () => {
  let ok = 0, mal = 0, omitidas = 0;
  for (const a of archivos) {
    let pruebas;
    try { pruebas = require(a); } catch (e) { if (e.code === "MODULE_NOT_FOUND" && e.message.includes(a.slice(2))) { omitidas++; continue; } throw e; }
    for (const [nombre, f] of Object.entries(pruebas)) {
      try {
        const r = await f();
        if (r === "omitida") { omitidas++; console.log("  - " + nombre + " (omitida)"); continue; }
        ok++; console.log("  ✓ " + nombre);
      } catch (e) {
        mal++; console.log("  ✗ " + nombre + "\n      " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n      "));
      }
    }
  }
  console.log("\n" + ok + " OK, " + mal + " con error" + (omitidas ? ", " + omitidas + " omitidas" : ""));
  process.exit(mal ? 1 : 0);
})();
