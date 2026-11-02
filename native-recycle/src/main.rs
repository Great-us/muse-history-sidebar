// Windows recycling adapted from Muse Desktop session_catalog.rs.
// Copyright (c) 2026 Etienne Lescot. Licensed under MIT; see ../LICENSE.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use serde_json::{json, Value};

#[derive(Debug)]
struct Input {
    root: PathBuf,
    session: String,
    directory: PathBuf,
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Input, String> {
    let mut args = args.into_iter();
    let (mut root, mut session, mut directory) = (None, None, None);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| "each flag requires a value".to_string())?;
        match flag.to_str() {
            Some("--root") if root.is_none() => root = Some(PathBuf::from(value)),
            Some("--session") if session.is_none() => session = Some(value.into_string().map_err(|_| "session ID must be Unicode".to_string())?),
            Some("--directory") if directory.is_none() => directory = Some(PathBuf::from(value)),
            _ => return Err("unknown or duplicate argument; expected --root, --session and --directory".to_string()),
        }
    }
    Ok(Input {
        root: root.ok_or_else(|| "missing --root".to_string())?,
        session: session.ok_or_else(|| "missing --session".to_string())?,
        directory: directory.ok_or_else(|| "missing --directory".to_string())?,
    })
}

fn validate_input(input: &Input) -> Result<(), String> {
    let mut id_parts = Path::new(&input.session).components();
    if !matches!(id_parts.next(), Some(Component::Normal(_))) || id_parts.next().is_some() {
        return Err("session ID must be a single directory name".to_string());
    }
    for path in [&input.root, &input.directory] {
        if !path.is_absolute() {
            return Err("root and directory must be absolute paths".to_string());
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let text = path.to_string_lossy();
            if text.starts_with(r"\\?\") || text.starts_with(r"\\.\") || path.as_os_str().encode_wide().count() >= 260 {
                return Err("extended, device or long paths are not supported; the source was left in place".to_string());
            }
        }
    }
    if input.directory.file_name().and_then(|name| name.to_str()) != Some(input.session.as_str()) {
        return Err("directory basename must match the session ID".to_string());
    }
    let canonical_root = input.root.canonicalize().map_err(|e| format!("cannot resolve sessions root: {e}"))?;
    let canonical_dir = input.directory.canonicalize().map_err(|e| format!("cannot resolve session directory: {e}"))?;
    if canonical_dir == canonical_root || !canonical_dir.starts_with(&canonical_root) {
        return Err("session directory must be strictly inside the canonical sessions root".to_string());
    }
    let log = input.directory.join("session.jsonl");
    for (path, directory) in [(&input.directory, true), (&log, false)] {
        let metadata = path.symlink_metadata().map_err(|e| format!("cannot inspect {}: {e}", path.display()))?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("session directory and log must not be reparse points".to_string());
            }
        }
        if metadata.file_type().is_symlink() || (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
            return Err("expected an actual session directory and session.jsonl file".to_string());
        }
    }
    Ok(())
}

fn run(args: impl IntoIterator<Item = OsString>) -> (Value, i32) {
    let input = match parse_args(args) {
        Ok(input) => input,
        Err(message) => return (json!({"status": "failed", "sourceGone": false, "message": message}), 1),
    };
    match validate_input(&input).and_then(|_| recycle_directory(&input.directory)) {
        Ok(delete_hresult) => (json!({
            "status": "recycled", "sourceGone": true,
            "deleteHresult": delete_hresult, "hasRecycleItem": true,
        }), 0),
        Err(message) => {
            let source_gone = input.directory.try_exists().is_ok_and(|exists| !exists);
            (json!({"status": "failed", "sourceGone": source_gone, "message": message}), 1)
        }
    }
}

fn main() {
    let (result, code) = run(std::env::args_os().skip(1));
    println!("{result}");
    std::process::exit(code);
}

/// Public API evidence required before any cold engine verification.
#[derive(Debug, Clone, Default)]
struct RecycleReceipt {
    delete_result: Option<(i32, bool)>,
}

