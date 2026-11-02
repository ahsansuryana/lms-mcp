/**
 * Fase 0 — verifikasi endpoint dengan akun asli (read-only).
 * Jalankan:  npm run probe
 * Hasil: fixtures/*.json (PII disamarkan) + laporan ringkas di terminal.
 * fixtures/ ada di .gitignore.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lms } from "../src/client.js";
import { unwrapList } from "../src/util.js";

const OUT = path.resolve("fixtures");
mkdirSync(OUT, { recursive: true });

const PII_KEYS = new Set([
  "nama", "nama_peserta", "username", "nomor_peserta", "email", "nmr_tlpn", "foto",
  "namaPengajarList", "lampiran", "deskripsi", "descriptions", "id_user", "id_peserta",
]);
// "nama" pada objek referensi (bukan orang) tidak sensitif dan penting untuk memahami struktur.
const KEEP_NAMA_UNDER = new Set(["KategoriMateri", "KomponenNilai", "Semester", "Jurusan"]);

function redact(v: any, key = "", parent = ""): any {
  if (Array.isArray(v)) return v.map((x) => redact(x, key, parent));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k, key)]));
  if (PII_KEYS.has(key) && v != null && !(key === "nama" && KEEP_NAMA_UNDER.has(parent))) {
    return typeof v === "number" ? 0 : "«redacted»";
  }
  return v;
}

const report: string[] = [];
async function probe(name: string, p: string, query?: Record<string, string | number>) {
  try {
    const json = await lms.get(p, query);
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify(redact(json), null, 2));
    report.push(`✅ ${name.padEnd(22)} GET ${p}  (items: ${unwrapList(json).items.length})`);
    return json;
  } catch (e: any) {
    report.push(`❌ ${name.padEnd(22)} GET ${p}  → ${e.message}`);
    return null;
  }
}

async function probeDetail(label: string, course: any, me: any) {
  const detail = await probe(`detail-${label}`, "/course/my-course/detail", { id_kelas: course.id, limit: 50 });
  const kms = unwrapList(detail).items.flatMap((s: any) => s.KelasMateri ?? []);
  const withMP = kms.filter((k: any) => Array.isArray(k.MateriPeserta)).length;
  const cats = [...new Set(kms.map((k: any) => k.Materi?.KategoriMateri?.nama).filter(Boolean))];
  const statuses = [...new Set(kms.map((k: any) => k.status))];
  report.push(`   [${label}] kelas ${course.id} (${course.kelasMateriCompleted}/${course.kelasMateriCount} selesai menurut list)`);
  report.push(`   KelasMateri: ${kms.length}, punya MateriPeserta: ${withMP}${kms.length && !withMP ? "  ⚠ field tidak ada" : ""}`);
  report.push(`   kategori: ${cats.join(", ") || "-"} | status: ${statuses.join(", ") || "-"}`);
  if (kms[0]) report.push(`   keys KelasMateri: ${Object.keys(kms[0]).join(", ")}`);
  const doneCount = kms.filter((k: any) => (k.MateriPeserta?.length ?? 0) > 0).length;
  report.push(`   done menurut MateriPeserta: ${doneCount}/${kms.length}`);
  return kms;
}

const me = await lms.whoami();
report.push(`✅ login               level=${me.level} id_peserta=${me.id_peserta ?? "null"}`);
if (me.level !== "Mahasiswa") report.push(`⚠ level bukan "Mahasiswa" (${me.level})`);

const sems = await probe("semesters", "/course/my-course/my-semester");
const codes = unwrapList(sems).items.map((s: any) => String(s.kode_semester)).sort();
report.push(`   semester terbaru: ${codes.at(-1)}`);

const courses = await probe("courses", "/course/my-course", { page: 1, limit: 100 });
const list: any[] = unwrapList(courses).items.filter((c: any) => Number(c.kelasMateriCount) > 0);
const full = [...list].sort((a, b) => b.kelasMateriCount - a.kelasMateriCount)[0];
const partial = list.find((c) => c.kelasMateriCompleted > 0 && c.kelasMateriCompleted < c.kelasMateriCount);

let sample: any = null;
if (full) {
  const kms = await probeDetail("full", full, me);
  sample = kms.find((k: any) => k.Materi?.id) ?? null;
}
if (partial && partial.id !== full?.id) {
  const kms = await probeDetail("partial", partial, me);
  sample ??= kms.find((k: any) => k.Materi?.id) ?? null;
}
if (!full) report.push("⚠ tidak ada kelas dengan materi");

if (sample) {
  await probe("material", `/master/materi/view/${sample.Materi.id}`);
  await probe("answer-list", "/course/my-course/answer-list", {
    id_kelas_materi: sample.id,
    limit: 1000,
    filter: JSON.stringify({ "Kelas.KelasPeserta.Peserta.id_user": me.id_user }),
  });
}
await probe("notifications", "/notifications/all", { filter: JSON.stringify({ id_user: me.id_user, st_read: 0 }), limit: 20 });

console.log("\n" + report.join("\n") + `\n\nFixture (disamarkan) → ${OUT}\n`);
