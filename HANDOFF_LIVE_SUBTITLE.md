# Handoff: lumen-translation live-subtitle silent tap investigation

**Date**: 2026-08-23
**Goal**: Make clicking 「实时字幕」in lumen-translation's tray produce bilingual captions from the frontmost app's audio (e.g. Comet playing a video).

---

## 1. Architecture

The live-subtitle feature lives in **lumen-translation** (`apps/desktop/src-tauri/`), not lumen-asr:

- Tray menu 「实时字幕」→ Tauri command `live_subtitle_start` → `live_subtitle_start_mac`
- `live_subtitle_start_mac` reads frontmost app bundle ID, then calls `CaptionSession::start()`
- `CaptionSession::start()` (in `caption.rs`) creates a `SystemAudioCapture`, calls `capture.start(&target, sink)`, spawns a worker thread that feeds audio chunks to a streaming Paraformer ASR model, then optionally refines with MLX Whisper
- `SystemAudioCapture` and `SystemAudioTarget` come from `lumen_platform_macos` (a git dependency on lumen-suite)
- Inside lumen-suite, `SystemAudioCapture::start()` → `TapSession::start()` which:
  1. Builds a `CATapDescription` (mono mixdown of matched HAL processes)
  2. Calls `AudioHardwareCreateProcessTap` (macOS 14.2+ SPI)
  3. Creates a private aggregate device containing the tap
  4. Creates an IO proc via `AudioDeviceCreateIOProcIDWithBlock`
  5. Calls `AudioDeviceStart`
  6. The IO proc block receives `AudioBufferList` on each cycle and forwards samples to the sink

**lumen-asr's meeting mode uses the exact same code path**: `MeetingSystemAudio::start()` in `apps/desktop/src-tauri/src/meeting_system_audio.rs` (line 56-68) creates a `SystemAudioCapture`, calls `capture.start(&target, sink)`, and writes to a WAV file. Confirmed by reading the source.

---

## 2. The symptom

Clicking 「实时字幕」while Comet plays audio:

- Caption overlay appears, shows "starting…", then nothing
- No error is reported anywhere
- No audio chunks are delivered to the ASR model

---

## 3. Confirmed facts (with evidence)

### 3.1 TCC permission is granted

**Evidence**: From inside the signed Tauri app, `tcc_audio_capture_status()` returned 0.

Log line from `/tmp/lumen-translation.log`:

```
[18:53:28] TCC kTCCServiceAudioCapture preflight = 0 (0=granted 1=denied 2=unknown -2=unavailable)
```

The `tcc_audio_capture_status()` function calls `TCCAccessPreflight` for `kTCCServiceAudioCapture` via the private TCC framework (dlopen). This was called from within the signed app process, so the result reflects this bundle's actual TCC state.

### 3.2 The correct process is being tapped and is producing audio output

**Evidence**: A standalone Swift diagnostic (`/tmp/whoplays.swift`) queried `kAudioProcessPropertyIsRunningOutput` ('piro') for every HAL process object while Comet was playing audio:

```
obj    pid     runOut runIn bundle / executable
211    1087    1      0     ai.perplexity.comet.helper
219    8546    1      0     com.apple.WebKit.GPU
223    8843    0      1     com.apple.CoreSpeech
```

Only obj=211 (`ai.perplexity.comet.helper`, pid=1087) is producing audio output among Comet-related processes.

The app's own HAL process enumeration (from `/tmp/lumen-translation.log`) confirms obj=211 is matched as a tap target:

```
[18:35:50] HAL process obj=211 pid=1087 bundle=ai.perplexity.comet.helper  <== candidate
[18:35:50] HAL process obj=212 pid=1086 bundle=ai.perplexity.comet.helper  <== candidate
[18:35:50] HAL process obj=225 pid=533 bundle=ai.perplexity.comet  <== candidate
```

The `matching_process_objects()` function normalizes `ai.perplexity.comet.helper` → `ai.perplexity.comet` (via `.helper` suffix stripping in `normalize_bundle_id()`), and the target is `["ai.perplexity.comet"]`. All three Comet processes are matched.

### 3.3 The entire tap chain returns noErr

**Evidence**: `/tmp/lumen-translation.log` shows:

```
[18:53:28] live_subtitle_start_mac: caption started OK
```

`caption started OK` is printed only after `CaptionSession::start()` returns `Ok(())`, which requires `SystemAudioCapture::start()` (synchronous, propagates errors) to return `Ok(sample_rate)`. This means:

