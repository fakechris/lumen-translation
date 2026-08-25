//! Live-subtitle chain diagnostic. Exercises the exact start path the tray
//! toggle uses, with every step narrated to stderr:
//!
//!   cargo run --example caption_diag [-- <bundle-id> [<seconds>]]
//!
//! With no argument, taps the current frontmost app. Default window 8 s.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() {
    // When launched via LaunchServices (`open`), stderr goes nowhere: re-exec
    // ourselves with stdout+stderr redirected to /tmp/caption_diag.log.
    if std::env::var_os("LUMEN_DIAG_REDIRECTED").is_none() {
        let exe = std::env::current_exe().ok();
        if let Some(exe) = exe {
            if let Ok(log) = std::fs::File::create("/tmp/caption_diag.log") {
                let spawned = std::process::Command::new(&exe)
                    .args(std::env::args_os().skip(1))
                    .env("LUMEN_DIAG_REDIRECTED", "1")
                    .stdout(
                        log.try_clone()
                            .map(std::process::Stdio::from)
                            .unwrap_or(std::process::Stdio::inherit()),
                    )
                    .stderr(std::process::Stdio::from(log))
                    .spawn();
                if let Ok(mut child) = spawned {
                    let _ = child.wait();
                    return;
                }
            }
        }
    }
    eprintln!("== step 1: process-tap capability (macOS 14.2+, dlsym) ==");
    eprintln!(
        "capability_available = {}",
        lumen_platform_macos::system_audio_capability_available()
    );

    eprintln!("== step 2: frontmost app (basic probe, no AppleScript enrichment) ==");
    let frontmost = lumen_platform_macos::frontmost_app_basic();
    let Some(frontmost) = frontmost else {
        eprintln!("frontmost_app_basic -> NONE (is anything frontmost?)");
        return;
    };
    eprintln!(
        "frontmost: name={:?} bundle={:?}",
        frontmost.app_name, frontmost.bundle_id
    );

    let bundle_id = std::env::args()
        .nth(1)
        .or(frontmost.bundle_id.clone())
        .unwrap_or_default();
    if bundle_id.is_empty() {
        eprintln!("no bundle id to tap; aborting");
        return;
    }
    let seconds: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(8);

    eprintln!("== step 3: building tap target for {bundle_id} ==");
    eprintln!("-- HAL process objects visible to a tap --");
    let mut procs = lumen_platform_macos::debug_process_list();
    procs.sort_by_key(|(_, _, b)| b.clone());
    for (object, pid, b) in &procs {
        eprintln!("  hal process: object={object} pid={pid} bundle={b}");
    }
    let target = lumen_platform_macos::SystemAudioTarget::new([bundle_id.clone()]);
    eprintln!("target bundle_ids (normalized) = {:?}", target.bundle_ids());

    eprintln!("== step 4: starting capture (TCC prompt appears here if due) ==");
    let chunks = Arc::new(AtomicU64::new(0));
    let samples = Arc::new(AtomicU64::new(0));
    let peak_bits = Arc::new(AtomicU32::new(0));
    let energy = Arc::new(Mutex::new((0.0f64, 0u64)));
    let sink_chunks = Arc::clone(&chunks);
    let sink_samples = Arc::clone(&samples);
    let sink_peak_bits = Arc::clone(&peak_bits);
    let sink_energy = Arc::clone(&energy);
    let sink: lumen_platform_macos::SystemAudioSink = Arc::new(move |s: &[f32]| {
        sink_chunks.fetch_add(1, Ordering::SeqCst);
        sink_samples.fetch_add(s.len() as u64, Ordering::SeqCst);
        let peak = s.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        sink_peak_bits.fetch_max(peak.to_bits(), Ordering::SeqCst);
        if let Ok(mut total) = sink_energy.lock() {
            total.0 += s.iter().map(|v| f64::from(*v) * f64::from(*v)).sum::<f64>();
            total.1 += s.len() as u64;
        }
    });
    let mut capture = lumen_platform_macos::SystemAudioCapture::new();
    let rate = match capture.start(&target, sink) {
        Ok(rate) => rate,
        Err(err) => {
            eprintln!("capture.start FAILED: {err}");
            return;
        }
    };
    eprintln!("capture started, native sample rate = {rate}");

    eprintln!("== step 5: counting audio chunks for {seconds} s (play something now) ==");
    let mut last = (0u64, 0u64);
    for i in 1..=seconds {
        std::thread::sleep(Duration::from_secs(1));
        let c = chunks.load(Ordering::SeqCst);
        let s = samples.load(Ordering::SeqCst);
        let peak = f32::from_bits(peak_bits.swap(0, Ordering::SeqCst));
        let rms = energy
            .lock()
            .map(|mut total| {
                let rms = if total.1 == 0 {
                    0.0
                } else {
                    (total.0 / total.1 as f64).sqrt()
                };
                *total = (0.0, 0);
                rms
            })
            .unwrap_or(0.0);
        eprintln!(
            "  t+{i:>2}s: chunks={c} (+{}), samples={s} (+{}), peak={peak:.6}, rms={rms:.6}",
            c - last.0,
            s - last.1
        );
        last = (c, s);
    }
    let _ = capture.stop();

    eprintln!("== step 6: streaming Paraformer model readiness ==");
    let dir = lumen_models::default_paraformer_streaming_dir();
    eprintln!(
        "dir = {} ready = {}",
        dir.display(),
        lumen_models::paraformer_streaming_ready(&dir)
    );
    eprintln!("done");
}