fn verify_recycle_receipt(
    perform: Result<(), String>,
    aborted: bool,
    receipt: &RecycleReceipt,
    source_exists: bool,
) -> Result<i32, String> {
    perform.map_err(|error| format!(
        "{error}; aborted={aborted}, PostDeleteItem={:?}, source_exists={source_exists}",
        receipt.delete_result,
    ))?;
    if aborted {
        return Err("the Windows recycle-bin operation was aborted".to_string());
    }
    let delete_hresult = match receipt.delete_result {
        Some((hr, true)) if hr >= 0 => hr,
        Some((hr, _)) if hr < 0 => return Err(format!("PostDeleteItem reported failure 0x{:08X}", hr as u32)),
        _ => return Err("PostDeleteItem returned no recycle-bin item receipt; recoverable recycle is unverified".to_string()),
    };
    if source_exists {
        return Err("the recycle-bin operation left the source directory in place".to_string());
    }
    Ok(delete_hresult)
}

#[cfg(windows)]
mod windows_recycle {
    use super::RecycleReceipt;
    use std::sync::{Arc, Mutex};
    use windows::core::{implement, PCWSTR};
    use windows::Win32::UI::Shell::{IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem};

    #[implement(IFileOperationProgressSink)]
    struct RecycleSink {
        receipt: Arc<Mutex<RecycleReceipt>>,
    }

