// Splec Note — session & backup engine ("never lose work").
//
// Layout on disk (under the app data dir, e.g. ~/Library/Application Support/com.splec.note):
//   session.json                      ← ordered manifest of open tabs (+ active tab)
//   AutoSave/<YYYY-MM-DD>/<id>.txt     ← continuously mirrored backup of every open buffer
//
// Every backend write is atomic (write to a temp file in the same directory, then rename).
// The frontend owns the manifest shape and treats it as opaque JSON here, which keeps the
// backend decoupled from UI details while still giving us atomic, crash-safe persistence.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Pure core (no Tauri) — unit-testable.
// ---------------------------------------------------------------------------
pub mod core {
    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_suffix() -> String {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{nanos:x}-{n:x}-{}", std::process::id())
    }

    /// Atomically write `bytes` to `path` (temp file in the same dir + rename).
    pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = match path.parent() {
            Some(parent) => parent.join(format!(".splec-tmp-{}", unique_suffix())),
            None => PathBuf::from(format!(".splec-tmp-{}", unique_suffix())),
        };
        // Best-effort durability: write, then rename over the destination.
        fs::write(&tmp, bytes)?;
        match fs::rename(&tmp, path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    /// Detect the dominant line ending of `s`. Returns "CRLF", "CR" or "LF".
    pub fn detect_eol(s: &str) -> &'static str {
        if s.contains("\r\n") {
            "CRLF"
        } else if s.contains('\n') {
            "LF"
        } else if s.contains('\r') {
            "CR"
        } else {
            "LF"
        }
    }

    /// Normalize CRLF/CR to LF for in-editor use.
    pub fn normalize_to_lf(s: &str) -> String {
        s.replace("\r\n", "\n").replace('\r', "\n")
    }

    /// Convert LF text to the requested EOL ("CRLF" => CRLF, "CR" => CR, else LF).
    pub fn apply_eol(s: &str, eol: &str) -> String {
        let lf = normalize_to_lf(s);
        if eol.eq_ignore_ascii_case("crlf") {
            lf.replace('\n', "\r\n")
        } else if eol.eq_ignore_ascii_case("cr") {
            lf.replace('\n', "\r")
        } else {
            lf
        }
    }