- `AudioHardwareCreateProcessTap` → noErr (tap ID ≠ 0)
- `tap_stream_format` → valid Float32 format
- `AudioHardwareCreateAggregateDevice` → noErr (aggregate ID ≠ 0)
- `AudioDeviceCreateIOProcIDWithBlock` → noErr (proc_id ≠ null)
- `AudioDeviceStart` → noErr

### 3.4 The IO proc is never called; the aggregate device is not running

**Evidence**: Instrumentation added to lumen-suite commit `2bfe36f` writes to `/tmp/lumen-tap.log`:

```
started: targets=["ai.perplexity.comet"] tap=249 aggregate=250 rate=48000 tap_channels=1 agg_input_channels=1 agg_is_running=0
after 3s: agg_is_running=0 agg_input_channels=1 io_proc_calls=0
```

- `agg_input_channels=1`: The tap IS contributing one input channel to the aggregate. The wiring is correct.
- `agg_is_running=0`: `kAudioDevicePropertyDeviceIsRunning` ('goin') returns 0 both immediately after `AudioDeviceStart` and 3 seconds later. The HAL is not running IO cycles on this device.
- `io_proc_calls=0`: The IO proc block has been invoked zero times.

### 3.5 Entitlements were missing from lumen-translation but are now present

**Evidence** (before fix): `codesign -d --entitlements - --xml` on the old build returned empty (no entitlements at all).

**Evidence** (after fix): Current installed app has:

```
com.apple.security.automation.apple-events → true
com.apple.security.cs.allow-jit → true
com.apple.security.cs.allow-unsigned-executable-memory → true
com.apple.security.cs.disable-library-validation → true
com.apple.security.device.audio-input → true
```

Both `Lumen ASR.app` and `Lumen Translation.app` now have identical entitlements sets, both signed with "Lumen Local Codesign", both with `flags=0x0(none)` (no hardened runtime).

### 3.6 The audio capture code path is identical between lumen-asr's working rev and the current rev

**Evidence**: `git diff 64f970d 8c6285e -- crates/lumen-platform-macos/src/system_audio.rs` shows the only changes in the audio path (TapSession::start, build_tap_description, matching_process_objects, aggregate creation, IO proc) are:

1. Addition of `PERM_ERR` (-84) check after `create_tap` — an error-handling addition, does not change the success path
2. Addition of `PermissionDenied` error variant — unused on the success path
3. Addition of `tcc_audio_capture_status()`, `tcc_request_audio_capture()`, `debug_process_list()` — diagnostic functions, not called in the audio path

The `matching_process_objects` function is **byte-for-byte identical** between the two revs (confirmed by `git show` on both).

The aggregate device description at `8c6285e` is tap-only (no `subdevices`, no `master`, no `stacked`, no `drift` on tap entry) — identical to `64f970d`.

### 3.7 lumen-asr meeting mode successfully records Comet's system audio

**Evidence**: User reported: "我刚才试了一下现在跑的lumen asr，会议模式，马上就录制识别了comet的播放了！！！" and later "会议的确清晰的录制了音轨，没人mic说话！！！！" (the meeting clearly recorded the audio track, nobody spoke into the mic).

lumen-asr is pinned to suite rev `64f970d` (confirmed in `Cargo.toml`). The installed `Lumen ASR.app` is signed with "Lumen Local Codesign" and has `com.apple.security.device.audio-input`.

`MeetingSystemAudio::start()` in `apps/desktop/src-tauri/src/meeting_system_audio.rs` uses `SystemAudioCapture::new()` → `capture.start(&target, sink)` — the exact same lumen-suite code path.

### 3.8 lumen-asr's process is in the HAL list during translation tests

**Evidence**: From the HAL process list in `/tmp/lumen-translation.log`:

```
[18:35:50] HAL process obj=241 pid=34685 bundle=com.lumenopen.asr
```

lumen-asr was running (pid=34685) when the translation live-subtitle test was conducted. Its HAL process object is visible.

---

## 4. The core contradiction

The same `SystemAudioCapture::start()` → `TapSession::start()` code path (verified identical by git diff) works in lumen-asr but not in lumen-translation. In lumen-translation, the aggregate device is created successfully, the tap contributes one input channel, but `DeviceIsRunning` stays 0 and the IO proc never fires.

Both apps now have:

- Same codesign authority ("Lumen Local Codesign")
- Same `flags=0x0` (no hardened runtime)
- Same entitlements (including `com.apple.security.device.audio-input`)
- Same suite audio code (verified by diff)

