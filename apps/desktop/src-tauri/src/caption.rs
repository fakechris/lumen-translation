//! Spike 1 live-subtitle pipeline (macOS): tap the frontmost app's audio →
//! streaming Paraformer → `caption-partial` / `caption-final` Tauri events.
//!
//! Architecture mirrors lumen-asr's proven meeting-live wiring: the sherpa C
//! objects are not internally synchronized, so one dedicated `std::thread`
//! owns the recognizer AND its single stream, created inside the thread. The
//! tap sink runs on a Core Audio dispatch queue and only pushes into a bounded
//! channel — all decoding happens on the worker thread.
//!
//! Spike scope (deliberately minimal): finals + partials of the original
//! language only — no translation step, no sentence-chunking polish, no
//! music/VAD gating. Those land in Spike 2.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The streaming Paraformer model's expected input rate; the tap delivers at
/// its native rate and chunks are linearly resampled to this.
const TARGET_RATE: u32 = 16_000;

/// Bound of the tap → worker audio queue. ~10 s of mono 48 kHz float audio —
/// generous headroom; when full, the sink drops the chunk (captions lag
/// momentarily rather than memory growing without bound).
const AUDIO_QUEUE_CAPACITY: usize = 480;

const IDLE_POLL: Duration = Duration::from_millis(50);

/// Payload of the `caption-partial` / `caption-final` events. `revision` is
/// monotonic so the overlay can drop out-of-order deliveries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionEvent {
    pub revision: u64,
    /// Tapped app display name, so the overlay can show what it is hearing.
    pub app_name: String,
    pub text: String,
    pub is_final: bool,
}

/// Owns the running spike session. Cross-platform and `Send + Sync`; every
/// field is only touched while holding the AppState lock.
pub struct CaptionSession {
    inner: Mutex<Option<Worker>>,
}

struct Worker {
    stop: Arc<AtomicBool>,
    capture: Arc<Mutex<lumen_platform_macos::SystemAudioCapture>>,
    handle: JoinHandle<()>,
}

impl Default for CaptionSession {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl CaptionSession {
    pub fn is_running(&self) -> bool {
        self.inner.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn start(&self, app: AppHandle, bundle_id: String, app_name: String) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        // Defensive: reap any stopped-but-unjoined worker first.
        if let Some(mut worker) = guard.take() {
            worker.stop.store(true, Ordering::SeqCst);
            if let Ok(mut capture) = worker.capture.lock() {
                let _ = capture.stop();
            }
            let _ = worker.handle.join();
        }

        let streaming_dir = streaming_dir_if_ready().ok_or_else(|| {
            format!(
                "streaming Paraformer model not found under {} — install it via Lumen ASR's model settings, then retry",
                default_streaming_dir().display()
            )
        })?;

        let (tx, rx) = std::sync::mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
        let sink: lumen_platform_macos::SystemAudioSink = Arc::new(move |samples: &[f32]| {
            // Drop-on-full is the designed backpressure: a momentarily lagging
            // caption beats unbounded memory when the model stalls.
            match tx.try_send(samples.to_vec()) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
            }
        });

        let target = lumen_platform_macos::SystemAudioTarget::new([bundle_id]);
        if target.is_empty() {
            return Err("no valid system-audio target".into());
        }

        let capture = Arc::new(Mutex::new(lumen_platform_macos::SystemAudioCapture::new()));
        let capture_rate = {
            let mut c = capture.lock().map_err(|e| e.to_string())?;
            c.start(&target, sink).map_err(|e| e.to_string())?
        };

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker_app = app_name.clone();
        let handle = std::thread::Builder::new()
            .name("lumen-caption".into())
            .spawn(move || {
                run_worker(app, streaming_dir, worker_app, capture_rate, rx, worker_stop);
            })
            .map_err(|e| e.to_string())?;

        *guard = Some(Worker {
            stop,
            capture,
            handle,
        });
        Ok(())
    }

    pub fn stop(&self) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        if let Some(worker) = guard.take() {
            worker.stop.store(true, Ordering::SeqCst);
            // Stopping the tap first ends the sink callbacks; the worker then
            // drains what is left, flushes its trailing context, and exits.
            if let Ok(mut capture) = worker.capture.lock() {
                let _ = capture.stop();
            }
            let _ = worker.handle.join();
        }
    }
}

fn run_worker(
    app: AppHandle,
    streaming_dir: PathBuf,
    app_name: String,
    capture_rate: u32,
    rx: std::sync::mpsc::Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
) {
    let recognizer = match lumen_asr_engine::StreamingRecognizer::from_dir(&streaming_dir) {
        Ok(r) => r,
        Err(e) => {
            log::error!("caption worker: could not load streaming Paraformer: {e}");
            let _ = app.emit(
                "caption-error",
                format!("could not load streaming model: {e}"),
            );
            return;
        }
    };
    let mut stream = recognizer.new_stream();
    let mut revision: u64 = 0;
    let mut last_partial = String::new();

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let mut got_audio = false;
        loop {
            match rx.try_recv() {
                Ok(chunk) => {
                    got_audio = true;
                    let samples = if capture_rate == TARGET_RATE {
                        chunk
                    } else {
                        lumen_asr_engine::audio::resample_linear(&chunk, capture_rate, TARGET_RATE)
                    };
                    stream.accept_waveform(&samples, TARGET_RATE);
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
            }
        }
        if !got_audio {
            std::thread::sleep(IDLE_POLL);
            continue;
        }
        stream.decode();
        revision += 1;
        if stream.is_endpoint() {
            let text = stream.result().text;
            if !text.trim().is_empty() {
                let _ = app.emit(
                    "caption-final",
                    CaptionEvent {
                        revision,
                        app_name: app_name.clone(),
                        text,
                        is_final: true,
                    },
                );
            }
            stream.reset();
            last_partial.clear();
        } else {
            let text = stream.result().text;
            if text != last_partial && !text.trim().is_empty() {
                let _ = app.emit(
                    "caption-partial",
                    CaptionEvent {
                        revision,
                        app_name: app_name.clone(),
                        text: text.clone(),
                        is_final: false,
                    },
                );
                last_partial = text;
            }
        }
    }

    // Flush trailing context so the last utterance is not lost mid-word.
    stream.input_finished();
    stream.decode();
    let text = stream.result().text;
    if !text.trim().is_empty() {
        let _ = app.emit(
            "caption-final",
            CaptionEvent {
                revision: revision + 1,
                app_name,
                text,
                is_final: true,
            },
        );
    }
}

/// Streaming Paraformer dir iff macOS + model installed. `None` everywhere
/// else — the caller surfaces "not ready" instead of failing at runtime.
fn streaming_dir_if_ready() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let dir = default_streaming_dir();
    lumen_models::paraformer_streaming_ready(&dir).then_some(dir)
}

fn default_streaming_dir() -> PathBuf {
    lumen_models::default_paraformer_streaming_dir()
}
