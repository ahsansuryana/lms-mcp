#!/usr/bin/env node
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "./config.js";
import { registerTools } from "./tools.js";

function buildServer() {
  const server = new McpServer(
    { name: "lms-mcp", version: "0.1.0" },
    {
      instructions:
        "Akses read-only ke LMS UIN SGD (E-Knows) untuk satu akun mahasiswa. Waktu dalam WIB. " +
        "Alur umum: lms_list_courses → lms_get_course (dapat id_kelas_materi/id_materi) → lms_get_material / lms_my_answers. " +
        "Untuk pertanyaan 'ada tugas apa' pakai lms_upcoming_deadlines atau lms_unfinished_tasks.",
    }
  );
  registerTools(server);
  return server;
}

async function startStdio() {
  await buildServer().connect(new StdioServerTransport());
  log("siap (stdio)");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function startHttp() {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token || token.length < 16) {
    throw new Error("MCP_TRANSPORT=http membutuhkan MCP_AUTH_TOKEN (minimal 16 karakter).");
  }
  const port = Number(process.env.MCP_HTTP_PORT || 3333);

  const http = createServer(async (req, res) => {
    const send = (code: number, msg: string) => {
      res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify({ error: msg }));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/mcp") return send(404, "not found");
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), token)) return send(401, "unauthorized");
      if (req.method !== "POST") return send(405, "method not allowed (stateless: gunakan POST)");

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 1_000_000) return send(413, "payload too large");
        chunks.push(c as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");

      // Stateless: server+transport baru per request; sesi LMS tetap dipakai bersama (client singleton).
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      log("http error:", e?.message ?? e);
      if (!res.headersSent) send(500, "internal error");
    }
  });
  // Hanya loopback; jika perlu akses jarak jauh, pasang reverse proxy + TLS sendiri.
  http.listen(port, "127.0.0.1", () => log(`siap (http) http://127.0.0.1:${port}/mcp`));
}

const mode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
(mode === "http" ? startHttp() : startStdio()).catch((e) => {
  log("fatal:", e?.message ?? e);
  process.exit(1);
});
