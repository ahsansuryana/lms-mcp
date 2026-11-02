// Smoke test server hasil build lewat stdio.
//   npm run build && npm run smoke              → tanpa kredensial (whoami harus error konfigurasi)
//   SMOKE_REAL=1 npm run smoke                  → pakai .env, jalankan beberapa tool nyata
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const real = !!process.env.SMOKE_REAL;
const t = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, ...(real ? {} : { LMS_USERNAME: "", LMS_PASSWORD: "" }) },
});
const c = new Client({ name: "smoke", version: "0" });
await c.connect(t);
const { tools } = await c.listTools();
console.log(`${tools.length} tools: ${tools.map((x) => x.name).join(", ")}\n`);

const calls = real
  ? [
      ["lms_list_courses", {}],
      ["lms_progress_summary", {}],
      ["lms_upcoming_deadlines", { days_ahead: 14 }],
      ["lms_unfinished_tasks", {}],
      ["lms_list_notifications", { limit: 3 }],
    ]
  : [["lms_whoami", {}]];
for (const [name, args] of calls) {
  const r = await c.callTool({ name, arguments: args });
  console.log(`### ${name} ${r.isError ? "[ERROR]" : ""}\n${r.content[0].text}\n`);
}
await c.close();
