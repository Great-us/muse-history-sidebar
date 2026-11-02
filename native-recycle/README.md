# Muse history native recycle helper

Standalone Windows Rust helper, adapted from the MIT-licensed Muse Desktop implementation. See LICENSE for Etienne Lescot's attribution. No Tauri or engine dependencies.

Build with `powershell -File scripts/build-native-recycle.ps1` from the companion root, after configuring the Rust toolchain. `-Offline` uses only cached dependencies; `-TargetDir <path>` can share a local Cargo cache. The locked build copies the release executable into `bin/muse-history-recycle.exe`.

Invoke directly, never through shell command interpolation:

```
muse-history-recycle.exe --root <absolute sessions root> --session <id> --directory <absolute session dir>
```

Stdout is exactly one JSON object. Exit zero means a successful non-aborted PostDeleteItem with a non-null recycle item, and the source is gone. It reports `status`, `sourceGone`, `deleteHresult`, `hasRecycleItem`. Nonzero exit reports `status: failed`, `sourceGone`, and `message`. The backend must then cold-verify official list/read absence before declaring its full operation recycled.

Inputs require absolute supported paths, matching directory basename/ID, strict canonical containment below root, and actual non-reparse session directory/log. Root removal, escapes and long/extended/device paths are rejected. Recycling uses the existing IFileOperation STA implementation; it never falls back to permanent deletion or manipulates private Recycle Bin files, and never automatically confirms permanent deletion.

Run Rust unit tests with `cargo test --manifest-path native-recycle/Cargo.toml --locked`. Run executable protocol tests with `node --test test/native-protocol.mjs`. The one real synthetic non-ASCII recycle requires `MUSE_NATIVE_RECYCLE_TEST=1` and normal Windows permissions; it logs the exact original path for Explorer restoration. All fixtures stay under native-recycle/test-sandbox; tests never access actual user histories or empty the Recycle Bin.