The difference must be in something not yet examined.

---

## 5. What was ruled out (with evidence)

| Hypothesis                                         | Evidence against                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TCC not granted                                    | Preflight = 0 from inside the signed app (§3.1)                                                                                                                                                  |
| Wrong process tapped                               | Swift diagnostic shows obj=211 comet.helper has `IsRunningOutput=1` and is matched (§3.2)                                                                                                        |
| CoreAudio API calls failing                        | All return noErr; "caption started OK" (§3.3)                                                                                                                                                    |
| Missing entitlements                               | Fixed; confirmed present via codesign (§3.5); still didn't fix the issue                                                                                                                         |
| Code regression in suite audio path                | Git diff shows audio path identical between `64f970d` and `8c6285e` (§3.6)                                                                                                                       |
| Aggregate needs hardware clock (subdevices+master) | Tested with `5973241` (had subdevices+master) — still 0 chunks. BUT: that test was BEFORE entitlements were added, so this is inconclusive.                                                      |
| Aggregate should be tap-only                       | Tested with `8c6285e` (tap-only) WITH entitlements — `agg_is_running=0`, `io_proc_calls=0` (§3.4). BUT: lumen-asr uses tap-only at `64f970d` and it works, so tap-only is not inherently broken. |

---

## 6. Unexplored hypotheses (NOT yet tested — labeled clearly)

### 6.1 lumen-asr is concurrently holding a tap on the same processes

**Status**: UNTESTED. This is the strongest unexplored hypothesis.

**Reasoning**: The HAL process list shows `com.lumenopen.asr` (obj=241, pid=34685) was running when translation was tested (§3.8). If lumen-asr had an active meeting recording (or its tap was not fully torn down), macOS might only deliver audio to the first tap and silently ignore the second. The user tested lumen-asr first ("我刚才试了一下现在跑的lumen asr"), then tested translation — lumen-asr may have still been holding a tap.

**Test**: Quit lumen-asr completely (`pkill -f "Lumen ASR"`), verify no `com.lumenopen.asr` process remains, then test translation's live subtitle.

### 6.2 TCC database staleness from pre-entitlement grant

**Status**: UNTESTED.

**Reasoning**: lumen-translation was granted `kTCCServiceAudioCapture` TCC permission BEFORE entitlements were added (the TCC prompt appeared and was approved in an earlier build that had no entitlements). macOS might cache a "granted but unentitled" state that passes preflight (returns 0) but blocks actual audio delivery at a different enforcement layer. The entitlements were added later, but the TCC database entry might not have been invalidated.

**Test**: `tccutil reset AudioCapture app.lumen.translation`, then re-launch the app, click 「实时字幕」, and re-approve the TCC prompt.

### 6.3 The `2bfe36f` instrumentation changes behavior

**Status**: UNTESTED but unlikely.

**Reasoning**: The instrumentation adds `Arc<AtomicU64>` and file IO to the IO proc closure. `RcBlock` should handle the captured variables correctly, but it's a variable that was not present in the `64f970d` code that lumen-asr uses.

**Test**: Revert the instrumentation, rebuild at a clean tap-only config, and test.

### 6.4 The three Comet processes (main + 2 helpers) all being included causes a problem

**Status**: UNTESTED.

**Reasoning**: The tap includes obj=211 (helper, `IsRunningOutput=1`), obj=212 (helper, `IsRunningOutput` not checked but likely 0), and obj=225 (main app, likely `IsRunningOutput=0`). Including non-audio-producing processes in the tap might cause the HAL to not run IO cycles. lumen-asr might only pass specific bundle IDs that result in fewer matched processes.

**Test**: Check what bundle IDs lumen-asr passes when recording Comet. If it only matches helpers, try filtering to only include processes with `IsRunningOutput=1`.

### 6.5 macOS version-specific tap-only aggregate behavior

**Status**: UNTESTED.

**Reasoning**: User is on macOS 23.6.0 (Sonoma 14.6). There might be a behavior where tap-only aggregates need a hardware clock on this specific version. But this would contradict the fact that lumen-asr works on the same machine with the same OS — unless the difference is the concurrent tap (§6.1).

**Test**: N/A if §6.1 resolves the issue.

---

## 7. Current repository state

### lumen-suite (`/Users/chris/source/lumen-translation/../lumen-suite`)

**HEAD**: `2bfe36f` — "chore(macos): temporary IO-proc instrumentation for the silent tap"