    /// Canonical encoding labels understood by Splec Note.
    pub fn canonical_encoding(enc: &str) -> &'static str {
        match enc.to_ascii_uppercase().replace('_', "-").as_str() {
            "UTF-8-BOM" | "UTF8-BOM" => "UTF-8-BOM",
            "UTF-16LE" | "UTF16LE" => "UTF-16LE",
            "UTF-16BE" | "UTF16BE" => "UTF-16BE",
            _ => "UTF-8",
        }
    }

    /// Decode raw file bytes to a UTF-8 string, detecting the encoding from a BOM
    /// (or a light heuristic for BOM-less UTF-16). Returns (text, encoding label).
    pub fn decode_bytes(raw: &[u8]) -> (String, &'static str) {
        // BOM sniffing first — unambiguous.
        if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return (String::from_utf8_lossy(&raw[3..]).into_owned(), "UTF-8-BOM");
        }
        if raw.starts_with(&[0xFF, 0xFE]) {
            return (decode_utf16(&raw[2..], false), "UTF-16LE");
        }
        if raw.starts_with(&[0xFE, 0xFF]) {
            return (decode_utf16(&raw[2..], true), "UTF-16BE");
        }
        // BOM-less UTF-16 heuristic: scan a window for NUL bytes biased to one side.
        let window = &raw[..raw.len().min(4096)];
        if window.len() >= 2 {
            let mut zero_even = 0usize; // NUL at even index => UTF-16BE (hi byte 0)
            let mut zero_odd = 0usize; //  NUL at odd index  => UTF-16LE (hi byte 0)
            for (i, &b) in window.iter().enumerate() {
                if b == 0 {
                    if i % 2 == 0 {
                        zero_even += 1;
                    } else {
                        zero_odd += 1;
                    }
                }
            }
            let total = window.len();
            if zero_odd * 4 > total && zero_odd > zero_even * 4 {
                return (decode_utf16(raw, false), "UTF-16LE");
            }
            if zero_even * 4 > total && zero_even > zero_odd * 4 {
                return (decode_utf16(raw, true), "UTF-16BE");
            }
        }
        (String::from_utf8_lossy(raw).into_owned(), "UTF-8")
    }

    /// Decode UTF-16 bytes (already past any BOM) in the given endianness.
    fn decode_utf16(bytes: &[u8], big_endian: bool) -> String {
        let mut units: Vec<u16> = Vec::with_capacity(bytes.len() / 2);
        let mut i = 0;
        while i + 1 < bytes.len() {
            let unit = if big_endian {
                u16::from_be_bytes([bytes[i], bytes[i + 1]])
            } else {
                u16::from_le_bytes([bytes[i], bytes[i + 1]])
            };
            units.push(unit);
            i += 2;
        }
        String::from_utf16_lossy(&units)
    }

    /// Encode LF text into the target encoding + EOL, including any BOM.
    pub fn encode_bytes(text_lf: &str, encoding: &str, eol: &str) -> Vec<u8> {
        let s = apply_eol(text_lf, eol);
        match canonical_encoding(encoding) {
            "UTF-8-BOM" => {
                let mut out = vec![0xEF, 0xBB, 0xBF];
                out.extend_from_slice(s.as_bytes());
                out
            }
            "UTF-16LE" => {
                let mut out = vec![0xFF, 0xFE];
                for u in s.encode_utf16() {
                    out.extend_from_slice(&u.to_le_bytes());
                }
                out
            }
            "UTF-16BE" => {
                let mut out = vec![0xFE, 0xFF];
                for u in s.encode_utf16() {
                    out.extend_from_slice(&u.to_be_bytes());
                }
                out
            }
            _ => s.into_bytes(),
        }
    }

    /// Write a buffer backup to `<autosave>/<day>/<id>.txt`. Returns the relative path
    /// ("<day>/<id>.txt") that the manifest should store.
    pub fn write_backup(autosave: &Path, day: &str, id: &str, content: &str) -> io::Result<String> {
        let safe_id = sanitize_id(id);
        let rel = format!("{day}/{safe_id}.txt");
        let full = autosave.join(&rel);
        atomic_write(&full, content.as_bytes())?;
        Ok(rel)
    }

    pub fn read_backup(autosave: &Path, rel: &str) -> io::Result<String> {
        fs::read_to_string(autosave.join(rel))
    }

    pub fn delete_backup(autosave: &Path, rel: &str) -> io::Result<()> {
        let full = autosave.join(rel);
        if full.exists() {
            fs::remove_file(full)?;
        }
        Ok(())
    }

    pub fn write_manifest(session_file: &Path, manifest: &Value) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        atomic_write(session_file, &bytes)
    }

    pub fn read_manifest(session_file: &Path) -> Option<Value> {
        let bytes = fs::read(session_file).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Remove dated folders older than `retention_days`, and remove any backup file whose
    /// relative path is not in `keep`. `today` is "YYYY-MM-DD".
    pub fn cleanup(
        autosave: &Path,
        keep: &HashSet<String>,
        retention_days: i64,
        today: &str,
    ) -> io::Result<u64> {
        let mut removed = 0u64;
        if !autosave.exists() {
            return Ok(0);
        }
        let today_ord = date_ordinal(today);
        for entry in fs::read_dir(autosave)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let day = match path.file_name().and_then(|n| n.to_str()) {
                Some(d) => d.to_string(),
                None => continue,
            };
            let day_ord = date_ordinal(&day);
            let age = today_ord.zip(day_ord).map(|(t, d)| t - d);

            // Drop whole folders that are older than the retention window.
            if let Some(age_days) = age {
                if age_days > retention_days {
                    if fs::remove_dir_all(&path).is_ok() {
                        removed += 1;
                    }
                    continue;
                }
            }

            // Within retained folders, drop orphaned backups (closed buffers).
            for f in fs::read_dir(&path)? {
                let f = f?;
                let fp = f.path();
                if !fp.is_file() {
                    continue;
                }
                let rel = format!(
                    "{day}/{}",
                    fp.file_name().and_then(|n| n.to_str()).unwrap_or("")
                );
                if !keep.contains(&rel) {
                    if fs::remove_file(&fp).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
        Ok(removed)
    }

    fn sanitize_id(id: &str) -> String {
        id.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }

    /// Convert "YYYY-MM-DD" into a rough day ordinal for age comparison.
    fn date_ordinal(day: &str) -> Option<i64> {
        let mut it = day.split('-');
        let y: i64 = it.next()?.parse().ok()?;
        let m: i64 = it.next()?.parse().ok()?;
        let d: i64 = it.next()?.parse().ok()?;
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return None;
        }
        Some(y * 372 + m * 31 + d)
    }
}

// ---------------------------------------------------------------------------
// Tauri-facing helpers & commands.
// ---------------------------------------------------------------------------

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn autosave_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("AutoSave"))
}

fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("session.json"))
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

#[derive(Serialize)]
pub struct SessionPaths {
    pub data_dir: String,
    pub autosave_dir: String,
    pub session_file: String,
}

#[derive(Serialize)]
pub struct FileRead {
    pub content: String,
    pub eol: String,
    pub encoding: String,
    pub mtime_ms: Option<u64>,
    pub size: u64,
}

#[derive(Serialize)]
pub struct FileStat {
    pub exists: bool,
    pub mtime_ms: Option<u64>,
    pub size: u64,
}

#[derive(Serialize)]
pub struct WriteResult {
    pub mtime_ms: Option<u64>,
    pub size: u64,
}

#[derive(Serialize)]
pub struct RestoredSession {
    pub manifest: Value,
    /// id -> backup content for every backup we could read.
    pub contents: std::collections::HashMap<String, String>,
}

#[tauri::command]
pub fn session_paths(app: AppHandle) -> Result<SessionPaths, String> {
    Ok(SessionPaths {
        data_dir: data_dir(&app)?.to_string_lossy().into_owned(),
        autosave_dir: autosave_dir(&app)?.to_string_lossy().into_owned(),
        session_file: session_file(&app)?.to_string_lossy().into_owned(),
    })
}

/// Read a real file from disk, normalizing EOL to LF and reporting the detected
/// EOL + encoding (BOM-aware, with a light BOM-less UTF-16 heuristic).
#[tauri::command]
pub fn read_text_file(path: String) -> Result<FileRead, String> {
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let size = raw.len() as u64;
    let (text, encoding) = core::decode_bytes(&raw);
    let eol = core::detect_eol(&text).to_string();
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(FileRead {
        content: core::normalize_to_lf(&text),
        eol,
        encoding: encoding.to_string(),
        mtime_ms: mtime_ms(&meta),
        size,
    })
}

/// Atomically write a real file. `content` is LF text; it is converted to `eol`
/// and encoded as `encoding` (with any BOM) before writing.
#[tauri::command]
pub fn write_text_file(
    path: String,
    content: String,
    eol: String,
    encoding: Option<String>,
) -> Result<WriteResult, String> {
    let enc = encoding.unwrap_or_else(|| "UTF-8".to_string());
    let out = core::encode_bytes(&content, &enc, &eol);
    let len = out.len() as u64;
    core::atomic_write(Path::new(&path), &out).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(WriteResult {
        mtime_ms: mtime_ms(&meta),
        size: len,
    })
}

#[tauri::command]
pub fn stat_file(path: String) -> Result<FileStat, String> {
    match fs::metadata(&path) {
        Ok(meta) => Ok(FileStat {
            exists: true,
            mtime_ms: mtime_ms(&meta),
            size: meta.len(),
        }),
        Err(_) => Ok(FileStat {
            exists: false,
            mtime_ms: None,
            size: 0,
        }),
    }
}

