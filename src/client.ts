import { getConfig, log } from "./config.js";
import { errMessage } from "./util.js";

export type ErrorKind = "config" | "auth" | "http" | "network";

export class LmsError extends Error {
  constructor(message: string, public kind: ErrorKind = "http", public status?: number) {
    super(message);
  }
}

export interface LmsUser {
  id_user: number;
  id_peserta: number | null;
  nama: string;
  username: string;
  level: string;
  email?: string;
  [k: string]: unknown;
}

// Sesuai frontend (utils/authErrors): 401 yang mengandung "token" atau persis
// "Session expired" = sesi mati. "Password salah." dsb. BUKAN sesi mati.
const sessionInvalid = (m: unknown) => typeof m === "string" && (/token/i.test(m) || m === "Session expired");

interface RawResult {
  status: number;
  json: any;
  text: string;
}

interface ReqOpts {
  query?: Record<string, string | number | undefined>;
  form?: Record<string, string>;
  json?: unknown;
}

const LOGIN_COOLDOWN_MS = 5 * 60_000; // cegah brute-force/lockout bila kredensial salah
const MAX_CONCURRENCY = 4;
const TIMEOUT_MS = 20_000;

export class LmsClient {
  private jar = new Map<string, string>();
  private me: LmsUser | null = null;
  private loginInFlight: Promise<LmsUser> | null = null;
  private lastLoginFailure: { at: number; error: LmsError } | null = null;
  private cache = new Map<string, { exp: number; value: any }>();
  private active = 0;
  private waiters: Array<() => void> = [];

  // ---------- low level ----------
  private cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(res: Response) {
    const list: string[] = (res.headers as any).getSetCookie?.() ?? [];
    for (const sc of list) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (!value || expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENCY) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async raw(method: "GET" | "POST", path: string, opts: ReqOpts = {}): Promise<RawResult> {
    const cfg = getConfig();
    const url = new URL(cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = { Accept: "application/json", Origin: cfg.origin };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    let body: string | undefined;
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }

    let res: Response;
    try {
      res = await this.slot(() =>
        fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })
      );
    } catch (e: any) {
      throw new LmsError(`Gagal menghubungi LMS: ${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e}`, "network");
    }
    this.storeCookies(res);
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  }

  // ---------- auth ----------
  private async fetchMe(): Promise<LmsUser> {
    const r = await this.raw("GET", "/auth/me");
    if (r.status !== 200 || !r.json?.user) {
      throw new LmsError(errMessage(r.json, `GET /auth/me gagal (${r.status})`), "auth", r.status);
    }
    this.me = r.json.user as LmsUser;
    return this.me;
  }

  private async doLogin(): Promise<LmsUser> {
    if (this.lastLoginFailure && Date.now() - this.lastLoginFailure.at < LOGIN_COOLDOWN_MS) {
      throw this.lastLoginFailure.error;
    }
    const cfg = getConfig();
    this.jar.clear();
    this.me = null;
    log("login sebagai", cfg.username);
    const r = await this.raw("POST", "/auth/login", { form: { username: cfg.username, password: cfg.password } });
    if (r.status !== 200 || r.json?.code !== 200) {
      const err = new LmsError(`Login LMS gagal: ${errMessage(r.json, `HTTP ${r.status}`)}`, "auth", r.status);
      // Hanya kunci percobaan ulang untuk penolakan kredensial, bukan error jaringan/5xx.
      if (r.status === 400 || r.status === 401) this.lastLoginFailure = { at: Date.now(), error: err };
      throw err;
    }
    if (!this.jar.has("LMS")) {
      throw new LmsError("Login 200 tetapi cookie LMS tidak diterima (periksa atribut Set-Cookie).", "auth");
    }
    this.lastLoginFailure = null;
    return this.fetchMe();
  }

  private ensureSession(): Promise<LmsUser> {
    if (this.me) return Promise.resolve(this.me);
    this.loginInFlight ??= this.doLogin().finally(() => (this.loginInFlight = null));
    return this.loginInFlight;
  }

  /** Pulihkan sesi: coba POST /auth/sso (bangun ulang cache permission dari cookie yang sama), lalu login penuh. */
  private reauth(): Promise<LmsUser> {
    this.loginInFlight ??= (async () => {
      this.me = null;
      this.cache.clear();
      if (this.jar.has("LMS")) {
        try {
          const sso = await this.raw("POST", "/auth/sso", { json: {} });
          if (sso.status === 200 && sso.json?.code === 200) return await this.fetchMe();
        } catch {
          /* lanjut ke login penuh */
        }
      }
      return this.doLogin();
    })().finally(() => (this.loginInFlight = null));
    return this.loginInFlight;
  }

  async whoami(): Promise<LmsUser> {
    return this.ensureSession();
  }

  // ---------- request ----------
  async get<T = any>(path: string, query?: ReqOpts["query"], ttlMs = 0): Promise<T> {
    const key = path + "?" + JSON.stringify(query ?? {});
    if (ttlMs > 0) {
      const hit = this.cache.get(key);
      if (hit && hit.exp > Date.now()) return hit.value as T;
    }
    await this.ensureSession();
    let r = await this.raw("GET", path, { query });
    if (r.status === 401 && sessionInvalid(r.json?.message)) {
      await this.reauth();
      r = await this.raw("GET", path, { query });
    }
    if (r.status >= 400 || r.json === undefined) {
      const kind: ErrorKind = r.status === 401 || r.status === 403 ? "auth" : "http";
      throw new LmsError(errMessage(r.json, `GET ${path} → HTTP ${r.status}`), kind, r.status);
    }
    if (ttlMs > 0) this.cache.set(key, { exp: Date.now() + ttlMs, value: r.json });
    return r.json as T;
  }
}

export const lms = new LmsClient();
