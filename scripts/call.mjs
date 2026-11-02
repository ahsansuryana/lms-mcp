// Panggil satu tool secara nyata:  node scripts/call.mjs lms_get_course '{"id_kelas":15344}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [name, argJson = "{}"] = process.argv.slice(2);
if (!name) { console.error("pakai: node scripts/call.mjs <tool> '<json args>'"); process.exit(1); }
const c = new Client({ name: "call", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env } }));
const r = await c.callTool({ name, arguments: JSON.parse(argJson) });
console.log(r.isError ? "[ERROR]" : "", r.content[0].text);
await c.close();
