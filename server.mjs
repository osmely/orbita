#!/usr/bin/env node
// Órbita — un Trello con cerebro externo. El tablero funciona a mano, y
// cualquier IA conectada por MCP (Claude Code, Cursor, Claude Desktop…) toma
// las tarjetas que pongas en "En curso", informa su progreso y te entrega el
// resultado para revisar. No usa ninguna API key propia.
//
// Este archivo es el servidor HTTP (solo en 127.0.0.1): seguridad, archivos de la interfaz y vista previa.
// El tablero y sus operaciones están en estado.mjs; la API, como tabla, en rutas.mjs; las herramientas
// de la IA en mcp.mjs; las tareas programadas en programadas.mjs; dónde se guarda cada cosa en almacen.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DATOS, PORT, VERSION, VERSION_APP, VISTA, abrirVentana, leerPublico, salir } from "./entorno.mjs";
import { abrirAlArrancar } from "./arranque.mjs"; // antes que el tablero: ¿hay ya una Órbita abierta?
import { broadcast, protegido, safePath, subscribers } from "./estado.mjs";
import { createMcpHandler } from "./mcp.mjs";
import { encontrarRuta, readJson, send } from "./rutas.mjs";
import "./programadas.mjs"; // sus temporizadores empiezan al cargarse

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Imágenes que puede producir la IA (capturas, diagramas). SVG no: puede llevar scripts.
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
};

// Vista previa de entregables (/vista/…): se sirven con su tipo real para que funcionen (páginas, juegos…),
// pero con la cabecera «sandbox»: el navegador los ejecuta en un origen aislado, sin acceso al tablero ni a su API,
// aunque se abran en una pestaña aparte.
const VISTA_MIME = {
  ...MIME,
  ...IMAGE_MIME,
  ".htm": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups allow-downloads";
function serveVista(res, rel) {
  let file;
  try {
    file = safePath(rel);
  } catch {
    return send(res, 403, { error: "prohibido" });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "no encontrado" });
    const ext = path.extname(file).toLowerCase();
    const cabeceras = {
      "content-type": VISTA_MIME[ext] || "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*", // para que la página aislada pueda leer sus propios archivos (JSON, módulos…)
    };
    if (ext !== ".pdf") cabeceras["content-security-policy"] = SANDBOX; // el visor de PDF del navegador no funciona en sandbox (y no ejecuta la página)
    res.writeHead(200, cabeceras);
    res.end(data);
  });
}

function serveFile(res, rel) {
  let file;
  try {
    file = safePath(rel);
  } catch {
    return send(res, 403, { error: "prohibido" });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "no encontrado" });
    // Los entregables los escribe una IA: se sirven como imagen o como texto plano, nunca como algo que se ejecute.
    const ext = path.extname(file).toLowerCase();
    const type = IMAGE_MIME[ext] || "text/plain; charset=utf-8";
    res.writeHead(200, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-cache" }); // siempre la última versión
    res.end(data);
  });
}

// La interfaz de Órbita, de public/ (ver entorno.mjs)
function servirPublico(res, rel) {
  const data = leerPublico(rel);
  if (!data) return send(res, 404, { error: "no encontrado" });
  const cabeceras = { "content-type": MIME[path.extname(rel).toLowerCase()] || "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "no-cache" };
  // La página del tablero solo carga lo suyo, y ninguna otra web puede incrustarla (clickjacking)
  if (rel === "index.html") {
    cabeceras["content-security-policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    cabeceras["referrer-policy"] = "no-referrer";
  }
  res.writeHead(200, cabeceras);
  res.end(data);
}

const ALLOWED_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const handleMcp = createMcpHandler();

const server = http.createServer(async (req, res) => {
  // Solo se acepta tráfico local: evita que una web cualquiera use el tablero
  // desde tu navegador (DNS rebinding o peticiones cruzadas).
  const origin = req.headers.origin;
  // La vista previa aislada pide sus propios archivos con «Origin: null»: solo para leer /vista/<clave>/
  if (req.method === "GET" && ALLOWED_HOSTS.includes(req.headers.host) && req.url.startsWith("/vista/") && (!origin || origin === "null" || ALLOWED_HOSTS.some((h) => origin === `http://${h}`))) {
    // Sin la clave, nada: las páginas aisladas (origen opaco) piden sus archivos igual que lo haría una web ajena
    // («cross-site», sin Origin ni Referer), así que la única diferencia es conocer la ruta
    const ruta = new URL(req.url, "http://x").pathname;
    if (!ruta.startsWith(VISTA)) return send(res, 403, { error: "La vista previa solo se abre desde Órbita" });
    return serveVista(res, decodeURIComponent(ruta.slice(VISTA.length)));
  }
  if (!ALLOWED_HOSTS.includes(req.headers.host) || (origin && !ALLOWED_HOSTS.some((h) => origin === `http://${h}`))) {
    return send(res, 403, { error: "Solo se aceptan conexiones desde localhost" });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      return await handleMcp(req, res, body, ALLOWED_HOSTS);
    }

    // Cambios en vivo para la interfaz (Server-Sent Events)
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", version: VERSION })}\n\n`);
      subscribers.add(res);
      req.on("close", () => subscribers.delete(res));
      return;
    }

    // La API del tablero: ver la tabla en rutas.mjs
    const manejar = encontrarRuta(req.method, parts);
    if (manejar) return await manejar({ req, res, url, parts });

    if (parts[0] === "files" && req.method === "GET") {
      return serveFile(res, decodeURIComponent(parts.slice(1).join("/")));
    }

    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      return servirPublico(res, rel);
    }

    send(res, 404, { error: "no encontrado" });
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: err.message || String(err) });
    else res.end();
  }
});

// Mantiene vivas las conexiones SSE.
setInterval(protegido("el ping de los navegadores", () => broadcast({ type: "ping" })), 25_000);

// Solo en 127.0.0.1: desde otros equipos de la red no se puede entrar. (Si era otra Órbita, ya lo resolvió arranque.mjs.)
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") salir(`No se pudo arrancar Órbita: ${err.message}`);
  salir(`El puerto ${PORT} lo está usando otro programa. Arranca Órbita en otro, por ejemplo:  orbita --port ${PORT + 1}\n(Recuerda cambiar también la dirección MCP en tu IA.)`);
});
server.on("listening", () => {
  console.log(`\n  ◉ Órbita ${VERSION_APP} está en http://localhost:${PORT}`);
  console.log(`    Conecta tu IA por MCP: http://localhost:${PORT}/mcp`);
  console.log(`    Tus datos: ${DATOS}`);
  console.log(`    Para cerrarla: Ctrl+C (o, en Órbita, ⌘K → «Cerrar Órbita»)\n`);
  if (abrirAlArrancar) abrirVentana(`http://localhost:${PORT}`);
});
server.listen(PORT, "127.0.0.1");