    #[allow(non_snake_case, unused_variables)]
    impl IFileOperationProgressSink_Impl for RecycleSink_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> { Ok(()) }
        fn FinishOperations(&self, hrresult: windows::core::HRESULT) -> windows::core::Result<()> { Ok(()) }
        fn PreRenameItem(&self, dwflags: u32, psiitem: windows::core::Ref<'_, IShellItem>, psznewname: &windows::core::PCWSTR) -> windows::core::Result<()> { Ok(()) }
        fn PostRenameItem(&self, dwflags: u32, psiitem: windows::core::Ref<'_, IShellItem>, psznewname: &windows::core::PCWSTR, hrrename: windows::core::HRESULT, psinewlycreated: windows::core::Ref<'_, IShellItem>) -> windows::core::Result<()> { Ok(()) }
        fn PreMoveItem(&self, dwflags: u32, psiitem: windows::core::Ref<'_, IShellItem>, psidestinationfolder: windows::core::Ref<'_, IShellItem>, psznewname: &windows::core::PCWSTR) -> windows::core::Result<()> { Ok(()) }
        fn PostMoveItem(&self, dwflags: u32, psiitem: windows::core::Ref<'_, IShellItem>, psidestinationfolder: windows::core::Ref<'_, IShellItem>, psznewname: &windows::core::PCWSTR, hrmove: windows::core::HRESULT, psinewlycreated: windows::core::Ref<'_, IShellItem>) -> windows::core::Result<()> { Ok(()) }
        fn PreCopyItem(&self, dwflags: u32, psiitem: windows::core::Ref<'_, IShellItem>, psidestinationfolder: windows::core::Ref<'_, IShellItem>, psznewname: &windows::core::PCWSTR) -> windows::core::Result<()> { Ok(()) }
        fn PostCopyItem(&self, dwflags: u32, psiitem: windows::core::Ref<'_, IShellItem>, psidestinationfolder: windows::core::Ref<'_, IShellItem>, psznewname: &windows::core::PCWSTR, hrcopy: windows::core::HRESULT, psinewlycreated: windows::core::Ref<'_, IShellItem>) -> windows::core::Result<()> { Ok(()) }
        fn PreDeleteItem(&self, dwflags: u32, psiitem: windows::core::Ref<'_, IShellItem>) -> windows::core::Result<()> { Ok(()) }
        fn PostDeleteItem(&self, dwflags: u32, psiitem: windows::core::Ref<'_, IShellItem>, hrdelete: windows::core::HRESULT, psinewlycreated: windows::core::Ref<'_, IShellItem>) -> windows::core::Result<()> { let mut receipt = self.receipt.lock().map_err(|_| windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005u32 as i32)))?;
            receipt.delete_result = Some((hrdelete.0, psinewlycreated.as_ref().is_some()));
            Ok(()) }
        fn PreNewItem(&self, dwflags: u32, psidestinationfolder: windows::core::Ref<'_, IShellItem>, psznewname: &windows::core::PCWSTR) -> windows::core::Result<()> { Ok(()) }
        fn PostNewItem(&self, dwflags: u32, psidestinationfolder: windows::core::Ref<'_, IShellItem>, psznewname: &windows::core::PCWSTR, psztemplatename: &windows::core::PCWSTR, dwfileattributes: u32, hrnew: windows::core::HRESULT, psinewitem: windows::core::Ref<'_, IShellItem>) -> windows::core::Result<()> { Ok(()) }
        fn UpdateProgress(&self, iworktotal: u32, iworksofar: u32) -> windows::core::Result<()> { Ok(()) }
        fn ResetTimer(&self) -> windows::core::Result<()> { Ok(()) }
        fn PauseTimer(&self) -> windows::core::Result<()> { Ok(()) }
        fn ResumeTimer(&self) -> windows::core::Result<()> { Ok(()) }
    }

    pub fn recycle(dir: &std::path::Path) -> Result<i32, String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
        use windows::Win32::UI::Shell::{FileOperation, IFileOperation, SHCreateItemFromParsingName, FOFX_RECYCLEONDELETE, FOF_WANTNUKEWARNING, FOFX_EARLYFAILURE};
        let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
        let receipt = Arc::new(Mutex::new(RecycleReceipt::default()));
        let sink: IFileOperationProgressSink = RecycleSink { receipt: receipt.clone() }.into();
        unsafe {
            let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("cannot create Windows recycle operation: {e}"))?;
            // WANTNUKEWARNING leaves any permanent-delete question for the
            // user; no NOCONFIRMATION/NO_UI/YesToAll flag is ever set.
            operation.SetOperationFlags(FOFX_RECYCLEONDELETE | FOF_WANTNUKEWARNING | FOFX_EARLYFAILURE)
                .map_err(|e| format!("cannot set recycle-only operation flags: {e}"))?;
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
                .map_err(|e| format!("cannot resolve the session folder for recycling: {e}"))?;
            operation.DeleteItem(&item, &sink).map_err(|e| format!("cannot queue session recycle: {e}"))?;
            let performed = operation.PerformOperations().map_err(|e| format!("Windows recycle operation failed: {e}"));
            let aborted = operation.GetAnyOperationsAborted().map_err(|e| format!("cannot read Windows recycle cancellation state: {e}"))?.as_bool();
            let receipt = receipt.lock().map_err(|e| format!("recycle receipt lock: {e}"))?.clone();
            let source_exists = dir.try_exists().map_err(|e| format!("cannot verify the source directory after recycling: {e}"))?;
            super::verify_recycle_receipt(performed, aborted, &receipt, source_exists)
        }
    }
}

/// A dedicated short-lived STA owns all Shell objects and releases them before
/// CoUninitialize. No COM objects cross the thread boundary.
#[cfg(windows)]
fn recycle_directory(dir: &Path) -> Result<i32, String> {
    let dir = dir.to_path_buf();
    std::thread::spawn(move || {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok()
            .map_err(|e| format!("cannot initialize the recycle STA: {e}"))?;
        let result = windows_recycle::recycle(&dir);
        unsafe { CoUninitialize() };
        result
    }).join().map_err(|_| "the recycle STA thread failed".to_string())?
}

