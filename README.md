# lms-mcp

MCP server **read-only** untuk LMS UIN SGD (E-Knows), satu akun mahasiswa (kredensial di `.env`).

## Setup

```bash
npm install
cp .env.example .env     # lalu isi LMS_USERNAME (NIM) dan LMS_PASSWORD
npm run build
npm run probe            # fase 0: verifikasi endpoint dengan akun asli, simpan fixtures/ (disamarkan)
npm run smoke            # tes server via stdio
```

## Pasang di Claude Desktop (stdio)

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lms": {
      "command": "node",
      "args": ["F:\mcp\lms-mcp\dist\index.js"]
    }
  }
}
```

Kredensial dibaca dari `F:\mcp\lms-mcp\.env`. Alternatif: taruh `LMS_USERNAME`/`LMS_PASSWORD` di blok `"env"`.

## Mode HTTP (opsional)

`.env`: `MCP_TRANSPORT=http`, `MCP_AUTH_TOKEN=<acak ≥16 karakter>`, `MCP_HTTP_PORT=3333`
→ `POST http://127.0.0.1:3333/mcp` dengan header `Authorization: Bearer <token>` (stateless, hanya loopback).

## Tools (semuanya read-only)

| Tool | Fungsi |
|---|---|
| `lms_whoami` | Cek akun/login |
| `lms_list_semesters` | Daftar semester |
| `lms_list_courses` | Kelas + progres (default semester terbaru) |
| `lms_get_course` | Pertemuan → materi/tugas, tenggat WIB, status selesai |
| `lms_get_material` | Isi materi / instruksi tugas |
| `lms_upcoming_deadlines` | Tenggat N hari ke depan lintas kelas |
| `lms_unfinished_tasks` | Tugas belum dikerjakan |
| `lms_my_answers` | Jawaban & nilai sendiri |
| `lms_list_notifications` | Notifikasi (tidak menandai dibaca) |
| `lms_progress_summary` | Ringkasan progres |

## Batasan desain

- Hanya `GET` ke data; satu-satunya `POST` adalah `/auth/login` dan `/auth/sso` (pemulihan sesi).
- Tidak ada tool submit tugas/quiz, daftar soal quiz, atau data peserta lain (`my-student`).
- `id_user` selalu diambil dari `/auth/me`, tidak dari input model; hasil `answer-list` difilter ulang ke akun sendiri.
- Login gagal (400/401) tidak diulang selama 5 menit agar akun tidak terkunci.
- Password tidak pernah di-log. `.env` dan `fixtures/` ada di `.gitignore`.
- Struktur respons sesi login belum terverifikasi sampai `npm run probe` dijalankan (lihat `API_DOCUMENTATION.md`).

## Hasil verifikasi API (probe 2 Nov 2026, akun Mahasiswa)

- Login `POST /auth/login` → cookie `LMS`; `/auth/me` memberi `id_user`, `level=Mahasiswa`. `id_peserta` bernilai `null` (tidak dipakai tool read-only).
- `/course/my-course/detail` → setiap `KelasMateri` punya `MateriPeserta[]` (`status`, `on_time` string, `created_at`). **Hanya kategori "Tugas" yang diisi**; "Bahan Ajar" tidak punya status pengerjaan.
- `kelasMateriCount/Completed` di `/course/my-course` **hanya menghitung Tugas** (cocok dengan hitungan dari detail).
- Pagination memakai `{total, currentpage, limit, totalPages}`; `st_read` pada notifikasi bertipe string (`"0"`/`"1"`).
- Tanggal = string naif WIB; item yang lewat tenggat tetap bisa dikumpulkan sampai `cut_off_date`.
- Objek `User` pada notifikasi dan data peserta lain pada `answer-list` sengaja tidak ditampilkan.

## Perintah bantu

```bash
npm run probe                                          # verifikasi endpoint + fixtures/ (disamarkan)
SMOKE_REAL=1 npm run smoke                             # ringkasan beberapa tool nyata
npm run call -- lms_get_course '{"id_kelas":15344}'    # panggil satu tool
```
