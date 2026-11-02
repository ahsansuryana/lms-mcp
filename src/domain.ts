import { lms } from "./client.js";
import { fmtDelta, fmtWIB, parseWIB, unwrapList } from "./util.js";

const TTL_COURSES = 5 * 60_000;
const TTL_DETAIL = 2 * 60_000;

export type Window = "belum_mulai" | "terbuka" | "lewat_tenggat" | "ditutup" | "tanpa_batas";

export interface Item {
  id_kelas: number;
  kelas: string;
  matkul: string;
  pertemuan: string;
  id_kelas_materi: number;
  id_materi: number | null;
  nama: string;
  kategori: string;
  is_tugas: boolean; // bukan "Bahan Ajar"
  locked: boolean;
  start: string | null;
  due: string | null;
  cut_off: string | null;
  maksimal_jawab: number | null;
  done: boolean | null; // null = field MateriPeserta tidak ada di respons
  jumlah_jawaban: number | null;
  window: Window;
}

export function windowOf(start: string | null, due: string | null, cutOff: string | null, now = new Date()): Window {
  const s = parseWIB(start);
  const d = parseWIB(due);
  const c = parseWIB(cutOff);
  if (s && now < s) return "belum_mulai";
  if (c && now > c) return "ditutup";
  if (d && now > d) return "lewat_tenggat";
  if (!s && !d && !c) return "tanpa_batas";
  return "terbuka";
}

export async function listCourses(opts: { semester?: string; search?: string; limit?: number } = {}) {
  const filter: Record<string, string> = {};
  if (opts.semester) filter["Semester.kode_semester"] = opts.semester;
  if (opts.search) filter["MataPelajaran.nama"] = opts.search;
  const json = await lms.get(
    "/course/my-course",
    {
      page: 1,
      limit: opts.limit ?? 100,
      sort: JSON.stringify({ kode_kelas: "ASC" }),
      ...(Object.keys(filter).length ? { filter: JSON.stringify(filter) } : {}),
    },
    TTL_COURSES
  );
  return unwrapList(json).items.map((c: any) => ({
    id: c.id as number,
    kode_kelas: c.kode_kelas as string,
    nama: c.nama as string,
    matkul: (c.MataPelajaran?.nama ?? "") as string,
    jurusan: (c.MataPelajaran?.Jurusan?.nama ?? "") as string,
    dosen: (c.namaPengajarList ?? "") as string,
    semester: (c.Semester?.nama ?? "") as string,
    jumlah_materi: Number(c.kelasMateriCount ?? 0),
    materi_selesai: Number(c.kelasMateriCompleted ?? 0),
  }));
}

export async function latestSemester(): Promise<string | undefined> {
  try {
    const json = await lms.get("/course/my-course/my-semester", undefined, TTL_COURSES);
    const codes = unwrapList(json)
      .items.map((s: any) => String(s.kode_semester ?? s.nama ?? ""))
      .filter(Boolean)
      .sort();
    return codes.at(-1);
  } catch {
    return undefined;
  }
}

