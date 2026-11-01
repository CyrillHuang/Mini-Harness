import { createServer, type ServerResponse } from "node:http"
import { readFile, readdir, realpath } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { dirname, basename, resolve, sep } from "node:path"
import { homedir } from "node:os"
import type { Context } from "@deepseek-ai/cordis"
import type { GuiPlugin } from "../gui.js"

/** 所有 SSE 消息都是完整快照，重连无需回放旧 delta。 */
export async function startGuiServer(ctx: Context, gui: GuiPlugin, port: number): Promise<string> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid GUI port")
  const require = createRequire(import.meta.url)
  const scripts = new Map([
    ["/markdown.js", new URL("./markdown.js", import.meta.url)],
    ["/vendor/marked.js", pathToFileURL(require.resolve("marked"))],
    ["/vendor/purify.js", new URL("./purify.es.mjs", pathToFileURL(require.resolve("dompurify")))],
  ])
  const clients = new Set<ServerResponse>()
  let origin = ""
  const server = createServer(async (req, res) => {
    try {
      if (`http://${req.headers.host}` !== origin || (req.headers.origin && req.headers.origin !== origin)) {
        res.writeHead(403).end("Forbidden origin"); return
      }
      const url = new URL(req.url ?? "/", origin)
      const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)) }
      if (req.method === "GET" && scripts.has(url.pathname)) {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
        res.end(await readFile(scripts.get(url.pathname)!)); return
      }
      if (req.method === "GET" && url.pathname === "/api/pet") { json(gui.petConfig ?? null); return }
      if (req.method === "GET" && (url.pathname === "/pet/client.js" || url.pathname === "/pet/spritesheet.webp")) {
        const script = url.pathname.endsWith(".js")
        res.writeHead(200, { "Content-Type": script ? "text/javascript" : "image/webp" })
        res.end(await readFile(new URL(script ? "./pet.js" : "./assets/firekeeper/spritesheet.webp", import.meta.url))); return
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" })
        res.end(await readFile(new URL("./index.html", import.meta.url))); return
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
        clients.add(res)
        res.write(`data: ${JSON.stringify(gui.getState())}\n\n`)
        res.on("close", () => clients.delete(res)); return
      }
      if (req.method === "GET" && url.pathname === "/api/workspaces") {
        if (!ctx.workspaceRegistry.list().length) {
          for (const session of await ctx.sessions.list()) {
            try { ctx.workspaceRegistry.create(session.cwd) } catch { /* historical directory may be unavailable */ }
          }
        }
        json(await Promise.all(ctx.workspaceRegistry.list().map(async workspace => {
          try { await readdir(workspace.path); return { ...workspace, available: true } }
          catch { return { ...workspace, available: false } }
        }))); return
      }
      if (req.method === "GET" && url.pathname === "/api/archives") { json(await ctx.sessions.list(undefined, { archived: true })); return }
      if (req.method === "GET" && url.pathname === "/api/state") { json(gui.getState()); return }
      if (req.method === "GET" && url.pathname === "/api/directories") {
        const input = url.searchParams.get("path") || homedir() + sep
        const expanded = input === "~" ? homedir() + sep : input.startsWith("~/") ? homedir() + input.slice(1) : input
        const completing = url.searchParams.get("complete") === "1"
        const absolute = resolve(homedir(), expanded)
        const filter = completing && !expanded.endsWith(sep) && !expanded.endsWith("/") ? basename(absolute) : ""
        const path = await realpath(filter ? dirname(absolute) : absolute)
        const entries = await readdir(path, { withFileTypes: true })
        json({ path, parent: dirname(path), separator: sep, directories: entries.filter(e => e.isDirectory() && e.name.toLowerCase().includes(filter.toLowerCase())).map(e => e.name).sort() }); return
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") { json(await gui.listSessions(url.searchParams.get("cwd") || homedir())); return }
      if (req.method !== "POST") { res.writeHead(404).end(); return }
      if (!req.headers["content-type"]?.startsWith("application/json")) { res.writeHead(415).end(); return }
      let body = ""
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Request too large") }
      const data = JSON.parse(body)
      const str = (key: string) => { if (typeof data[key] !== "string") throw new Error(`Missing ${key}`); return data[key] as string }
      if (url.pathname === "/api/workspaces") { json(ctx.workspaceRegistry.create(str("path"))); return }
      switch (url.pathname) {
        case "/api/create": gui.createSession(str("cwd"), str("name")); break
        case "/api/delete-archived": await gui.deleteArchivedSession(str("id")); break
        case "/api/archive": await gui.archiveSession(str("id"), true); break
        case "/api/unarchive": await gui.archiveSession(str("id"), false); break
        case "/api/view": await gui.viewSession(str("id")); break
        case "/api/open": await gui.openSession(str("id")); break
        case "/api/rename": await gui.renameSession(str("id"), str("name")); break
        case "/api/send": gui.sendMessage(str("text")); break
        case "/api/cancel": gui.cancel(); break
        case "/api/approval": gui.respondApproval(str("id"), str("outcome") as "allowed-once"); break
        default: res.writeHead(404).end(); return
      }
      json(gui.getState())
    } catch (error) {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
  let previous = ""
  const timer = setInterval(() => {
    if (!clients.size) return
    const snapshot = JSON.stringify(gui.getState())
    if (snapshot === previous) return
    previous = snapshot
    for (const client of clients) {
      if (!client.write(`data: ${snapshot}\n\n`)) { clients.delete(client); client.destroy() }
    }
  }, 80)
  ctx.effect(() => () => {
    clearInterval(timer)
    for (const client of clients) client.end()
    clients.clear()
    server.close()
    server.closeAllConnections()
  }, "gui http server")
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") { reject(new Error("No server address")); return }
      origin = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
  return origin
}