**Uncommitted changes**: `crates/lumen-platform-macos/src/system_audio.rs` has uncommitted edits that re-add `default_output_device_uid()` and the master+subdevices aggregate config. These were being edited when the user interrupted. They are **incomplete and untested** — do not assume they compile or work.

**Commit history (newest first)**:

- `2bfe36f` — temporary IO-proc instrumentation (writes to `/tmp/lumen-tap.log`)
- `8c6285e` — revert to tap-only aggregate (matches `64f970d`)
- `5973241` — change aggregate key from "main" to "master" (with subdevices)
- `0959fa6` — set stacked=false
- `b6833a8` — set muteBehavior=unmuted, isPrivate
- `f0765fc` — remove TCC preflight, check permErr
- `79efe58` — always try TCCAccessRequest
- `7ece20c` — wire TCC preflight+request into TapSession::start
- `ff0ac44` — debug_process_list
- `3f8f3de` — add default output as main sub-device (THE REGRESSION — but see §5, this is inconclusive)
- `64f970d` — **the rev lumen-asr uses, known to work**

### lumen-translation (`/Users/chris/source/lumen-translation`)

**HEAD**: `88d3898` — "fix(desktop): live-subtitle start no longer blocks on browser AppleScript"

**Uncommitted changes**:

- `apps/desktop/src-tauri/Cargo.toml` — suite rev bumped to `2bfe36f`
- `apps/desktop/src-tauri/Cargo.lock` — updated
- `apps/desktop/src-tauri/src/caption.rs` — chunk counter logging to `/tmp/lumen-translation.log`
- `apps/desktop/src-tauri/src/lib.rs` — `diag_log()` helper, TCC preflight + HAL process list diagnostics
- `apps/desktop/src/caption.tsx` — `has-error` class binding
- `apps/desktop/src/styles.css` — `.caption-overlay` dark background, `.has-error` variant
- `scripts/macos/dev-install.sh` — added `--entitlements` flag + `ENTITLEMENTS` variable
- `scripts/macos/entitlements.dev.plist` — new file (untracked), mirrors lumen-asr's

**Installed app**: `/Applications/Lumen Translation.app` at suite rev `2bfe36f`, signed with "Lumen Local Codesign" + entitlements.

### lumen-asr (`/Users/chris/source/lumen-asr`)

**HEAD**: `3155fe1`
**Suite rev**: `64f970d` (known working)
**Installed app**: `/Applications/Lumen ASR.app`, signed with "Lumen Local Codesign" + entitlements.

---

## 8. Key files

| File                                                 | Repo              | Purpose                                                                                                        |
| ---------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `crates/lumen-platform-macos/src/system_audio.rs`    | lumen-suite       | The entire tap/aggregate/IO-proc implementation. `TapSession::start()` is the core.                            |
| `apps/desktop/src-tauri/src/caption.rs`              | lumen-translation | `CaptionSession::start()`, sink closure, ASR worker thread                                                     |
| `apps/desktop/src-tauri/src/lib.rs`                  | lumen-translation | `live_subtitle_start`, `live_subtitle_start_mac`, `diag_log()`, `show_caption_window()`                        |
| `apps/desktop/src-tauri/src/meeting_system_audio.rs` | lumen-asr         | `MeetingSystemAudio::start()` — proves lumen-asr uses the same `SystemAudioCapture`                            |
| `apps/desktop/src-tauri/src/meeting_cmd.rs`          | lumen-asr         | Meeting recording orchestration, calls `meeting_system_audio.start()`                                          |
| `scripts/macos/dev-install.sh`                       | lumen-translation | Standard build: `pnpm build` → `pnpm tauri build --bundles app` → codesign (now with --entitlements) → install |
| `scripts/macos/entitlements.dev.plist`               | lumen-translation | New entitlements file mirroring lumen-asr's                                                                    |
| `scripts/macos/entitlements.dev.plist`               | lumen-asr         | Reference entitlements (has `com.apple.security.device.audio-input`)                                           |
| `scripts/macos/sign-app.sh`                          | lumen-asr         | Reference signing script (uses `--entitlements`)                                                               |

---

## 9. Diagnostic tools available

