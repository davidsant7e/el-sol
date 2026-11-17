#!/usr/bin/env node
/**
 * Hace UNA petición HTTP en un proceso aparte (el Node que trae VS Code en modo Node, o el node del
 * sistema). Sirve de respaldo cuando el `fetch` dentro de VS Code falla ("fetch failed"): VS Code
 * envuelve las conexiones de las extensiones (proxy, certificados) y a veces eso es lo que se cae.
 *
 * Entrada (stdin, JSON): { url, method, headers, body, esperaMs }
 * Salida (stdout, JSON): { status, cuerpo } o { error, causa }
 */
let entrada = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { entrada += d; });
process.stdin.on("end", async () => {
  let p;
  try { p = JSON.parse(entrada); } catch (e) { return salir({ error: "entrada no es JSON" }); }
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), p.esperaMs || 60000);
  try {
    const r = await fetch(p.url, { method: p.method || "GET", headers: p.headers || {}, body: p.body, signal: control.signal });
    salir({ status: r.status, cuerpo: await r.text() });
  } catch (e) {
    salir({ error: e && e.name === "AbortError" ? "tardó demasiado" : String(e && e.message), causa: causaDe(e) });
  } finally {
    clearTimeout(reloj);
  }
});

function causaDe(e) {
  const c = e && e.cause;
  if (!c) return null;
  return [c.code, c.message].filter(Boolean).join(" ") || String(c);
}

function salir(obj) {
  process.stdout.write(JSON.stringify(obj));
}