#[cfg(not(windows))]
fn recycle_directory(_dir: &Path) -> Result<i32, String> {
    Err("moving a session folder to the recycle bin is only supported on Windows".to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(label: &str) -> Input {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-sandbox");
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = base.join(format!("{label}-{}-{stamp}", std::process::id())).join("sessions");
        assert!(root.is_absolute() && root.starts_with(&base));
        let session = "合成会话".to_string();
        let directory = root.join("2026").join(&session);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("session.jsonl"), b"synthetic helper validation fixture").unwrap();
        Input { root, session, directory }
    }

    #[test]
    fn arguments_are_exact_and_complete() {
        let parsed = parse_args(["--directory", "C:/sessions/id", "--session", "id", "--root", "C:/sessions"].map(OsString::from)).unwrap();
        assert_eq!(parsed.session, "id");
        assert_eq!(parsed.directory, PathBuf::from("C:/sessions/id"));
        assert!(parse_args(Vec::<OsString>::new()).is_err());
        assert!(parse_args(["--root"].map(OsString::from)).is_err());
        assert!(parse_args(["--unknown", "x"].map(OsString::from)).is_err());
        assert!(parse_args(["--root", "a", "--root", "b"].map(OsString::from)).is_err());
        let (value, code) = run(Vec::<OsString>::new());
        assert_ne!(code, 0);
        assert_eq!(value["status"], "failed");
        assert_eq!(value["sourceGone"], false);
    }

    #[test]
    fn input_boundary_accepts_only_the_actual_named_session_under_root() {
        let mut input = fixture("boundary");
        assert!(validate_input(&input).is_ok());
        input.session = "other-session".to_string();
        assert!(validate_input(&input).unwrap_err().contains("basename"));
        input.session = "../escape".to_string();
        assert!(validate_input(&input).is_err());
        input.session = "合成会话".to_string();
        let actual = input.directory.clone();
        input.root = PathBuf::from("relative-root");
        assert!(validate_input(&input).unwrap_err().contains("absolute"));
        input.root = actual.parent().unwrap().parent().unwrap().to_path_buf();
        input.directory = input.root.clone();
        input.session = "sessions".to_string();
        assert!(validate_input(&input).unwrap_err().contains("strictly inside"));
        input.directory = actual.parent().unwrap().join("missing-log");
        input.session = "missing-log".to_string();
        std::fs::create_dir_all(&input.directory).unwrap();
        assert!(validate_input(&input).unwrap_err().contains("session.jsonl"));
        input.directory = actual.parent().unwrap().parent().unwrap().parent().unwrap().join("outside");
        input.session = "outside".to_string();
        std::fs::create_dir_all(&input.directory).unwrap();
        std::fs::write(input.directory.join("session.jsonl"), b"synthetic outside-root fixture").unwrap();
        assert!(validate_input(&input).unwrap_err().contains("strictly inside"));
        assert!(actual.join("session.jsonl").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn input_refuses_long_and_extended_paths_before_shell() {
        let input = Input { root: PathBuf::from("C:/sessions"), session: "x".into(), directory: PathBuf::from(format!("C:/{}", "x".repeat(270))) };
        assert!(validate_input(&input).unwrap_err().contains("long paths"));
        let input = Input { directory: PathBuf::from(r"\\?\C:\sessions\x"), ..input };
        assert!(validate_input(&input).unwrap_err().contains("extended"));
    }

    #[test]
    fn only_successful_non_aborted_delete_receipts_with_source_gone_pass() {
        let receipt = RecycleReceipt { delete_result: Some((0x00270008, true)) };
        assert_eq!(verify_recycle_receipt(Ok(()), false, &receipt, false).unwrap(), 0x00270008);
        assert!(verify_recycle_receipt(Err("perform failed".into()), false, &receipt, false).is_err());
        assert!(verify_recycle_receipt(Ok(()), true, &receipt, false).is_err());
        assert!(verify_recycle_receipt(Ok(()), false, &RecycleReceipt::default(), false).is_err());
        assert!(verify_recycle_receipt(Ok(()), false, &RecycleReceipt { delete_result: Some((-1, true)) }, false).is_err());
        assert!(verify_recycle_receipt(Ok(()), false, &RecycleReceipt { delete_result: Some((0, false)) }, false).is_err());
        assert!(verify_recycle_receipt(Ok(()), false, &receipt, true).is_err());
    }
}