| Tool                         | Location                                          | Notes                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/tmp/whoplays.swift`        | tmp                                               | Swift script: lists all HAL processes with `IsRunningOutput`/`IsRunningInput`. Does NOT need TCC or entitlements. Run: `swift /tmp/whoplays.swift`                                   |
| `/tmp/lumen-tap.log`         | tmp                                               | Written by suite instrumentation (commit `2bfe36f`): records IO proc invocations, aggregate DeviceIsRunning, input channel count                                                     |
| `/tmp/lumen-translation.log` | tmp                                               | Written by translation app: `diag_log()` records startup steps, TCC preflight, HAL process list, chunk counter                                                                       |
| `caption_diag`               | `apps/desktop/src-tauri/examples/caption_diag.rs` | Untracked diagnostic binary. WARNING: it is unsigned, so it does NOT have TCC permission — its tap results are unreliable. Only trust its process enumeration, not its chunk counts. |

---

## 10. Recommended next steps (in priority order)

### E2E safety boundary

Do not automate Comet/Safari, switch the frontmost application or Space, play
audio, or launch the installed app as part of routine E2E. Those actions seize
the user's desktop and make the test environment unsafe for normal work.

Use the caption document's deterministic fixture instead:

```bash
pnpm --filter @lumen/desktop dev
# In a separate, headless browser process:
chromium --headless --disable-gpu \
  --window-size=1240,280 \
  --screenshot=/private/tmp/lumen-caption.png \
  'http://127.0.0.1:1421/caption.html?fixture=continuous'
```

The fixture renders the production caption component and CSS but does not
start Tauri, load settings or credentials, call a provider, capture audio, or
touch a user's browser session. Tests requiring real system audio or Space
switching are manual, opt-in tests and must not be run without the user's
explicit permission immediately before the test.

### Step 1: Test the concurrent-tap hypothesis (§6.1)

This is the highest-priority, easiest-to-test hypothesis.

```bash
pkill -f "Lumen ASR"
sleep 2
# Verify lumen-asr is gone
ps aux | grep -i "lumen.*asr" | grep -v grep
# Should return nothing

rm -f /tmp/lumen-translation.log /tmp/lumen-tap.log
open "/Applications/Lumen Translation.app"
```

Then: play audio in Comet → switch to Comet → click 「实时字幕」→ wait 5 seconds → check logs.

If this fixes it: the root cause was a concurrent tap conflict. The fix is either documentation (quit the other app) or code (detect and report the conflict).

### Step 2: If Step 1 doesn't fix it, reset TCC (§6.2)

```bash
tccutil reset AudioCapture app.lumen.translation
```

Then re-launch the app, click 「实时字幕」, approve the fresh TCC prompt, and test again.

### Step 3: If Steps 1-2 don't fix it, try master+subdevices WITH entitlements (§5)

The master+subdevices config was only tested WITHOUT entitlements (commit `5973241`, before the entitlements fix). It was never tested WITH entitlements. The uncommitted changes in lumen-suite already re-add this config — clean them up, compile, commit, bump translation's rev, rebuild, and test.

**Note**: This contradicts the tap-only config that lumen-asr uses successfully. If this works, it means the aggregate configuration IS app-specific (perhaps due to the concurrent tap or TCC state), and lumen-asr and lumen-translation need different configs. This would be unusual but not impossible.

### Step 4: If none of the above work, remove instrumentation and test at `64f970d` exactly

Revert lumen-suite to `64f970d` (the exact rev lumen-asr uses), bump translation's suite rev to `64f970d`, rebuild, and test. This eliminates all suite-side variables. If it still doesn't work, the problem is 100% in lumen-translation's app layer (not the suite).

### Step 5: Binary search the app-layer differences

If Step 4 confirms the problem is in lumen-translation's app layer, compare:

- Tauri configuration (`tauri.conf.json`) between the two apps
- Info.plist contents (especially `NSAudioCaptureUsageDescription`)
- Build configuration and compiler flags
- Runtime initialization order (does lumen-asr do something before starting the tap that lumen-translation doesn't?)

---

## 11. Cleanup needed before any PR

Regardless of the fix:

- Remove temporary suite instrumentation (`tap_diag`, `input_channel_count`, `device_is_running`, IO proc logging in `2bfe36f`)
- Remove temporary translation diagnostics (`diag_log()`, TCC preflight logging, HAL process list dump, chunk counter file logging in `caption.rs`)
- Decide whether to keep `tcc_audio_capture_status()` / `tcc_request_audio_capture()` / `debug_process_list()` in the suite (they're useful diagnostics but currently unused in the audio path)
- Keep the entitlements fix (`scripts/macos/entitlements.dev.plist` + `dev-install.sh` changes) — this is a real fix regardless
- Keep the `debug_process_list` fourcc fix (`"pid "` → `"ppid"`) if it was committed
