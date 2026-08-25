//! Non-interactive replay diagnostic for the live-caption recognizer path.
//!
//! Feeds a local PCM s16le WAV through the same chunked resample/decode loop
//! as `caption.rs`. It never opens an audio device, Tauri window, or network.
//!
//! Usage:
//!   cargo run --example caption_replay -- /path/to/audio.wav

use lumen_asr_engine::{decode_wav_pcm_s16le, StreamingRecognizer};

const TARGET_RATE: u32 = 16_000;
const CAPTURE_CHUNK: usize = 512;
const CALLBACKS_PER_POLL: usize = 5;

fn main() {
    let path = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .expect("pass a PCM s16le WAV path");
    let wav = std::fs::read(&path).expect("read WAV");
    let decoded = decode_wav_pcm_s16le(&wav).expect("decode WAV");
    let model_dir = lumen_models::default_paraformer_streaming_dir();
    let recognizer = StreamingRecognizer::from_dir(&model_dir).expect("load streaming model");
    let mut stream = recognizer.new_stream();
    let mut previous = String::new();
    let mut updates = 0usize;

    for callback_batch in decoded.samples.chunks(CAPTURE_CHUNK * CALLBACKS_PER_POLL) {
        for callback in callback_batch.chunks(CAPTURE_CHUNK) {
            let samples = if decoded.sample_rate == TARGET_RATE {
                callback.to_vec()
            } else {
                lumen_asr_engine::resample_linear(callback, decoded.sample_rate, TARGET_RATE)
            };
            stream.accept_waveform(&samples, TARGET_RATE);
        }
        stream.decode();
        let result = stream.result().text;
        if !result.trim().is_empty() && result != previous {
            updates += 1;
            println!("update {updates}: {result}");
            previous = result;
        }
        if stream.is_endpoint() {
            stream.reset();
            previous.clear();
        }
    }

    stream.input_finished();
    stream.decode();
    let final_text = stream.result().text;
    if !final_text.trim().is_empty() && final_text != previous {
        updates += 1;
        println!("update {updates}: {final_text}");
    }
    println!(
        "summary: samples={} sample_rate={} updates={updates}",
        decoded.samples.len(),
        decoded.sample_rate,
    );
}
