// Splec Note — recursive "find in files" backend command.
//
// Walks a root directory, scanning text files for matches of a literal or regex
// query. Designed for the editor's project-wide search panel: it skips common
// noise directories (node_modules, .git, target, ...), ignores binary and
// oversized files, and reports character-accurate match offsets so the frontend
// can highlight multibyte text correctly.

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Directory names skipped anywhere in the tree.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".cache",
    ".venv",
    "__pycache__",
    ".idea",
    ".vscode",
];

/// Number of leading bytes inspected for a NUL byte to detect binary files.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// Max characters retained for a line preview.
const PREVIEW_CAP: usize = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindArgs {
    root: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include_glob: Option<String>,
    max_results: usize,
    max_file_size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub matches: Vec<FileMatch>,
    pub files_scanned: usize,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub file: String,
    pub line: usize,
    pub col: usize,
    pub preview: String,
    pub match_start: usize,
    pub match_end: usize,
}

/// Match a single filename against a glob supporting `*` and `?`.
/// Comparison is case-insensitive. Matches against the file name only.
fn glob_matches(pattern: &str, name: &str) -> bool {
    let pat: Vec<char> = pattern.to_lowercase().chars().collect();
    let text: Vec<char> = name.to_lowercase().chars().collect();

    // Iterative backtracking matcher.
    let (mut p, mut t) = (0usize, 0usize);
    let mut star_p: Option<usize> = None;
    let mut star_t = 0usize;

    while t < text.len() {
        if p < pat.len() && (pat[p] == '?' || pat[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pat.len() && pat[p] == '*' {
            star_p = Some(p);
            star_t = t;
            p += 1;
        } else if let Some(sp) = star_p {
            p = sp + 1;
            star_t += 1;
            t = star_t;
        } else {
            return false;
        }
    }

    while p < pat.len() && pat[p] == '*' {
        p += 1;
    }

    p == pat.len()
}

/// Returns true if the file name matches the include filter.
/// `None`/empty filter => match all files.
fn name_included(include_glob: &Option<String>, name: &str) -> bool {
    match include_glob {
        None => true,
        Some(spec) => {
            let patterns: Vec<&str> = spec
                .split(',')
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
                .collect();
            if patterns.is_empty() {
                return true;
            }
            patterns.iter().any(|p| glob_matches(p, name))
        }
    }
}

/// Build the search regex from the args.
fn build_regex(args: &FindArgs) -> Result<Regex, String> {
    let base = if args.is_regex {
        args.query.clone()
    } else {
        regex::escape(&args.query)
    };

    let pattern = if args.whole_word {
        format!(r"\b(?:{base})\b")
    } else {
        base
    };

    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!args.case_sensitive)
        .build()
        .map_err(|e| format!("Invalid search pattern: {e}"))
}

/// Detect a binary file by sniffing for a NUL byte in the leading bytes.
fn looks_binary(bytes: &[u8]) -> bool {
    let n = bytes.len().min(BINARY_SNIFF_BYTES);
    bytes[..n].contains(&0)
}

/// Cap a string to `max` characters.
fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// Convert a byte offset within `line` to a character offset.
fn byte_to_char(line: &str, byte: usize) -> usize {
    line[..byte].chars().count()
}

/// Recursively collect matching files under `root`, honoring skip dirs and the
/// include glob.
fn collect_files(root: &Path, include_glob: &Option<String>, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect_files(&path, include_glob, out);
        } else if file_type.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name_included(include_glob, &name) {
                out.push(path);
            }
        }
    }
}

