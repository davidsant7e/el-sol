// XIX · El Sol — panel del plan de pruebas (corre dentro del webview).
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const enviar = (m) => vscode.postMessage(m);

  let est = null; // último estado recibido
  let filtro = (vscode.getState() || {}).filtro || "todos";
  let abiertos = new Set((vscode.getState() || {}).abiertos || []);
  let activo = null; // escenario donde se pegan las capturas
  const pendientes = new Map(); // guardado diferido por campo
  const escrito = new Map(); // lo escrito que aún no llegó a la extensión (no se pierde si el panel se vuelve a dibujar)

  const ORDEN_ESTADOS = ["paso", "fallo", "bloqueado", "no-aplica", "pendiente"];
  const ATAJO = { paso: "P", fallo: "F", bloqueado: "B", "no-aplica": "N", pendiente: "0" };

  function guardarVista() {
    vscode.setState({ filtro, abiertos: [...abiertos] });
  }

  // ---------------------------------------------------------- utilidades de DOM

  function h(tag, props, ...hijos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "style") Object.assign(el.style, v); // la CSP no deja atributos style

      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of hijos.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }

  /** Como append, pero salta null/undefined (append los escribiría como texto). */
  function agregar(el, ...hijos) {
    for (const c of hijos.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function sol(tam) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 32 32");
    s.setAttribute("width", tam);
    s.setAttribute("height", tam);
    s.setAttribute("aria-hidden", "true");
    s.classList.add("sol");
    let d = "";
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI * 2 * i) / 12;
      const r2 = i % 2 ? 13 : 15;
      d += `M${16 + Math.cos(a) * 10.5} ${16 + Math.sin(a) * 10.5}L${16 + Math.cos(a) * r2} ${16 + Math.sin(a) * r2}`;
    }
    const rayos = document.createElementNS(SVG_NS, "path");
    rayos.setAttribute("d", d);
    rayos.setAttribute("stroke", "currentColor");
    rayos.setAttribute("stroke-width", "2");
    rayos.setAttribute("stroke-linecap", "round");
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "16"); c.setAttribute("cy", "16"); c.setAttribute("r", "7.5");
    c.setAttribute("fill", "currentColor");
    s.append(rayos, c);
    return s;
  }

  function tamano(b) {
    if (!b) return "";
    if (b < 1024) return b + " B";
    if (b < 1048576) return Math.round(b / 1024) + " KB";
    return (b / 1048576).toFixed(1).replace(".", ",") + " MB";
  }

  /**
   * Guarda un campo de texto medio segundo después de dejar de escribir;
   * al salir del campo (ya = true) se envía enseguida lo que estuviera pendiente.
   */
  function guardarTexto(clave, ya, mensaje) {
    escrito.set(clave, mensaje().valor);
    if (!ya) {
      clearTimeout(pendientes.get(clave));
      pendientes.set(clave, setTimeout(() => { pendientes.delete(clave); escrito.delete(clave); enviar(mensaje()); }, 500));
      return;
    }
    escrito.delete(clave);
    if (!pendientes.has(clave)) return; // ya se guardó
    clearTimeout(pendientes.get(clave));
    pendientes.delete(clave);
    enviar(mensaje());
  }

  function campoTexto(props, valor, alCambiar) {
    if (escrito.has(props["data-foco"])) valor = escrito.get(props["data-foco"]);
    const el = h(props.multilinea ? "textarea" : "input", Object.assign({}, props, { multilinea: null, value: valor || "" }));
    if (!props.multilinea) el.type = "text";
    el.addEventListener("input", () => { alCambiar(el.value, false); if (props.multilinea) autoAlto(el); });
    el.addEventListener("blur", () => alCambiar(el.value, true));
    if (props.multilinea) requestAnimationFrame(() => autoAlto(el));
    return el;
  }

  function autoAlto(t) {
    t.style.height = "auto";
    t.style.height = Math.min(Math.max(t.scrollHeight + 2, 34), 420) + "px";
  }

  // ---------------------------------------------------------- render

  /** Recuerda foco, selección y desplazamiento para que volver a dibujar no moleste al escribir. */
  function conservarFoco(dibujar) {
    const a = document.activeElement;
    const clave = a && a.dataset ? a.dataset.foco : null;
    const sel = a && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
    const scroll = window.scrollY;
    dibujar();
    window.scrollTo(0, scroll);
    if (clave) {
      const nuevo = app.querySelector(`[data-foco="${CSS.escape(clave)}"]`);
      if (nuevo) {
        nuevo.focus({ preventScroll: true });
        if (sel && "setSelectionRange" in nuevo) try { nuevo.setSelectionRange(sel[0], sel[1]); } catch (e) { /* select */ }
      }
    }
  }

  function render() {
    if (!est) return;
    conservarFoco(() => {
      app.replaceChildren(est.modo === "nuevo" ? vistaNuevo() : vistaPlan());
    });
  }

  function encabezado(titulo) {
    return h("header", { class: "marca" },
      sol(22),
      h("span", { class: "arcano" }, "XIX · EL SOL"),
      titulo ? h("span", { class: "sub" }, titulo) : null,
    );
  }

  function lineaClave() {
    if (est.clave) return h("p", { class: "nota" }, "Gemini (" + est.modelo + ") con la clave " + est.clave + ". ",
      h("button", { class: "enlace", onclick: () => enviar({ tipo: "configurarClave" }) }, "Cambiar clave"));
    return h("p", { class: "nota aviso" }, "Sin clave de Gemini: se usará la plantilla por reglas. ",
      h("button", { class: "enlace", onclick: () => enviar({ tipo: "configurarClave" }) }, "Configurar clave"), " (gratis en aistudio.google.com).");
  }

  // ---------- crear plan

  function vistaNuevo() {
    const b = est.borrador || {};
    const titulo = h("input", { id: "titulo", type: "text", value: b.titulo || "", placeholder: "Ej.: Inicio de sesión con Google", "data-foco": "nuevo-titulo" });
    const caso = h("textarea", {
      id: "caso", rows: "12", "data-foco": "nuevo-caso",
      placeholder: "Pega aquí la historia de usuario, los criterios de aceptación o la descripción del cambio.\n\nEjemplo:\nComo usuario quiero iniciar sesión con Google.\n- El botón «Continuar con Google» aparece en el login\n- Si el correo no existe, se crea la cuenta\n- Sin internet se muestra un aviso",
    });
    caso.value = b.caso || "";
    const indic = h("input", { id: "indicacion", type: "text", placeholder: "Opcional: «enfócate en Android 16», «incluye pruebas de accesibilidad»…", "data-foco": "nuevo-indicacion" });
    const crear = (modo) => enviar({ tipo: "crear", modo, titulo: titulo.value, caso: caso.value, indicacion: indic.value });
    return h("section", { class: "nuevo" },
      encabezado("Nuevo plan de pruebas"),
      h("label", { for: "titulo" }, "Título del plan"),
      titulo,
      h("label", { for: "caso" }, "Caso de desarrollo"),
      caso,
      h("label", { for: "indicacion" }, "Indicación para la IA"),
      indic,
      h("div", { class: "acciones" },
        h("button", { class: "primario", disabled: est.ocupado, onclick: () => crear("gemini") }, est.ocupado ? "Armando escenarios…" : est.clave ? "Generar escenarios con Gemini" : "Generar escenarios"),
        h("button", { disabled: est.ocupado, onclick: () => crear("plantilla") }, "Usar la plantilla (sin IA)"),
      ),
      lineaClave(),
      h("p", { class: "nota" }, "Se guardará en ", h("code", {}, est.destino + "/<fecha>-<título>/"), " con un sol.json y la carpeta adjuntos."),
    );
  }

  // ---------- plan

  function contar(plan) {
    const r = { total: 0, pendiente: 0, paso: 0, fallo: 0, bloqueado: 0, "no-aplica": 0, adjuntos: 0 };
    for (const e of plan.escenarios) { r.total++; r[e.estado]++; r.adjuntos += e.adjuntos.length; }
    r.revisados = r.total - r.pendiente;
    r.veredicto = !r.total ? "vacio" : r.fallo ? "fallos" : r.pendiente || r.bloqueado ? "incompleto" : "aprobado";
    return r;
  }

  function vistaPlan() {
    const p = est.plan;
    const r = contar(p);
    const cont = h("section", { class: "plan" });

    const titulo = campoTexto({ class: "titulo-plan", "aria-label": "Título del plan", "data-foco": "plan-titulo" }, p.titulo, (v, ya) => {
      p.titulo = v;
      guardarTexto("plan-titulo", ya, () => ({ tipo: "campoPlan", campo: "titulo", valor: v }));
    });

    // barra de progreso por estado
    const barra = h("div", { class: "barra", role: "img", "aria-label": ORDEN_ESTADOS.map((k) => r[k] + " " + est.estados[k].etiqueta).join(", ") });
    for (const k of ORDEN_ESTADOS) if (r[k]) barra.append(h("span", { class: "tramo e-" + k, style: { flexGrow: String(r[k]) } }));

    const filtros = h("div", { class: "filtros", role: "group", "aria-label": "Filtrar escenarios" },
      ...[["todos", "Todos", r.total], ["pendiente", "Pendientes", r.pendiente], ["fallo", "Fallaron", r.fallo], ["bloqueado", "Bloqueados", r.bloqueado], ["paso", "Pasaron", r.paso]]
        .map(([k, et, n]) => h("button", { class: "chip" + (filtro === k ? " activo" : ""), "aria-pressed": String(filtro === k), onclick: () => { filtro = k; guardarVista(); render(); } }, et + " ", h("b", {}, String(n)))),
    );

    agregar(cont,
      encabezado(null),
      titulo,
      h("div", { class: "resumen" },
        h("span", { class: "veredicto v-" + r.veredicto }, est.veredictos[r.veredicto]),
        h("span", {}, r.revisados + " de " + r.total + " revisados"),
        r.paso ? h("span", { class: "t-paso" }, r.paso + " pasaron") : null,
        r.fallo ? h("span", { class: "t-fallo" }, r.fallo + " fallaron") : null,
        r.bloqueado ? h("span", { class: "t-bloqueado" }, r.bloqueado + " bloqueados") : null,
        h("span", { class: "tenue" }, r.adjuntos + (r.adjuntos === 1 ? " evidencia" : " evidencias")),
      ),
      barra,
      h("div", { class: "acciones barra-acciones" },
        h("button", { class: "primario", disabled: est.ocupado, onclick: () => enviar({ tipo: "pdf" }) }, est.ocupado ? "Trabajando…" : "Generar PDF"),
        est.hayPdf ? h("button", { onclick: () => enviar({ tipo: "abrirPdf" }) }, "Abrir el último PDF") : null,
        h("button", { onclick: () => enviar({ tipo: "agregarEscenario" }) }, "+ Escenario"),
        h("button", { disabled: est.ocupado, onclick: pedirMas, title: est.clave ? "Pide a Gemini escenarios que aún no estén" : "Sin clave: agrega los de la plantilla que falten" }, est.clave ? "Más escenarios con IA" : "Más escenarios"),
        h("button", { class: "secundario", onclick: () => enviar({ tipo: "mostrarCarpeta" }) }, "Carpeta"),
        h("button", { class: "secundario", onclick: () => enviar({ tipo: "abrirJson" }) }, "sol.json"),
      ),
      est.aviso ? h("p", { class: "nota aviso", role: "status" }, est.aviso) : null,
      bloqueCaso(p),
      filtros,
    );

    const lista = h("div", { class: "escenarios" });
    const visibles = p.escenarios.filter((e) => filtro === "todos" || e.estado === filtro);
    for (const e of visibles) lista.append(tarjeta(e));
    if (!visibles.length) lista.append(h("p", { class: "vacio" }, p.escenarios.length ? "No hay escenarios con ese filtro." : "Sin escenarios. Agrega uno o pide más."));
    agregar(cont, lista,
      h("p", { class: "nota pie" }, "Atajos (con un escenario elegido, fuera de los campos de texto): P pasó · F falló · B bloqueado · N no aplica · 0 pendiente. Pega capturas con Ctrl+V. ",
        h("span", { class: "tenue" }, est.carpeta)),
    );
    return cont;
  }

  function bloqueCaso(p) {
    const caso = campoTexto({ multilinea: true, class: "caso", "aria-label": "Caso de desarrollo", "data-foco": "plan-caso" }, p.caso, (v, ya) => {
      p.caso = v;
      guardarTexto("plan-caso", ya, () => ({ tipo: "campoPlan", campo: "caso", valor: v }));
    });
    const d = h("details", { class: "bloque-caso", open: abiertos.has("caso") || null },
      h("summary", {}, "Caso de desarrollo"),
      caso,
      lineaClave(),
    );
    d.addEventListener("toggle", () => { d.open ? abiertos.add("caso") : abiertos.delete("caso"); guardarVista(); if (d.open) autoAlto(caso); });
    return d;
  }

  function pedirMas() {
    // los webviews no permiten prompt(): la extensión pregunta con su propio cuadro
    enviar({ tipo: "pedirMas" });
  }

  function cambiarEstado(e, estado) {
    e.estado = estado;
    enviar({ tipo: "campo", id: e.id, campo: "estado", valor: estado });
  }

  function tarjeta(e) {
    const art = h("article", { class: "tarjeta e-" + e.estado + (activo === e.id ? " activa" : ""), dataset: { id: e.id }, tabindex: "-1", "aria-label": e.id + " " + e.titulo });
    const guardarCampo = (campo) => (v, ya) => {
      e[campo] = campo === "pasos" ? v.split("\n") : v;
      guardarTexto(e.id + "-" + campo, ya, () => ({ tipo: "campo", id: e.id, campo, valor: v }));
    };

    const estados = h("div", { class: "estados", role: "radiogroup", "aria-label": "Estado de " + e.id },
      ...ORDEN_ESTADOS.map((k) => h("button", {
        class: "estado b-" + k + (e.estado === k ? " sel" : ""),
        role: "radio", "aria-checked": String(e.estado === k),
        title: est.estados[k].etiqueta + " (tecla " + ATAJO[k] + ")",
        "data-foco": e.id + "-estado-" + k,
        onclick: () => cambiarEstado(e, k),
      }, est.estados[k].etiqueta)),
    );

    const titulo = campoTexto({ class: "titulo-esc", "aria-label": "Título de " + e.id, "data-foco": e.id + "-titulo" }, e.titulo, guardarCampo("titulo"));

    const sel = (campo, opciones) => {
      const s = h("select", { "aria-label": campo, "data-foco": e.id + "-" + campo, onchange: (ev) => { e[campo] = ev.target.value; enviar({ tipo: "campo", id: e.id, campo, valor: ev.target.value }); } },
        ...Object.entries(opciones).map(([k, v]) => h("option", { value: k, selected: e[campo] === k || null }, v)));
      return s;
    };

    const abierto = abiertos.has(e.id);
    const detalles = h("details", { class: "detalles", open: abierto || null },
      h("summary", {}, "Pasos y resultado esperado ", h("span", { class: "tenue" }, e.pasos.length + (e.pasos.length === 1 ? " paso" : " pasos"))),
      h("label", {}, "Precondiciones"),
      campoTexto({ multilinea: true, rows: "2", "data-foco": e.id + "-precondiciones" }, e.precondiciones, guardarCampo("precondiciones")),
      h("label", {}, "Pasos ", h("span", { class: "tenue" }, "(uno por línea)")),
      campoTexto({ multilinea: true, rows: "3", "data-foco": e.id + "-pasos" }, e.pasos.join("\n"), guardarCampo("pasos")),
      h("label", {}, "Resultado esperado"),
      campoTexto({ multilinea: true, rows: "2", "data-foco": e.id + "-esperado" }, e.esperado, guardarCampo("esperado")),
    );
    detalles.addEventListener("toggle", () => { detalles.open ? abiertos.add(e.id) : abiertos.delete(e.id); guardarVista(); detalles.querySelectorAll("textarea").forEach(autoAlto); });

    // vista rápida del resultado esperado cuando los detalles están cerrados
    const esperadoCorto = !abierto && e.esperado ? h("p", { class: "esperado-corto" }, h("b", {}, "Esperado: "), e.esperado) : null;

    const obs = campoTexto({ multilinea: true, rows: "2", class: "observacion", placeholder: "Qué pasó, datos usados, versión, dispositivo…", "data-foco": e.id + "-observacion", "aria-label": "Observación de " + e.id }, e.observacion, guardarCampo("observacion"));

    agregar(art,
      h("div", { class: "fila1" }, h("span", { class: "id" }, e.id), titulo),
      h("div", { class: "fila2" }, estados,
        h("div", { class: "meta" }, sel("tipo", est.tipos), sel("prioridad", est.prioridades),
          h("button", { class: "icono", title: "Subir", "aria-label": "Subir " + e.id, onclick: () => enviar({ tipo: "mover", id: e.id, dir: -1 }) }, "↑"),
          h("button", { class: "icono", title: "Bajar", "aria-label": "Bajar " + e.id, onclick: () => enviar({ tipo: "mover", id: e.id, dir: 1 }) }, "↓"),
          h("button", { class: "icono", title: "Duplicar", "aria-label": "Duplicar " + e.id, onclick: () => enviar({ tipo: "duplicarEscenario", id: e.id }) }, "⧉"),
          h("button", { class: "icono peligro", title: "Quitar", "aria-label": "Quitar " + e.id, onclick: () => enviar({ tipo: "quitarEscenario", id: e.id }) }, "✕"),
        ),
      ),
      esperadoCorto,
      detalles,
      h("label", { class: "etiqueta-obs" }, "Observación"),
      obs,
      zonaAdjuntos(e),
    );

    art.addEventListener("focusin", () => marcarActivo(e.id));
    art.addEventListener("pointerdown", () => marcarActivo(e.id));
    // Atajos con una letra, solo fuera de los campos de texto (Alt+letra abriría los menús de VS Code).
    art.addEventListener("keydown", (ev) => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const t = ev.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const k = Object.keys(ATAJO).find((x) => ATAJO[x] === ev.key.toUpperCase());
      if (k) { ev.preventDefault(); cambiarEstado(e, k); }
    });
    return art;
  }

  function marcarActivo(id) {
    if (activo === id) return;
    activo = id;
    app.querySelectorAll(".tarjeta.activa").forEach((t) => t.classList.remove("activa"));
    const t = app.querySelector(`.tarjeta[data-id="${id}"]`);
    if (t) t.classList.add("activa");
  }

  function zonaAdjuntos(e) {
    const lista = h("div", { class: "adjuntos" },
      ...e.adjuntos.map((a) => h("figure", { class: "adjunto" + (a.imagen ? " imagen" : "") },
        h("button", { class: "ver", title: "Abrir " + a.nombre, onclick: () => enviar({ tipo: "abrirAdjunto", archivo: a.archivo }) },
          a.imagen && a.uri ? h("img", { src: a.uri, alt: a.nombre, loading: "lazy" }) : h("span", { class: "ext" }, (a.archivo.split(".").pop() || "?").toUpperCase().slice(0, 4))),
        h("figcaption", {}, h("span", { class: "nombre", title: a.archivo }, a.nombre), h("span", { class: "tenue" }, tamano(a.bytes))),
        h("button", { class: "quitar", title: "Quitar evidencia", "aria-label": "Quitar " + a.nombre, onclick: () => enviar({ tipo: "quitarAdjunto", id: e.id, archivo: a.archivo }) }, "✕"),
      )),
    );
    const zona = h("div", { class: "zona", dataset: { id: e.id } },
      lista,
      h("div", { class: "soltar" },
        h("button", { onclick: () => enviar({ tipo: "elegirAdjuntos", id: e.id }) }, "Adjuntar…"),
        h("span", { class: "tenue" }, "o pega una captura (Ctrl+V) · o arrastra archivos manteniendo Shift"),
      ),
    );
    zona.addEventListener("dragover", (ev) => { ev.preventDefault(); zona.classList.add("encima"); });
    zona.addEventListener("dragleave", () => zona.classList.remove("encima"));
    zona.addEventListener("drop", (ev) => {
      ev.preventDefault();
      zona.classList.remove("encima");
      const archivos = [...(ev.dataTransfer && ev.dataTransfer.files || [])];
      if (archivos.length) subir(e.id, archivos);
    });
    return zona;
  }

  // ---------------------------------------------------------- adjuntos pegados o arrastrados

  const MAX = 25 * 1024 * 1024;

  function leerBase64(archivo) {
    return new Promise((ok, mal) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1] || "");
      r.onerror = () => mal(r.error);
      r.readAsDataURL(archivo);
    });
  }

  async function subir(id, archivos) {
    const lista = [];
    for (const f of archivos) {
      if (f.size > MAX) { aviso("«" + f.name + "» pasa de 25 MB; guárdalo aparte y anota la ruta en la observación."); continue; }
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
      const nombre = f.name && f.name !== "image.png" ? f.name : "captura-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + "." + ext;
      lista.push({ nombre, base64: await leerBase64(f) });
    }
    if (lista.length) enviar({ tipo: "adjuntarDatos", id, archivos: lista });
  }

  function aviso(t) {
    if (!est) return;
    est.aviso = t;
    render();
  }

  document.addEventListener("paste", (ev) => {
    if (!est || est.modo !== "plan") return;
    const archivos = [...(ev.clipboardData && ev.clipboardData.files || [])];
    if (!archivos.length) return; // texto normal: lo pega el campo
    const id = activo || (est.plan.escenarios[0] && est.plan.escenarios[0].id);
    if (!id) return;
    ev.preventDefault();
    subir(id, archivos);
  });

  // evita que soltar un archivo fuera de una zona abra el archivo en el panel
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => ev.preventDefault());

  // ---------------------------------------------------------- mensajes de la extensión

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || m.tipo !== "estado") return;
    const avisoPrevio = est && est.plan && m.plan && est.plan.titulo === m.plan.titulo ? est.aviso : null;
    est = m;
    if (!m.aviso && avisoPrevio && m.ocupado) est.aviso = avisoPrevio;
    render();
    if (m.enfocar) {
      filtro = "todos";
      abiertos.add(m.enfocar);
      guardarVista();
      render();
      const t = app.querySelector(`.tarjeta[data-id="${m.enfocar}"]`);
      if (t) {
        t.scrollIntoView({ block: "center" });
        const i = t.querySelector(".titulo-esc");
        if (i) { i.focus(); i.select(); }
        marcarActivo(m.enfocar);
      }
    }
  });

  enviar({ tipo: "listo" });
})();
