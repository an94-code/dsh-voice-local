# dsh-voice-local

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives you a
**fully local, offline speech stack**: it can bring up a Whisper STT server together with DSH and it
registers `voice_tts_local`, which synthesises speech through a local **GPT-SoVITS** server — voice
cloning included. No cloud service, no API key, no telemetry, nothing leaves the machine.

It deliberately does **not** modify `dsh-voice`: that plugin keeps owning edge-tts and remote/local
ASR, and upgrading or reinstalling it does not touch this one.

**Verified against: DSH `0.1.5-rc.2`** (read from
`resources/dsh-runtime/node_modules/@deepseek-ai/dsh/package.json` → `version`). Only the documented
plugin surface is used (`ctx.tools.register` and `ctx.on('dispose')`), which is why no
`peerDependencies` are declared — no DSH package is imported.

---

## 1. What it provides

| Tool | Arguments | What it does |
| --- | --- | --- |
| `voice_local_health` | — | Probes the STT health endpoint and the TTS port, and reports the configured voice, output directory and preset list. |
| `voice_local_presets` | — | Lists the named voices (`presets`) with language, emotion, reference audio and prompt text. |
| `voice_tts_local` | `text` (required), `preset`, `refAudioPath`, `promptText`, `textLang`, `output`, `play`, `format` | Synthesises through the local GPT-SoVITS server, optionally cleans up the head of the result, optionally converts to mp3, optionally plays it on the local speakers. |

Two optional start-up actions (both fire-and-forget, they never block DSH boot):

* a local Whisper server, started with your command and polled on `sttHealthUrl`;
* a local GPT-SoVITS API server, started with your command and polled on `ttsBaseUrl`.

If a service is already running, nothing is started. If a service is *not* running and no start
command is configured, the plugin logs one warning and moves on.

---

## 2. Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js** `^22.19.0 \|\| >=24.0.0` | Same range DSH itself ships. |
| **Windows** | The package declares `"os": ["win32"]`. Service start-up uses `cmd.exe /c`, playback uses Windows PowerShell's `Media.SoundPlayer`, and the path-boundary checks assume Windows path semantics. |
| A local **Whisper / faster-whisper** HTTP server | Optional. Default endpoint `http://127.0.0.1:9000/health`. The plugin only starts it and probes it; transcription itself stays with your `dsh-voice` `voice_stt` tool. |
| A local **GPT-SoVITS** API server | Required for `voice_tts_local`. Default base URL `http://127.0.0.1:9880`; the plugin calls `GET /tts`. A v2Pro-class integration package is what this was tested against. |
| **ffmpeg** | Optional, only for `format: "mp3"` (GPT-SoVITS itself emits wav/raw/ogg/aac, not mp3). Without it the wav is kept and the result says so. |
| A **reference audio clip** | Required, and yours to provide — see §4. |

GPU/CUDA is *not* a dependency of this plugin: any GPU requirement comes from the Whisper and
GPT-SoVITS installations you point it at.

---

## 3. Install / uninstall

`dsh plugin` forwards its arguments to `pnpm` inside the profile directory, so anything pnpm accepts
works:

```bash
# from a git repository
dsh plugin --profile <profile> add github:<user>/dsh-voice-local

# from a release tarball
dsh plugin --profile <profile> add https://codeload.github.com/<user>/dsh-voice-local/tar.gz/refs/tags/v1.0.0

# from a local checkout or a packed tarball
dsh plugin --profile <profile> add ./path/to/dsh-voice-local
dsh plugin --profile <profile> add ./dsh-voice-local-1.0.0.tgz
```

Then **restart DSH** — plugins are loaded at boot. A successful load logs:

```
[dsh-voice-local] 已加载：STT 随起=true｜TTS 随起=true｜预设=0｜自动播放=false｜输出目录=…
```

Uninstall the same way, then restart:

```bash
dsh plugin --profile <profile> remove dsh-voice-local
```

### Dependency on `wav-head-trim`

