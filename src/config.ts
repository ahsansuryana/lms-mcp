import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .env dicari relatif ke root project (bukan cwd) supaya tetap terbaca saat
// dijalankan oleh Claude Desktop. Env dari MCP client tidak ditimpa.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env"), quiet: true });

export interface Config {
  baseUrl: string;
  origin: string;
  username: string;
  password: string;
}

export class ConfigError extends Error {}

/** Divalidasi saat pertama dipakai, bukan saat start, agar server tetap bisa
 *  menjawab initialize/list_tools dan memberi pesan error yang jelas. */
export function getConfig(): Config {
  const username = process.env.LMS_USERNAME?.trim();
  const password = process.env.LMS_PASSWORD;
  if (!username || !password) {
    throw new ConfigError(
      "LMS_USERNAME / LMS_PASSWORD belum diisi. Isi di file .env (lihat .env.example) atau di blok env konfigurasi MCP client."
    );
  }
  return {
    baseUrl: (process.env.LMS_BASE_URL || "https://api.uinsgd.ac.id/lms").replace(/\/+$/, ""),
    origin: process.env.LMS_ORIGIN || "https://lms.uinsgd.ac.id",
    username,
    password,
  };
}

export const log = (...args: unknown[]) => console.error("[lms-mcp]", ...args); // stdout dipakai protokol MCP