export async function getCourseDetail(idKelas: number) {
  const json: any = await lms.get(
    "/course/my-course/detail",
    { id_kelas: idKelas, limit: 50, sort: JSON.stringify({ nourut: "ASC" }) },
    TTL_DETAIL
  );
  const k = json?.kelasData ?? {};
  const kelas = {
    id: (k.id ?? idKelas) as number,
    kode_kelas: (k.kode_kelas ?? "") as string,
    nama: (k.nama ?? "") as string,
    matkul: (k.MataPelajaran?.nama ?? "") as string,
    dosen: (k.namaPengajarList ?? "") as string,
    semester: (k.Semester?.nama ?? "") as string,
  };
  const sections = unwrapList(json).items.map((s: any) => ({
    id: s.id as number,
    nama: (s.nama ?? "") as string,
    nourut: s.nourut as number,
    items: ((s.KelasMateri ?? []) as any[]).map((km): Item => {
      const kategori = (km.Materi?.KategoriMateri?.nama ?? "") as string;
      // Terverifikasi (probe): hanya kategori selain "Bahan Ajar" yang punya MateriPeserta.
      // kelasMateriCount/Completed di /my-course juga hanya menghitung tugas.
      const isTugas = kategori !== "" && kategori !== "Bahan Ajar";
      const mp = isTugas && Array.isArray(km.MateriPeserta) ? km.MateriPeserta : null;
      const start = km.start_date ?? null;
      const due = km.due_date ?? null;
      const cut = km.cut_off_date ?? null;
      return {
        id_kelas: kelas.id,
        kelas: `${kelas.kode_kelas} ${kelas.nama}`.trim(),
        matkul: kelas.matkul,
        pertemuan: (s.nama ?? "") as string,
        id_kelas_materi: km.id,
        id_materi: km.Materi?.id ?? km.id_materi ?? null,
        nama: (km.Materi?.nama ?? "(tanpa judul)") as string,
        kategori,
        is_tugas: isTugas,
        locked: km.status === "locked",
        start,
        due,
        cut_off: cut,
        maksimal_jawab: km.maksimal_jawab ?? null,
        done: mp ? mp.length > 0 : null,
        jumlah_jawaban: mp ? mp.length : null,
        window: windowOf(start, due, cut),
      };
    }),
  }));
  return { kelas, sections };
}

/** Semua item dari semua kelas pada satu semester (default: semester terbaru). */
export async function allItems(semester?: string) {
  const sem = semester ?? (await latestSemester());
  const courses = await listCourses({ semester: sem });
  const out: Item[] = [];
  // dibatasi oleh limiter concurrency di client
  const details = await Promise.all(courses.map((c) => getCourseDetail(c.id).catch(() => null)));
  for (const d of details) if (d) for (const s of d.sections) out.push(...s.items);
  return { semester: sem, courses, items: out };
}

/**
 * compact=true: dipakai di dalam satu kelas (tanpa nama matkul/pertemuan yang berulang).
 * Bahan Ajar tidak punya status pengerjaan & tenggatnya tidak relevan → hanya nama + id.
 */
export function describeItem(i: Item, now = new Date(), compact = false): string {
  const ids = `id_kelas_materi=${i.id_kelas_materi}${i.id_materi ? `, id_materi=${i.id_materi}` : ""}`;
  if (!i.is_tugas) {
    return `- ${i.nama} (${i.kategori || "materi"})${i.locked ? " [terkunci]" : ""} · ${ids}`;
  }
  const due = parseWIB(i.due);
  const cut = parseWIB(i.cut_off);
  const head = compact ? `**${i.nama}** (${i.kategori})` : `**${i.nama}** — ${i.matkul || i.kelas} (${i.kategori}, ${i.pertemuan})`;
  const parts = [head];
  if (due) parts.push(`tenggat ${fmtWIB(due)} (${fmtDelta(due.getTime() - now.getTime())})`);
  if (cut && cut.getTime() !== due?.getTime()) parts.push(`cut-off ${fmtWIB(cut)}`);
  const flags: string[] = [];
  if (i.done === true) flags.push("sudah dikerjakan");
  if (i.done === false) flags.push("belum dikerjakan");
  if (i.locked) flags.push("terkunci");
  if (i.window === "belum_mulai") flags.push("belum dibuka");
  if (i.window === "lewat_tenggat") flags.push("lewat tenggat, masih bisa dikumpulkan sampai cut-off");
  if (i.window === "ditutup") flags.push("ditutup");
  if (i.maksimal_jawab) flags.push(`maks ${i.maksimal_jawab}x`);
  if (flags.length) parts.push(`[${flags.join(", ")}]`);
  parts.push(ids);
  return "- " + parts.join(" · ");
}