The head-of-utterance processing (leading-aspiration trimming, breath-head attenuation and the
adaptive window) lives in the separate zero-dependency package
[`wav-head-trim`](https://github.com/an94-code/wav-head-trim), declared here as
`"wav-head-trim": "^1.0.0"`.

> ⚠️ If `wav-head-trim` is **not published to npm** yet, a plain `pnpm add` of this plugin cannot
> resolve it. In that case install it from its repository first (or use a pnpm workspace / a
> `pnpm.overrides` entry pointing at the git URL), and make sure it is importable as the bare
> specifier `wav-head-trim`. The plugin will fail to load with a module-resolution error otherwise —
> `apply()` swallows it, so DSH still boots, but no tools are registered.

---

## 4. Reference audio — you must supply your own

A GPT-SoVITS clone is only as good as the clip you give it, and this package **ships no audio and no
presets referring to anyone's voice**. Record your own:

* **3–10 seconds**, single speaker, no music, no second voice, no reverb.
* 16 kHz or higher, mono is ideal; WAV is the safest container (mp3/m4a/flac/ogg/opus are accepted).
* Use a clip whose **exact transcript** you can write down — that text goes into `promptText` and is
  what makes the clone land on the right pronunciation.
* Longer clips are rejected by the TTS server with **HTTP 400** (measured), so trim before you point
  at them.
* Only use recordings you have the right to use. Cloning a third party's voice — a voice actor's,
  a public figure's, anyone's — has personality-rights and copyright implications that this
  plugin's MIT licence cannot grant you.

`refAudioPath` is validated before any request is sent: the file must exist, be a regular file, end
in a supported extension and be between 1 KB and 64 MB.

---

## 5. Configuration

Configuration lives in the bundle patch (`cordis.patch.yml`) under the plugin's `config:` block, or
in your profile's own override layer. **A non-empty config value wins over the environment variable,
which wins over the built-in default.**

| Option | Type | Default | Env override | Meaning |
| --- | --- | --- | --- | --- |
| `sttEnable` | boolean | `true` | — | Start / probe the local STT server. |
| `sttCmd` | string | `''` (none) | `DSH_VOICE_LOCAL_STT_CMD` | Command that starts the Whisper server, e.g. `C:\whisper-server\start-whisper.cmd`. Empty = never start one. |
| `sttHealthUrl` | string | `http://127.0.0.1:9000/health` | `DSH_VOICE_LOCAL_STT_HEALTH_URL` | Health endpoint probed for readiness. |
| `sttWaitMs` | number | `60000` | — | How long to poll for STT readiness. |
| `ttsEnable` | boolean | `true` | — | Register / probe the TTS side. |
| `ttsBaseUrl` | string | `http://127.0.0.1:9880` | `DSH_VOICE_LOCAL_TTS_BASE_URL` | GPT-SoVITS base URL; `GET <base>/tts` is called. Trailing slashes are stripped. |
| `ttsCmd` | string | `''` (none) | `DSH_VOICE_LOCAL_TTS_CMD` | Command that starts the GPT-SoVITS API, e.g. `C:\GPT-SoVITS\start-api.cmd`. Empty = never start one. |
| `ttsWaitMs` | number | `180000` | — | How long to poll for the TTS port. |
| `refAudioPath` | string | `''` — **you must set it** | `DSH_VOICE_LOCAL_REF_AUDIO` | Default voice. See §4. Empty means `voice_tts_local` returns an error unless a `preset` or the `refAudioPath` argument supplies one. |
| `promptText` | string | `''` | — | Exact transcript of the default reference clip. |
| `promptLang` | string | `'zh'` | — | Language of the reference clip / prompt. |
| `textLang` | string | `'zh'` | — | Language of the text to synthesise. |
| `mediaType` | string | `'wav'` | — | `media_type` sent to the TTS server. |
| `textSplitMethod` | string | `'cut5'` | — | `text_split_method` sent to the TTS server. |
| `timeoutMs` | number | `300000` | — | Per-request timeout (first request loads the model and is slow). |
| `outputDir` | string | `<system temp>\dsh-voice-local` | `DSH_VOICE_LOCAL_OUTPUT_DIR` | **Every** file the plugin writes stays inside this directory — see §6. |
| `presets` | array | `[]` | — | Named voices — see §7. |
| `autoPlay` | boolean | `false` | — | Default for the `play` argument. |
| `outFormat` | string | `'wav'` | — | Default for the `format` argument: `wav` or `mp3`. |
| `ffmpegPath` | string | `''` (none) | `DSH_VOICE_LOCAL_FFMPEG` | ffmpeg executable, only needed for mp3 output. |
| `powershellPath` | string | `''` (auto) | `DSH_VOICE_LOCAL_POWERSHELL` | PowerShell used for `play: true`. Empty resolves `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` at run time. |
| `trimAspiration` | boolean | `true` | — | Run the leading-aspiration trim on each fresh output. |
| `trimRiseMin` | number | `0.30` | — | Rise time (s) required before a head stretch counts as aspiration. |
| `headAttenuateEnable` | boolean | `true` | — | Attenuate a prominent breath head. |
| `headAttenuateAdaptive` | boolean | `true` | — | Use the adaptive window instead of the fixed one. |
| `headAttenuateMs` | number | `300` | — | Head-window cap (ms); also the upper bound of the adaptive scan. |
| `headAttenuateDb` | number | `-15` | — | Gain applied over the head window (dB). |
| `headAttenuateRelDb` | number | `6` | — | "The level gets up" threshold relative to whole-utterance RMS (dB). |

Invalid values fall back one by one, so a single bad key never breaks the configuration:
non-boolean booleans, non-positive or non-finite numbers, blank strings and non-array `presets` all
resolve to their default. A dB gain is allowed to be negative (it normally is).

---

## 6. Output-path boundary (safety)

`outputDir` is the **only** directory this plugin writes to. The `output` argument is resolved like
this:

1. empty → `<outputDir>\tts_<UTC timestamp>.<format>`;
2. relative → resolved against `outputDir`;
3. absolute → accepted only if it is already inside `outputDir`.

Anything that escapes the directory — `..\..\x.wav`, an absolute path elsewhere, even a sibling
directory whose name merely *starts with* the same prefix — is **rejected with a clear error before
any synthesis request is sent**. To write somewhere else, point `config.outputDir` there.

---

## 7. Named voices (`presets`)

`presets` keeps the language × emotion idea: one named entry per voice, selected per call with
`preset: "<id>"`. This package ships an **empty list**; fill in your own entries:

```yaml
presets:
  - id: 'zh'
    label: 'Chinese · calm'
    emotion: 'calm'
    refAudioPath: 'C:\my-voices\zh-calm.wav'
    promptText: 'the exact transcript of that clip'
    promptLang: 'zh'
    textLang: 'zh'
  - id: 'ja'
    label: 'Japanese · calm'
    emotion: 'calm'
    refAudioPath: 'C:\my-voices\ja-calm.wav'
    promptText: 'そのクリップの発話内容をそのまま'
    promptLang: 'ja'
    textLang: 'ja'
```

Per entry: `id` and `refAudioPath` are **required**; `label` defaults to `id`; `emotion` may be
omitted; `lang` comes from `promptLang` (default `zh`); `textLang` follows `promptLang` unless set.
Malformed entries are dropped instead of failing the whole configuration. No `preset` (or an empty
`presets` list) means "use the default `refAudioPath`".

---

## 8. Non-destructive writes

The head-processing entry points (`trimLeadingAspiration`, `attenuateHead`) accept a **file path** and
used to overwrite that file in place. In this version the default is non-destructive:

* your current file is copied to `<file>.orig` — only the first time; an existing backup is never
  overwritten, so it always holds the true original;
* the new bytes go to a temporary file that is then renamed over the target, so the target is never
  left half-written.

Passing `{ overwrite: true }` skips the backup. The plugin itself does that for the WAV it has just
synthesised, because it owns that file. Nothing is written at all when a pass changes nothing: no
`.orig`, no temp file.

The underlying `wav-head-trim` functions are pure `Buffer -> Buffer` and never touch the filesystem.

---

## 9. Head-of-utterance processing

Two problems with cloned TTS output, both measured, and what is done about them:

| Problem | Measurement | Treatment |
| --- | --- | --- |
| A slow-rising **leading aspiration** (a long breath-in before the first word). | Appears in roughly 1/30 generated samples; rise >= 0.30 s, while normal crisp onsets rise in 0.04–0.19 s. | Trim the head when a silent valley proves it is breath and the level really does rise after it. |
| A **prominent breath head** that is not louder than the speech, just more audible. | 6–20 dB below the utterance RMS; head/to-tail delta only 5.5–7.4 dB. | Do not trim (the level difference is too small to be sure) — attenuate the head window with a linear fade-out. |

Everything is quantitative, and the thresholds are only ever made *more conservative*:

* `riseMin = 0.30` separates a real aspiration from a crisp onset (0.04–0.19 s).
* The wide gate needs `tail − head >= 8 dB`; one real sample sat at 7.05 dB, which is why a narrow
  channel exists (`delta >= 5 dB` **and** a peak-basis head rise `>= 0.30 s`). Short weak first words
  land in that same 5–8 dB band but rise in only 0.05–0.10 s, so the rise condition keeps them safe.
* An **80-sample regression** is what ships: 2 files trimmed (1 wide gate + 1 narrow channel),
  78 untouched. Dropping the wide gate would re-trim 6 already-accepted files, which is why it stays.
* A real aspiration is about 14 % of the file, which is where the **30 % cap** comes from (past that,
  the verdict is not trusted — the plugin then prefers to do nothing).
* Attenuation sits in the 12–18 dB range, median 15 dB → `headAttenuateDb = -15`.
* A fixed 300 ms window pushed an early-onset sample down by 11.7 dB, so the window became
  **adaptive**: scan from 0 and stop where the level "gets up". The result is clamped to
  `[40, cap] ms`, i.e. only ever shorter — never harsher — than the fixed window.

The thresholds, the full derivation and a 345-file byte-for-byte compatibility regression live in the
`wav-head-trim` README. Applying the algorithm to the same pipeline through these wrappers was
verified byte-identical on **471 real WAV files** (`npm run compare`, see §11).

---

## 10. Platform limits and caveats

* **Windows only** (`os: ["win32"]`). Service start-up shells out to `cmd.exe`, playback needs
  Windows PowerShell. On other platforms the plugin still loads, `voice_tts_local` still works
  against a TTS server you started yourself, and playback reports "not supported".
* **The STT side does not transcribe.** It only starts and probes the Whisper server; the actual
  speech-to-text tool comes from `dsh-voice`.
* **The child processes are killed on dispose.** A server started by this plugin is a child of DSH,
  so it dies with the host — that is the intended lifetime, not a bug.
* **The TTS server's error body is echoed** into the tool error (first 200 characters). It comes from
  your own local server; disable nothing, just be aware it lands in the model context.
* **No credentials are read or written** — no API keys, no `.credentials.yaml`, no telemetry, no
  network access beyond the two local URLs you configure.
* `ffmpeg` is invoked with an argument array (no shell), so a path with spaces or quotes is safe.
* The reference audio path is passed to your local TTS server unchanged (after resolution), so point
  it only at the local server you configured.

---

## 11. Development

```bash
npm test        # node --test  (no network, no services, no real user files)
node --check lib/index.js

# byte-for-byte comparison of the head pipeline against a reference implementation
node tools/compare-with-original.mjs <corpus-dir> [...] [--original <lib/index.js>] [--limit <n>]
```

`tools/compare-with-original.mjs` copies every input into a fresh temp directory before running
either implementation (the reference one rewrites files in place), compares the output bytes **and**
the decision fields, prints a per-file report, deletes the temp copies, and exits non-zero on any
difference. The reference module is auto-detected inside the current user's DSH profile; pass
`--original` to point it anywhere else. No path is hard-coded.

Testing without a published `wav-head-trim`: create a directory junction so the bare specifier
resolves — run this **from the package root**, so the relative target lands on the sibling checkout:

```powershell
New-Item -ItemType Junction -Path .\node_modules\wav-head-trim -Target ..\wav-head-trim
```

The tests cover the pure layers — configuration normalisation, preset parsing, the output-path
boundary, reference-audio validation, and the file wrappers (including the non-destructive write)
against WAV buffers synthesised in code. The parts that need a running Whisper/GPT-SoVITS server are
not covered.

---

## 12. Licence

[MIT](./LICENSE) © an94 — see `LICENSE`.

No third-party voice, audio or preset data is included in this repository. Replace the
`an94` / `an94` placeholders with your own values before publishing.