/// Pure core: run the search and return the result. No Tauri dependency so it is
/// directly unit-testable.
pub fn run_search(args: &FindArgs) -> Result<FindResult, String> {
    let re = build_regex(args)?;
    let root = Path::new(&args.root);

    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(root, &args.include_glob, &mut files);
    files.sort();

    let mut matches: Vec<FileMatch> = Vec::new();
    let mut files_scanned = 0usize;
    let mut truncated = false;

    'outer: for path in &files {
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > args.max_file_size_bytes {
            continue;
        }

        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if looks_binary(&bytes) {
            continue;
        }

        files_scanned += 1;

        let text = String::from_utf8_lossy(&bytes);
        let file_str = path.to_string_lossy().to_string();

        for (idx, raw_line) in text.split('\n').enumerate() {
            // Strip a trailing '\r' (handles \r\n line endings).
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            let preview = cap_chars(line, PREVIEW_CAP);

            for m in re.find_iter(line) {
                let start_char = byte_to_char(line, m.start());
                let end_char = byte_to_char(line, m.end());

                matches.push(FileMatch {
                    file: file_str.clone(),
                    line: idx + 1,
                    col: start_char + 1,
                    preview: preview.clone(),
                    match_start: start_char,
                    match_end: end_char,
                });

                if matches.len() >= args.max_results {
                    truncated = true;
                    break 'outer;
                }
            }
        }
    }

    matches.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));

    Ok(FindResult {
        matches,
        files_scanned,
        truncated,
    })
}

#[tauri::command]
pub fn find_in_files(args: FindArgs) -> Result<FindResult, String> {
    run_search(&args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "splec-search-test-{}-{}-{:x}",
                std::process::id(),
                n,
                nanos
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, rel: &str, contents: &str) {
            let p = self.0.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(p, contents).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn args(root: &Path, query: &str) -> FindArgs {
        FindArgs {
            root: root.to_string_lossy().to_string(),
            query: query.to_string(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include_glob: None,
            max_results: 1000,
            max_file_size_bytes: 10 * 1024 * 1024,
        }
    }

    #[test]
    fn literal_match_char_offsets_multibyte() {
        let dir = TempDir::new();
        // First line ascii, second line has a multibyte "café" before the match.
        dir.write("a.txt", "hello world\ncafé needle here\n");

        let mut a = args(dir.path(), "needle");
        a.case_sensitive = true;
        let res = run_search(&a).unwrap();

        assert_eq!(res.matches.len(), 1);
        let m = &res.matches[0];
        assert_eq!(m.line, 2);
        // "café " is 5 characters, so the match starts at char offset 5.
        assert_eq!(m.match_start, 5);
        assert_eq!(m.match_end, 11);
        assert_eq!(m.col, 6);
        assert_eq!(m.preview, "café needle here");
        assert_eq!(res.files_scanned, 1);
        assert!(!res.truncated);
    }

    #[test]
    fn regex_case_insensitive() {
        let dir = TempDir::new();
        dir.write("b.txt", "Foo123\nbar\nFOO999\n");

        let mut a = args(dir.path(), r"foo\d+");
        a.is_regex = true;
        a.case_sensitive = false;
        let res = run_search(&a).unwrap();

        assert_eq!(res.matches.len(), 2);
        assert_eq!(res.matches[0].line, 1);
        assert_eq!(res.matches[1].line, 3);
    }

    #[test]
    fn include_glob_and_skips_node_modules() {
        let dir = TempDir::new();
        dir.write("keep.ts", "target value\n");
        dir.write("skip.md", "target value\n");
        dir.write("other.js", "target value\n");
        // Should be skipped entirely because it lives under node_modules.
        dir.write("node_modules/dep.ts", "target value\n");

        let mut a = args(dir.path(), "target");
        a.include_glob = Some("*.ts,*.tsx".to_string());
        let res = run_search(&a).unwrap();

        assert_eq!(res.files_scanned, 1);
        assert_eq!(res.matches.len(), 1);
        assert!(res.matches[0].file.ends_with("keep.ts"));
    }

    #[test]
    fn max_results_truncation() {
        let dir = TempDir::new();
        dir.write("c.txt", "x\nx\nx\nx\nx\n");

        let mut a = args(dir.path(), "x");
        a.max_results = 3;
        let res = run_search(&a).unwrap();

        assert_eq!(res.matches.len(), 3);
        assert!(res.truncated);
    }

    #[test]
    fn whole_word_and_binary_skip() {
        let dir = TempDir::new();
        dir.write("d.txt", "cat category cat\n");
        // Binary file with a NUL byte should be skipped.
        let bin = dir.path().join("e.txt");
        fs::write(&bin, b"cat\0cat").unwrap();

        let mut a = args(dir.path(), "cat");
        a.whole_word = true;
        let res = run_search(&a).unwrap();

        // Only the two standalone "cat" words in d.txt; "category" excluded.
        assert_eq!(res.matches.len(), 2);
        assert_eq!(res.files_scanned, 1);
    }
}