/// Mirror an open buffer to today's AutoSave folder. Returns the manifest-relative path.
#[tauri::command]
pub fn autosave_backup(app: AppHandle, id: String, content: String) -> Result<String, String> {
    let dir = autosave_dir(&app)?;
    core::write_backup(&dir, &today(), &id, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_backup(app: AppHandle, rel: String) -> Result<String, String> {
    let dir = autosave_dir(&app)?;
    core::read_backup(&dir, &rel).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_backup(app: AppHandle, rel: String) -> Result<(), String> {
    let dir = autosave_dir(&app)?;
    core::delete_backup(&dir, &rel).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_session(app: AppHandle, manifest: Value) -> Result<(), String> {
    let file = session_file(&app)?;
    core::write_manifest(&file, &manifest).map_err(|e| e.to_string())
}

/// Load the manifest and every readable backup so the UI can fully rebuild tabs.
#[tauri::command]
pub fn load_session(app: AppHandle) -> Result<Option<RestoredSession>, String> {
    let file = session_file(&app)?;
    let manifest = match core::read_manifest(&file) {
        Some(m) => m,
        None => return Ok(None),
    };
    let dir = autosave_dir(&app)?;
    let mut contents = std::collections::HashMap::new();
    if let Some(tabs) = manifest.get("tabs").and_then(|t| t.as_array()) {
        for tab in tabs {
            let id = tab.get("id").and_then(|v| v.as_str());
            let rel = tab.get("backup").and_then(|v| v.as_str());
            if let (Some(id), Some(rel)) = (id, rel) {
                if let Ok(text) = core::read_backup(&dir, rel) {
                    contents.insert(id.to_string(), text);
                }
            }
        }
    }
    let count = contents.len();
    println!("[splec session] restoring {count} backed-up buffer(s) from {file:?}");
    Ok(Some(RestoredSession { manifest, contents }))
}

#[tauri::command]
pub fn cleanup_backups(
    app: AppHandle,
    keep: Vec<String>,
    retention_days: i64,
) -> Result<u64, String> {
    let dir = autosave_dir(&app)?;
    let keep_set: HashSet<String> = keep.into_iter().collect();
    core::cleanup(&dir, &keep_set, retention_days, &today()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::core::*;
    use serde_json::json;
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("splec-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_creates_parents_and_content() {
        let dir = tmpdir("atomic");
        let target = dir.join("nested/deep/file.txt");
        atomic_write(&target, b"hello").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        // overwrite
        atomic_write(&target, b"world").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "world");
        // no leftover temp files
        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".splec-tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn eol_detection_and_roundtrip() {
        assert_eq!(detect_eol("a\r\nb"), "CRLF");
        assert_eq!(detect_eol("a\nb"), "LF");
        assert_eq!(detect_eol("a\rb"), "CR");
        assert_eq!(detect_eol("no newline"), "LF");
        assert_eq!(normalize_to_lf("a\r\nb\rc"), "a\nb\nc");
        assert_eq!(apply_eol("a\nb", "crlf"), "a\r\nb");
        assert_eq!(apply_eol("a\r\nb", "lf"), "a\nb");
        assert_eq!(apply_eol("a\nb", "cr"), "a\rb");
    }

    #[test]
    fn encoding_detect_and_roundtrip() {
        // UTF-8 (no BOM)
        let (t, e) = decode_bytes("héllo".as_bytes());
        assert_eq!(t, "héllo");
        assert_eq!(e, "UTF-8");
        // UTF-8 BOM
        let mut bom8 = vec![0xEF, 0xBB, 0xBF];
        bom8.extend_from_slice("hi".as_bytes());
        let (t, e) = decode_bytes(&bom8);
        assert_eq!(t, "hi");
        assert_eq!(e, "UTF-8-BOM");
        // UTF-16LE with BOM
        let le = encode_bytes("hi\nx", "UTF-16LE", "LF");
        assert_eq!(&le[..2], &[0xFF, 0xFE]);
        let (t, e) = decode_bytes(&le);
        assert_eq!(t, "hi\nx");
        assert_eq!(e, "UTF-16LE");
        // UTF-16BE with BOM
        let be = encode_bytes("hi", "UTF-16BE", "LF");
        assert_eq!(&be[..2], &[0xFE, 0xFF]);
        let (t, e) = decode_bytes(&be);
        assert_eq!(t, "hi");
        assert_eq!(e, "UTF-16BE");
        // UTF-8-BOM encode prepends BOM
        let b = encode_bytes("z", "UTF-8-BOM", "LF");
        assert_eq!(&b[..3], &[0xEF, 0xBB, 0xBF]);
    }

    #[test]
    fn backup_roundtrip_named_and_untitled() {
        let dir = tmpdir("backup");
        let autosave = dir.join("AutoSave");
        let day = "2026-06-30";

        // an untitled scratch buffer that was never saved to a real path
        let rel = write_backup(&autosave, day, "buf-untitled-1", "scratch note\nwith two lines")
            .unwrap();
        assert_eq!(rel, "2026-06-30/buf-untitled-1.txt");
        assert_eq!(read_backup(&autosave, &rel).unwrap(), "scratch note\nwith two lines");

        // delete it
        delete_backup(&autosave, &rel).unwrap();
        assert!(read_backup(&autosave, &rel).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn manifest_roundtrip() {
        let dir = tmpdir("manifest");
        let file = dir.join("session.json");
        let manifest = json!({
            "version": 1,
            "activeId": "buf-2",
            "tabs": [
                {"id": "buf-1", "path": "/tmp/a.rs", "backup": "2026-06-30/buf-1.txt"},
                {"id": "buf-2", "path": null, "backup": "2026-06-30/buf-2.txt"}
            ]
        });
        write_manifest(&file, &manifest).unwrap();
        let back = read_manifest(&file).unwrap();
        assert_eq!(back["activeId"], "buf-2");
        assert_eq!(back["tabs"].as_array().unwrap().len(), 2);
        assert!(read_manifest(&dir.join("missing.json")).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn full_save_then_restore_includes_untitled() {
        // Simulate Phase 2's core promise: write backups + manifest, then restore both
        // a saved file tab and an unsaved untitled tab purely from disk.
        let dir = tmpdir("restore");
        let autosave = dir.join("AutoSave");
        let session = dir.join("session.json");
        let day = "2026-06-30";

        let saved_rel = write_backup(&autosave, day, "buf-saved", "fn main() {}").unwrap();
        let scratch_rel =
            write_backup(&autosave, day, "buf-scratch", "TODO buy milk").unwrap();
        let manifest = json!({
            "version": 1,
            "activeId": "buf-scratch",
            "tabs": [
                {"id": "buf-saved", "path": "/work/main.rs", "backup": saved_rel,
                 "cursor": 5, "scrollTop": 0.0, "dirty": false},
                {"id": "buf-scratch", "path": null, "title": "untitled-1", "backup": scratch_rel,
                 "cursor": 4, "scrollTop": 0.0, "dirty": true},
            ]
        });
        write_manifest(&session, &manifest).unwrap();

        // Restore
        let restored = read_manifest(&session).unwrap();
        let tabs = restored["tabs"].as_array().unwrap();
        assert_eq!(restored["activeId"], "buf-scratch");
        assert_eq!(tabs.len(), 2);
        let scratch = read_backup(&autosave, tabs[1]["backup"].as_str().unwrap()).unwrap();
        assert_eq!(scratch, "TODO buy milk"); // unsaved content survived
        let saved = read_backup(&autosave, tabs[0]["backup"].as_str().unwrap()).unwrap();
        assert_eq!(saved, "fn main() {}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cleanup_drops_old_folders_and_orphans() {
        let dir = tmpdir("cleanup");
        let autosave = dir.join("AutoSave");
        // recent day with one kept + one orphan
        write_backup(&autosave, "2026-06-30", "keep", "x").unwrap();
        write_backup(&autosave, "2026-06-30", "orphan", "y").unwrap();
        // old day, should be removed entirely
        write_backup(&autosave, "2026-05-01", "old", "z").unwrap();

        let mut keep = HashSet::new();
        keep.insert("2026-06-30/keep.txt".to_string());

        cleanup(&autosave, &keep, 14, "2026-06-30").unwrap();

        assert!(autosave.join("2026-06-30/keep.txt").exists());
        assert!(!autosave.join("2026-06-30/orphan.txt").exists());
        assert!(!autosave.join("2026-05-01").exists());
        fs::remove_dir_all(&dir).ok();
    }
}
