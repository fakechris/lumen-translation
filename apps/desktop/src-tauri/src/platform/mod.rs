//! Platform layer.
//!
//! Windows is the target this app exists for, but every entry point here has a
//! no-op stub for other operating systems so `cargo test`, `cargo clippy` and
//! editor tooling keep working on a macOS or Linux workstation. The stubs are
//! deliberately fail-closed: they report "no selection" and "no secret store"
//! rather than pretending to work.

// On a non-Windows host most of this module is unreachable by design — the
// stubs exist so the crate compiles, not so they can be called — and the
// selection types have no consumer. Warning about that on every dev build
// would train people to ignore warnings.
#![cfg_attr(not(target_os = "windows"), allow(dead_code, unused_imports))]

mod types;
pub use types::*;

#[cfg(target_os = "windows")]
#[path = "win/mod.rs"]
mod imp;

#[cfg(not(target_os = "windows"))]
#[path = "stub.rs"]
mod imp;

// `clipboard` is deliberately not re-exported: it is how `selection` implements
// its Ctrl+C fallback, not something the app above this layer should reach for.
pub use imp::{secret, selection, window_ext};
