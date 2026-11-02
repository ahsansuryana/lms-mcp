import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { lms, LmsError } from "./client.js";
import { ConfigError } from "./config.js";
import { allItems, describeItem, getCourseDetail, listCourses, latestSemester } from "./domain.js";
import { fmtWIB, htmlToText, parseWIB, unwrapList } from "./util.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e: any) {
    if (e instanceof ConfigError) return fail(`Konfigurasi: ${e.message}`);
    if (e instanceof LmsError) {
      const hint = e.kind === "auth" ? " (periksa LMS_USERNAME/LMS_PASSWORD atau coba lagi nanti)" : "";
      return fail(`LMS error [${e.kind}${e.status ? " " + e.status : ""}]: ${e.message}${hint}`);
    }
    return fail(`Error tak terduga: ${e?.message ?? e}`);
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer) {
  // 1 ---------------------------------------------------------------
  server.registerTool(
    "lms_whoami",
    {
      title: "Profil akun LMS",
      description: "Tampilkan identitas akun LMS yang sedang dipakai (nama, NIM/username, level). Berguna untuk cek koneksi & login.",
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const u = await lms.whoami();
        return [`Nama: ${u.nama}`, `Username/NIM: ${u.username}`, `Level: ${u.level}`, `Email: ${u.email ?? "-"}`].join("\n");
      })
  );

  // 2 ---------------------------------------------------------------
  server.registerTool(
    "lms_list_semesters",
    {
      title: "Daftar semester",
      description: "Daftar semester yang punya kelas untuk akun ini. Nilai kode_semester (mis. 20251) dipakai sebagai filter di tool lain.",
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const json = await lms.get("/course/my-course/my-semester", undefined, 300_000);
        const items = unwrapList(json).items;
        if (!items.length) return "Tidak ada semester.";
        return items.map((s: any) => `- ${s.kode_semester ?? s.nama}`).join("\n");
      })
  );

  // 3 ---------------------------------------------------------------
  server.registerTool(
    "lms_list_courses",
    {
      title: "Daftar kelas",
      description:
        "Daftar kelas yang diikuti beserta progres tugas (selesai/total). Default: semester terbaru. Kirim semester='all' untuk semua semester.",
      inputSchema: {
        semester: z.string().optional().describe("kode_semester, mis. 20251; 'all' = semua"),
        search: z.string().optional().describe("Cari berdasarkan nama mata kuliah"),
      },
      annotations: readOnly,
    },
    ({ semester, search }) =>
      run(async () => {
        const sem = semester === "all" ? undefined : semester ?? (await latestSemester());
        const courses = await listCourses({ semester: sem, search });
        if (!courses.length) return `Tidak ada kelas${sem ? ` pada semester ${sem}` : ""}.`;
        const head = `Semester: ${sem ?? "semua"} — ${courses.length} kelas\n`;
        return (
          head +
          courses
            .map((c) => {
              const pct = c.jumlah_materi ? Math.round((c.materi_selesai / c.jumlah_materi) * 100) : 0;
              return `- [id_kelas=${c.id}] ${c.matkul} (${c.kode_kelas}) · ${c.dosen || "-"} · sem ${c.semester} · ${c.jumlah_materi ? `tugas selesai ${c.materi_selesai}/${c.jumlah_materi} (${pct}%)` : "belum ada tugas"}`;
            })
            .join("\n")
        );
      })
  );

  // 4 ---------------------------------------------------------------
  server.registerTool(
    "lms_get_course",
    {
      title: "Detail kelas",
      description:
        "Struktur satu kelas: pertemuan → materi/tugas/quiz, lengkap dengan tenggat (WIB), status terkunci, dan apakah sudah dikerjakan.",
      inputSchema: { id_kelas: z.number().int().positive().describe("id_kelas dari lms_list_courses") },
      annotations: readOnly,
    },
    ({ id_kelas }) =>
      run(async () => {
        const { kelas, sections } = await getCourseDetail(id_kelas);
        const lines = [
          `# ${kelas.matkul} — ${kelas.kode_kelas} ${kelas.nama}`,
          `${kelas.dosen ? `Dosen: ${kelas.dosen} · ` : ""}Semester: ${kelas.semester || "-"}`,
          "",
        ];
        for (const s of sections) {
          lines.push(`## ${s.nama}`);
          if (!s.items.length) lines.push("(kosong)");
          for (const i of s.items) lines.push(describeItem(i, new Date(), true));
          lines.push("");
        }
        return lines.join("\n");
      })
  );

  // 5 ---------------------------------------------------------------
  server.registerTool(
    "lms_get_material",
    {
      title: "Isi materi / instruksi tugas",
      description:
        "Baca isi satu materi atau instruksi tugas (HTML dikonversi ke teks): deskripsi, lampiran, bentuk pengumpulan, durasi, batas percobaan.",
      inputSchema: { id_materi: z.number().int().positive().describe("id_materi dari lms_get_course") },
      annotations: readOnly,
    },
    ({ id_materi }) =>
      run(async () => {
        const m: any = await lms.get(`/master/materi/view/${id_materi}`, undefined, 120_000);
        const bentuk = String(m.bentuk_materi ?? "")
          .split(",")
          .map((x) => ({ "1": "teks", "2": "upload file" } as Record<string, string>)[x.trim()])
          .filter(Boolean)
          .join(" + ");
        return [
          `# ${m.nama}`,
          `Kategori: ${m.KategoriMateri?.nama ?? "-"}${m.KomponenNilai?.nama ? ` · Komponen nilai: ${m.KomponenNilai.nama}` : ""}`,
          bentuk ? `Bentuk jawaban: ${bentuk}` : "",
          m.durasi ? `Durasi: ${m.durasi} menit` : "",
          m.maksimal_jawab ? `Maks percobaan: ${m.maksimal_jawab}` : "",
          m.lampiran ? `Lampiran: ${m.lampiran}` : "",
          "",
          htmlToText(m.deskripsi) || "(tidak ada deskripsi)",
        ]
          .filter((l, i, a) => l !== "" || a[i - 1] !== "")
          .join("\n");
      })
  );

  // 6 ---------------------------------------------------------------
  server.registerTool(
    "lms_upcoming_deadlines",
    {
      title: "Tenggat mendatang",
      description:
        "Tugas/quiz dengan tenggat dalam N hari ke depan (lintas semua kelas di semester terbaru), diurutkan terdekat. Item yang sudah dikerjakan disembunyikan kecuali diminta.",
      inputSchema: {
        days_ahead: z.number().int().min(1).max(120).default(14),
        semester: z.string().optional(),
        include_done: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    ({ days_ahead, semester, include_done }) =>
      run(async () => {
        const now = new Date();
        const limit = now.getTime() + days_ahead * 86_400_000;
        const { semester: sem, items } = await allItems(semester);
        const rows = items
          .filter((i) => i.is_tugas && (include_done || i.done !== true))
          .map((i) => ({ i, due: parseWIB(i.due) }))
          .filter((r): r is { i: typeof r.i; due: Date } => !!r.due && r.due.getTime() <= limit && r.i.window !== "ditutup")
          .sort((a, b) => a.due.getTime() - b.due.getTime());
        if (!rows.length) return `Tidak ada tenggat dalam ${days_ahead} hari ke depan (semester ${sem ?? "-"}).`;
        return `Tenggat ≤ ${days_ahead} hari (semester ${sem ?? "-"}), sekarang ${fmtWIB(now)}:\n` + rows.map((r) => describeItem(r.i, now)).join("\n");
      })
  );

  // 7 ---------------------------------------------------------------
  server.registerTool(
    "lms_unfinished_tasks",
    {
      title: "Tugas belum selesai",
      description:
        "Tugas/quiz yang belum dikerjakan dan belum melewati cut-off (lintas kelas, semester terbaru kecuali ditentukan).",
      inputSchema: { semester: z.string().optional() },
      annotations: readOnly,
    },
    ({ semester }) =>
      run(async () => {
        const now = new Date();
        const { semester: sem, items } = await allItems(semester);
        const unknown = items.filter((i) => i.is_tugas && i.done === null).length;
        const rows = items
          .filter((i) => i.is_tugas && i.done === false && i.window !== "ditutup")
          .sort((a, b) => (parseWIB(a.due)?.getTime() ?? Infinity) - (parseWIB(b.due)?.getTime() ?? Infinity));
        let out = rows.length
          ? `Belum dikerjakan (semester ${sem ?? "-"}): ${rows.length}\n` + rows.map((r) => describeItem(r, now)).join("\n")
          : `Tidak ada tugas yang belum dikerjakan (semester ${sem ?? "-"}).`;
        if (unknown) out += `\n\n⚠ ${unknown} tugas tidak punya info status pengerjaan dari API (field MateriPeserta tidak ada), jadi tidak bisa dipastikan.`;
        return out;
      })
  );

  // 8 ---------------------------------------------------------------
  server.registerTool(
    "lms_my_answers",
    {
      title: "Jawaban & nilai saya",
      description: "Riwayat jawaban dan nilai milik akun ini untuk satu tugas/quiz (hanya data sendiri).",
      inputSchema: { id_kelas_materi: z.number().int().positive().describe("id_kelas_materi dari lms_get_course") },
      annotations: readOnly,
    },
    ({ id_kelas_materi }) =>
      run(async () => {
        const me = await lms.whoami();
        const json = await lms.get("/course/my-course/answer-list", {
          id_kelas_materi,
          limit: 1000,
          filter: JSON.stringify({ "Kelas.KelasPeserta.Peserta.id_user": me.id_user }),
        });
        // Jangan percaya filter di sisi server: ambil hanya peserta milik sendiri.
        const mine: any[] = [];
        for (const row of unwrapList(json).items)
          for (const kp of row?.Kelas?.KelasPeserta ?? []) if (kp?.Peserta?.id_user === me.id_user) mine.push(kp.Peserta);
        if (!mine.length) return "Tidak ada data jawaban untuk akun ini pada materi tersebut.";
        const p = mine[0];
        const nilai = p.NilaiMateri?.[0]?.nilai;
        const answers: any[] = p.MateriPeserta ?? [];
        const lines = [`Nilai terakhir: ${nilai ?? "belum ada"}`, `Jumlah pengumpulan: ${answers.length}`];
        answers.forEach((a, n) => {
          lines.push(
            "",
            `### Pengumpulan ${n + 1} — ${a.created_at ?? "-"} (${a.on_time === true || a.on_time === "true" ? "tepat waktu" : "terlambat/tidak diketahui"})`
          );
          if (a.lampiran) lines.push(`Lampiran: ${a.lampiran}`);
          const t = htmlToText(a.deskripsi, 1500);
          if (t) lines.push(t);
        });
        return lines.join("\n");
      })
  );

  // 9 ---------------------------------------------------------------
  server.registerTool(
    "lms_list_notifications",
    {
      title: "Notifikasi",
      description: "Notifikasi LMS terbaru untuk akun ini (default hanya yang belum dibaca). Tidak menandai sebagai dibaca.",
      inputSchema: {
        unread_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: readOnly,
    },
    ({ unread_only, limit }) =>
      run(async () => {
        const me = await lms.whoami();
        const filter: Record<string, unknown> = { id_user: me.id_user };
        if (unread_only) filter.st_read = 0;
        const json = await lms.get("/notifications/all", { filter: JSON.stringify(filter), limit }, 30_000);
        const page = unwrapList(json);
        const items = page.items.filter((n: any) => n.id_user === undefined || n.id_user === me.id_user);
        if (!items.length) return unread_only ? "Tidak ada notifikasi belum dibaca." : "Tidak ada notifikasi.";
        const total = page.pagination?.total;
        const head = total && total > items.length ? `Menampilkan ${items.length} dari ${total} notifikasi${unread_only ? " belum dibaca" : ""}:\n` : "";
        // st_read bertipe string ("0"/"1") di API; objek User bersarang sengaja tidak ditampilkan.
        return (
          head +
          items
            .slice(0, limit)
            .map((n: any) => `- ${n.created_at ?? "-"} ${String(n.st_read) === "1" ? "" : "(baru) "}${htmlToText(n.descriptions, 300).replace(/\s*\n+\s*/g, " | ")}`)
            .join("\n")
        );
      })
  );

  // 10 --------------------------------------------------------------
  server.registerTool(
    "lms_progress_summary",
    {
      title: "Ringkasan progres",
      description: "Ringkasan progres pengerjaan tugas per kelas dan keseluruhan (selesai / total tugas; Bahan Ajar tidak dihitung LMS).",
      inputSchema: { semester: z.string().optional().describe("default semester terbaru; 'all' = semua") },
      annotations: readOnly,
    },
    ({ semester }) =>
      run(async () => {
        const sem = semester === "all" ? undefined : semester ?? (await latestSemester());
        const courses = await listCourses({ semester: sem });
        if (!courses.length) return "Tidak ada kelas.";
        const done = courses.reduce((a, c) => a + c.materi_selesai, 0);
        const total = courses.reduce((a, c) => a + c.jumlah_materi, 0);
        const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
        return [
          `Tugas selesai, semester ${sem ?? "semua"} — total ${done}/${total} (${pct(done, total)}%)`,
          ...courses.map((c) => `- ${c.matkul}: ${c.jumlah_materi ? `${c.materi_selesai}/${c.jumlah_materi} (${pct(c.materi_selesai, c.jumlah_materi)}%)` : "belum ada tugas"}`),
        ].join("\n");
      })
  );
}
