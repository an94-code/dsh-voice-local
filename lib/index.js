/**
 * dsh-voice-local — run a local, offline speech stack next to DeepSeek Harness (DSH).
 *
 * Three jobs:
 *
 *   1. Bring up a local Whisper STT server together with DSH (default
 *      `127.0.0.1:9000`). The server is spawned as a child of the host process,
 *      so it lives and dies with DSH — no scheduled task and no Windows service.
 *   2. Register `voice_tts_local`: text -> local GPT-SoVITS server (default
 *      `127.0.0.1:9880`) for offline voice cloning. It does **not** modify
 *      `dsh-voice`, so upgrading or reinstalling that plugin is unaffected.
 *   3. Named `presets` (language x emotion): one `preset: 'ja'` switches voice;
 *      with no `preset` the `config.refAudioPath` voice is used.
 *
 * `play: true` plays the result through the local speakers (WAV, Windows
 * PowerShell + `Media.SoundPlayer`).
 *
 * Head-of-utterance processing (leading-aspiration trimming, breath-head
 * attenuation, adaptive head window) is delegated to the standalone
 * `wav-head-trim` package, which is a pure Buffer -> Buffer layer with no
 * filesystem access. This file keeps the historical file-system wrappers around
 * it — same function names, same defaults, same return fields — plus the
 * non-destructive write and output-path boundary that a published plugin needs.
 *
 * Design rules:
 *   - `apply()` is wrapped in try/catch end to end: a broken plugin must never
 *     take DSH down.
 *   - Every tool registration is wrapped in try/catch.
 *   - STT/TTS launch is fire-and-forget and never blocks boot.
 *
 * © 2026 an94 — MIT.
 *
 * @module dsh-voice-local
 */
import { spawn } from 'node:child_process';
import {
    copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
    adaptiveHeadWindowMs as wavAdaptiveHeadWindowMs,
    attenuateHead as wavAttenuateHead,
    trimLeadingAspiration as wavTrimLeadingAspiration,
} from 'wav-head-trim';

export const name = 'voice-local';
export const inject = ['tools'];

const LOG = '[dsh-voice-local] ';

/** Container formats accepted for `refAudioPath` (the TTS server decodes them). */
const REF_AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus'];
/** A 3-10 s clip is the sweet spot; these are loose sanity bounds, not quality checks. */
const REF_AUDIO_MIN_BYTES = 1024;
const REF_AUDIO_MAX_BYTES = 64 * 1024 * 1024;
/** Sub-directory created under the system temp dir when `outputDir` is left empty. */
const DEFAULT_OUTPUT_DIRNAME = 'dsh-voice-local';

/**
 * Environment variables that may supply a value when the matching config key is
 * empty. A non-empty **config** value always wins over the environment, which in
 * turn wins over the built-in default.
 */
export const ENV = Object.freeze({
    sttCmd: 'DSH_VOICE_LOCAL_STT_CMD',
    sttHealthUrl: 'DSH_VOICE_LOCAL_STT_HEALTH_URL',
    ttsCmd: 'DSH_VOICE_LOCAL_TTS_CMD',
    ttsBaseUrl: 'DSH_VOICE_LOCAL_TTS_BASE_URL',
    refAudioPath: 'DSH_VOICE_LOCAL_REF_AUDIO',
    outputDir: 'DSH_VOICE_LOCAL_OUTPUT_DIR',
    ffmpegPath: 'DSH_VOICE_LOCAL_FFMPEG',
    powershellPath: 'DSH_VOICE_LOCAL_POWERSHELL',
});

/** Every tunable, with the shipped default. */
export const DEFAULTS = Object.freeze({
    sttEnable: true,
    /** Command that starts the local Whisper server. Empty = do not start one. */
    sttCmd: '',
    sttHealthUrl: 'http://127.0.0.1:9000/health',
    sttWaitMs: 60000,
    ttsEnable: true,
    ttsBaseUrl: 'http://127.0.0.1:9880',
    /** Command that starts the local GPT-SoVITS server. Empty = do not start one. */
    ttsCmd: '',
    ttsWaitMs: 180000,
    // ---- head-of-utterance processing (forwarded to `wav-head-trim`) ----
    trimAspiration: true,
    trimRiseMin: 0.30,
    headAttenuateEnable: true,
    headAttenuateDb: -15,
    headAttenuateMs: 300,
    headAttenuateAdaptive: true,
    headAttenuateRelDb: 6,
    // ---- voice / request ----
    refAudioPath: '',
    promptText: '',
    promptLang: 'zh',
    textLang: 'zh',
    mediaType: 'wav',
    textSplitMethod: 'cut5',
    timeoutMs: 300000,
    presets: [],
    // ---- output ----
    /** All writes are confined to this directory. */
    outputDir: join(tmpdir(), DEFAULT_OUTPUT_DIRNAME),
    autoPlay: false,
    outFormat: 'wav',
    ffmpegPath: '',
    powershellPath: '',
});

// ---------------------------------------------------------------------------
// config normalisation
// ---------------------------------------------------------------------------

function str(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}
/** Config value -> environment -> default. */
function strFrom(value, envName, fallback) {
    const direct = str(value, '');
    if (direct !== '')
        return direct;
    const fromEnv = str(envName === undefined ? '' : process.env[envName], '');
    if (fromEnv !== '')
        return fromEnv;
    return fallback;
}
function bool(value, fallback) {
    return value === true ? true : value === false ? false : fallback;
}
function num(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** Signed number (`num` rejects <= 0, and a dB gain is negative). */
function snum(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parse the `presets` list. An entry needs both `id` and `refAudioPath`; every
 * other field falls back independently, and a broken entry is dropped rather
 * than failing the whole configuration.
 *
 * @param {unknown} raw
 * @returns {Array<{id:string,label:string,emotion:string,lang:string,refAudioPath:string,promptText:string,textLang:string}>}
 */
export function parsePresets(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const id = str(item.id, '');
        const refAudioPath = str(item.refAudioPath, '');
        if (id === '' || refAudioPath === '')
            continue;
        out.push({
            id,
            label: str(item.label, id),
            emotion: str(item.emotion, ''),
            lang: str(item.promptLang, DEFAULTS.promptLang),
            refAudioPath,
            promptText: typeof item.promptText === 'string' ? item.promptText : '',
            textLang: str(item.textLang, str(item.promptLang, DEFAULTS.textLang)),
        });
    }
    return out;
}

/**
 * Normalise a plugin config. Missing or invalid entries fall back one by one, so
 * a single bad value can never break the whole configuration.
 */
export function resolveConfig(config) {
    const c = config ?? {};
    return {
        sttEnable: bool(c.sttEnable, DEFAULTS.sttEnable),
        sttCmd: strFrom(c.sttCmd, ENV.sttCmd, DEFAULTS.sttCmd),
        sttHealthUrl: strFrom(c.sttHealthUrl, ENV.sttHealthUrl, DEFAULTS.sttHealthUrl),
        sttWaitMs: num(c.sttWaitMs, DEFAULTS.sttWaitMs),
        ttsEnable: bool(c.ttsEnable, DEFAULTS.ttsEnable),
        ttsBaseUrl: strFrom(c.ttsBaseUrl, ENV.ttsBaseUrl, DEFAULTS.ttsBaseUrl).replace(/\/+$/, ''),
        ttsCmd: strFrom(c.ttsCmd, ENV.ttsCmd, DEFAULTS.ttsCmd),
        ttsWaitMs: num(c.ttsWaitMs, DEFAULTS.ttsWaitMs),
        refAudioPath: strFrom(c.refAudioPath, ENV.refAudioPath, DEFAULTS.refAudioPath),
        promptText: typeof c.promptText === 'string' ? c.promptText : '',
        promptLang: str(c.promptLang, DEFAULTS.promptLang),
        textLang: str(c.textLang, DEFAULTS.textLang),
        mediaType: str(c.mediaType, DEFAULTS.mediaType),
        textSplitMethod: str(c.textSplitMethod, DEFAULTS.textSplitMethod),
        timeoutMs: num(c.timeoutMs, DEFAULTS.timeoutMs),
        outputDir: strFrom(c.outputDir, ENV.outputDir, DEFAULTS.outputDir),
        presets: parsePresets(c.presets),
        autoPlay: bool(c.autoPlay, DEFAULTS.autoPlay),
        outFormat: str(c.outFormat, DEFAULTS.outFormat).toLowerCase() === 'mp3' ? 'mp3' : 'wav',
        ffmpegPath: strFrom(c.ffmpegPath, ENV.ffmpegPath, DEFAULTS.ffmpegPath),
        powershellPath: strFrom(c.powershellPath, ENV.powershellPath, DEFAULTS.powershellPath),
        trimAspiration: bool(c.trimAspiration, DEFAULTS.trimAspiration),
        trimRiseMin: num(c.trimRiseMin, DEFAULTS.trimRiseMin),
        headAttenuateEnable: bool(c.headAttenuateEnable, DEFAULTS.headAttenuateEnable),
        headAttenuateDb: snum(c.headAttenuateDb, DEFAULTS.headAttenuateDb),
        headAttenuateMs: num(c.headAttenuateMs, DEFAULTS.headAttenuateMs),
        headAttenuateAdaptive: bool(c.headAttenuateAdaptive, DEFAULTS.headAttenuateAdaptive),
        headAttenuateRelDb: num(c.headAttenuateRelDb, DEFAULTS.headAttenuateRelDb),
    };
}

// ---------------------------------------------------------------------------
// tiny network probes (never throw)
// ---------------------------------------------------------------------------

/** Pure TCP liveness probe (works whether or not the target speaks HTTP). */
function tcpCheck(port, host = '127.0.0.1', timeoutMs = 1500) {
    return new Promise((done) => {
        const socket = connect({ host, port });
        let settled = false;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            try {
                socket.destroy();
            }
            catch { /* ignore */ }
            done(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

/** GET JSON; any failure (non-2xx, non-JSON, offline) yields null. */
async function httpJson(url, timeoutMs = 3000) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok)
            return null;
        return await res.json();
    }
    catch {
        return null;
    }
}

/** host/port of a URL, for the TCP probes; `fallbackPort` when absent/unparsable. */
function hostPortFromUrl(rawUrl, fallbackPort) {
    try {
        const u = new URL(rawUrl);
        return {
            host: u.hostname === '' ? '127.0.0.1' : u.hostname,
            port: Number(u.port === '' ? String(fallbackPort) : u.port),
        };
    }
    catch {
        return { host: '127.0.0.1', port: fallbackPort };
    }
}

/** Start a `.cmd`/`.exe` detached-ish child, reporting spawn errors only. */
function spawnService(cmd) {
    try {
        const child = spawn('cmd.exe', ['/c', cmd], { windowsHide: true, stdio: 'ignore' });
        child.on('error', (error) => console.warn(LOG + '服务启动失败：' + error.message));
        return child;
    }
    catch (error) {
        console.warn(LOG + '服务启动异常：' + (error?.message ?? String(error)));
        return null;
    }
}

/** Bring up the local Whisper STT server if it is not answering yet. */
async function ensureStt(cfg) {
    const alive = await httpJson(cfg.sttHealthUrl, 3000);
    if (alive !== null) {
        console.log(LOG + 'STT 已在跑（device=' + (alive.device ?? '?') + '），跳过拉起');
        return null;
    }
    if (cfg.sttCmd === '') {
        console.warn(LOG + 'STT 未运行，且未配置 sttCmd（config.sttCmd / ' + ENV.sttCmd + '）—— 跳过拉起');
        return null;
    }
    if (process.platform !== 'win32') {
        console.warn(LOG + 'STT 拉起仅支持 Windows（当前 ' + process.platform + '）—— 跳过拉起');
        return null;
    }
    console.log(LOG + '拉起本地 STT：' + cfg.sttCmd);
    const child = spawnService(cfg.sttCmd);
    const deadline = Date.now() + cfg.sttWaitMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const h = await httpJson(cfg.sttHealthUrl, 3000);
        if (h !== null) {
            console.log(LOG + 'STT 就绪：device=' + (h.device ?? '?') + ' load=' + (h.load_seconds ?? '?') + 's');
            return child;
        }
    }
    console.warn(LOG + 'STT 在 ' + cfg.sttWaitMs + 'ms 内未就绪（可能还在加载模型，稍后自会可用）');
    return child;
}

/** host/port of the configured TTS base URL. */
function ttsHostPort(cfg) {
    return hostPortFromUrl(cfg.ttsBaseUrl, 9880);
}

/** Bring up the local GPT-SoVITS API server if its port is closed. */
async function ensureTts(cfg) {
    const { host, port } = ttsHostPort(cfg);
    if (await tcpCheck(port, host, 2000)) {
        console.log(LOG + 'TTS 已在跑（' + host + ':' + port + '），跳过拉起');
        return null;
    }
    if (cfg.ttsCmd === '') {
        console.warn(LOG + 'TTS 未运行，且未配置 ttsCmd（config.ttsCmd / ' + ENV.ttsCmd + '）—— 跳过拉起');
        return null;
    }
    if (process.platform !== 'win32') {
        console.warn(LOG + 'TTS 拉起仅支持 Windows（当前 ' + process.platform + '）—— 跳过拉起');
        return null;
    }
    console.log(LOG + '拉起本地 TTS：' + cfg.ttsCmd);
    const child = spawnService(cfg.ttsCmd);
    const deadline = Date.now() + cfg.ttsWaitMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        if (await tcpCheck(port, host, 2000)) {
            console.log(LOG + 'TTS 端口已就绪 ' + host + ':' + port + '（首个请求才加载权重，会慢一点）');
            return child;
        }
    }
    console.warn(LOG + 'TTS 在 ' + cfg.ttsWaitMs + 'ms 内未就绪');
    return child;
}

// ---------------------------------------------------------------------------
// playback / transcoding
// ---------------------------------------------------------------------------

/**
 * Windows PowerShell used for local playback. Resolved at run time from
 * `SystemRoot`, so nothing is hard-coded; `config.powershellPath` (or
 * `DSH_VOICE_LOCAL_POWERSHELL`) overrides it. Returns `''` when unavailable.
 */
function powershellPath(cfg) {
    if (cfg.powershellPath !== '')
        return cfg.powershellPath;
    const root = process.env.SystemRoot ?? process.env.windir ?? '';
    return root === '' ? '' : join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Play a WAV through the local speakers (Windows PowerShell + `Media.SoundPlayer`).
 * The path travels in an environment variable so no quoting is involved.
 */
function playAudio(file, cfg) {
    if (process.platform !== 'win32')
        return { played: false, reason: '本机播放仅支持 Windows（当前 ' + process.platform + '）' };
    if (!file.toLowerCase().endsWith('.wav'))
        return { played: false, reason: '只支持 wav 直接播放（当前输出不是 wav）' };
    const exe = powershellPath(cfg);
    if (exe === '' || !existsSync(exe))
        return { played: false, reason: '未找到 Windows PowerShell（可配置 powershellPath / ' + ENV.powershellPath + '）' };
    try {
        const child = spawn(exe,
            ['-NoProfile', '-NonInteractive', '-Command',
                '$f=$env:DSH_TTS_FILE; if($f -and (Test-Path $f)){ (New-Object Media.SoundPlayer $f).PlaySync() }'],
            { windowsHide: true, stdio: 'ignore', env: { ...process.env, DSH_TTS_FILE: file } });
        child.on('error', (error) => console.warn(LOG + '播放失败：' + error.message));
        return { played: true };
    }
    catch (error) {
        console.warn(LOG + '播放异常：' + (error?.message ?? String(error)));
        return { played: false, reason: error?.message ?? String(error) };
    }
}

/**
 * wav -> mp3. GPT-SoVITS itself does not emit mp3 (media_type is limited to
 * wav/raw/ogg/aac), so a local ffmpeg does the conversion. Failure only warns and
 * keeps the wav; it never throws.
 */
function convertToMp3(wavPath, mp3Path, ffmpegPath) {
    return new Promise((done) => {
        if (ffmpegPath === '') {
            done({ ok: false, reason: '未配置 ffmpegPath' });
            return;
        }
        let child;
        try {
            child = spawn(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error',
                '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '192k', mp3Path],
                { windowsHide: true, stdio: 'ignore' });
        }
        catch (error) {
            done({ ok: false, reason: error?.message ?? String(error) });
            return;
        }
        child.on('error', (error) => done({ ok: false, reason: error.message }));
        child.on('close', (code) => done(code === 0 ? { ok: true } : { ok: false, reason: 'ffmpeg exit ' + code }));
    });
}

// ---------------------------------------------------------------------------
// head-of-utterance processing — thin wrappers over `wav-head-trim`
// ---------------------------------------------------------------------------
/**
 * The algorithm itself now lives in the standalone `wav-head-trim` package
 * (pure Buffer -> Buffer, no filesystem access). What is left here is the
 * historical file-path API: read file -> call the module -> write file.
 *
 * The thresholds and the measurements behind them are kept because they are the
 * valuable part. Full derivation, the parameter table and the 345-file
 * byte-for-byte compatibility regression are in the `wav-head-trim` README.
 *
 *   - Sampling: 30 generated samples x 3 recipes. A slow-rising aspiration
 *     appeared in roughly 1/30 files, with a rise of >= 0.30 s, while every other
 *     (crisp) onset rose in 0.04-0.19 s  =>  `riseMin = 0.30`.
 *   - Trimming a leading aspiration never dropped a word: the post-trim
 *     transcription matched the pre-trim transcription word for word.
 *   - Wide gate: one real sample measured delta = 7.05 dB (< 8 dB) and slipped
 *     through, which is why a narrow channel was added (delta >= 5 dB **and** a
 *     peak-basis head rise >= `riseMin`).
 *   - Short weak first words sit in that same 5-8 dB band (delta 5.3-6.5 dB) but
 *     their head rise is only 0.05-0.10 s, so `riseMin` keeps them safe.
 *   - An 80-sample regression is what ships: 2 files trimmed (1 wide gate + 1
 *     narrow channel), 78 untouched. Dropping the 8 dB wide gate re-trimmed 6
 *     already-accepted files, so it stays.
 *   - A real aspiration is about 14 % of the file, which is where the 30 % cap
 *     comes from (past that the verdict is not trusted).
 *   - Breath heads measure 6-20 dB below the utterance RMS yet still sound
 *     prominent, so a pure loudness test cannot see them; their delta is
 *     5.5-7.4 dB (< 8), so trimming cannot fix them either  =>  attenuate the
 *     head window instead.
 *   - Attenuation range 12-18 dB, median 15 dB  =>  `headAttenuateDb = -15`.
 *   - A fixed 300 ms window pushed an early-onset sample down by 11.7 dB, so the
 *     window became adaptive: scan from 0 and stop where the level "gets up".
 *     The result is clamped to [40, cap] ms, i.e. only ever shorter — never
 *     harsher — than the fixed window.
 */

/** Defaults of the historical positional API (same numbers as `wav-head-trim`). */
const TRIM_RISE_MIN = 0.30;
const TRIM_HEAD_FLOOR_DB = 35;
const TRIM_RATIO_DELTA_DB = 8;
const TRIM_NARROW_DELTA_DB = 5;
const HEAD_MS = 300;
const HEAD_GAIN_DB = -15;
const HEAD_FADE_MS = 40;

/**
 * Overwrite `target` with `buffer` **without destroying what was there**.
 *
 * Default behaviour (non-destructive): the current file is copied to
 * `<target>.orig` (only the first time — an existing backup is kept as the true
 * original) and the new bytes are written to a temporary file that is then
 * renamed over `target`, so `target` is never left half-written.
 *
 * `options.overwrite === true` skips the backup; use it only for a file the
 * caller owns and has just created (the plugin does exactly that for its own
 * freshly synthesised WAV).
 *
 * @param {string} target
 * @param {Buffer} buffer
 * @param {{overwrite?: boolean, backupSuffix?: string}} [options]
 * @returns {string|null} path of the backup that was created, or null
 */
export function writeWavNonDestructive(target, buffer, options) {
    const opts = options ?? {};
    let backup = null;
    if (existsSync(target) && opts.overwrite !== true) {
        const suffix = typeof opts.backupSuffix === 'string' && opts.backupSuffix !== ''
            ? opts.backupSuffix
            : '.orig';
        backup = target + suffix;
        if (!existsSync(backup))
            copyFileSync(target, backup);
    }
    const tmp = target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    writeFileSync(tmp, buffer);
    try {
        renameSync(tmp, target);
    }
    catch (error) {
        try {
            rmSync(tmp, { force: true });
        }
        catch { /* ignore */ }
        throw error;
    }
    return backup;
}

/**
 * Trim a slow-rising leading aspiration off a WAV file.
 *
 * Same signature and return shape as the historical implementation, but the
 * decision is made by `wav-head-trim` and the write is non-destructive by
 * default (see {@link writeWavNonDestructive}).
 *
 * @returns {{trimmed: boolean, reason?: string, riseTime?: number, narrow?: boolean,
 *            cut?: number, oldSeconds?: number, newSeconds?: number, code?: string, backup?: string|null}}
 */
export function trimLeadingAspiration(
    wavPath,
    riseMin = TRIM_RISE_MIN,
    headFloorDb = TRIM_HEAD_FLOOR_DB,
    ratioDeltaDb = TRIM_RATIO_DELTA_DB,
    narrowDeltaDb = TRIM_NARROW_DELTA_DB,
    options = {},
) {
    try {
        const input = readFileSync(wavPath);
        const { buffer, diag } = wavTrimLeadingAspiration(input, {
            riseMin, headFloorDb, ratioDeltaDb, narrowDeltaDb,
        });
        if (!diag.trimmed) {
            const out = { trimmed: false, code: diag.code, reason: diag.reason };
            if (diag.riseTime !== undefined)
                out.riseTime = diag.riseTime;
            return out;
        }
        const backup = writeWavNonDestructive(wavPath, buffer, options);
        return {
            trimmed: true,
            code: diag.code,
            riseTime: diag.riseTime,
            narrow: diag.narrow,
            cut: diag.cut,
            oldSeconds: diag.oldSeconds,
            newSeconds: diag.newSeconds,
            backup,
        };
    }
    catch (error) {
        return { trimmed: false, reason: error?.message ?? String(error) };
    }
}

/**
 * Attenuate the first `ms` milliseconds of a WAV file by `gainDb`, fading back to
 * unity over the last `fadeMs` so no click is introduced.
 *
 * Same signature and return shape as the historical implementation; the write is
 * non-destructive by default.
 *
 * @returns {{ok: boolean, reason?: string, ms?: number, gainDb?: number, sampleRate?: number,
 *            samplesPerChannel?: number, fadeMs?: number, changed?: boolean, backup?: string|null}}
 */
export function attenuateHead(
    wavPath,
    ms = HEAD_MS,
    gainDb = HEAD_GAIN_DB,
    fadeMs = HEAD_FADE_MS,
    options = {},
) {
    try {
        const input = readFileSync(wavPath);
        const { buffer, diag } = wavAttenuateHead(input, { ms, gainDb, fadeMs });
        if (diag.ok !== true)
            return { ok: false, reason: diag.reason };
        const backup = diag.changed === true ? writeWavNonDestructive(wavPath, buffer, options) : null;
        return {
            ok: true,
            ms: diag.ms,
            gainDb: diag.gainDb,
            fadeMs: diag.fadeMs,
            sampleRate: diag.sampleRate,
            samplesPerChannel: diag.samplesPerChannel,
            changed: diag.changed === true,
            backup,
        };
    }
    catch (error) {
        return { ok: false, reason: error?.message ?? String(error) };
    }
}

/**
 * Length in milliseconds of the head window worth attenuating: scan forward and
 * stop where the level "gets up" (voice onset); fall back to `maxMs` when it
 * never does. Always clamped to [`minMs`, `maxMs`], so it can only ever be
 * shorter — never more aggressive — than a fixed window. Falls back to `maxMs`
 * when the file cannot be read or analysed.
 *
 * @returns {number} milliseconds
 */
export function adaptiveHeadWindowMs(
    wavPath,
    maxMs = HEAD_MS,
    relDb = 6,
    stepMs = 20,
    scanMs = 500,
    minMs = 40,
) {
    try {
        const input = readFileSync(wavPath);
        return wavAdaptiveHeadWindowMs(input, { maxMs, relDb, stepMs, scanMs, minMs });
    }
    catch {
        return maxMs;
    }
}

// ---------------------------------------------------------------------------
// output-path boundary and reference-audio validation
// ---------------------------------------------------------------------------

/** True when `target` is `base` itself or lives underneath it. */
function isInsideDir(base, target) {
    const rel = relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve the output file path for a synthesis request.
 *
 * Every path is confined to `cfg.outputDir` (or `DEFAULTS.outputDir` when the
 * key is empty): a relative request is resolved against it, an absolute request
 * must already sit inside it, and `..` traversal is rejected. A request that
 * escapes throws, so the plugin can never be used to write arbitrary paths.
 *
 * @param {string|undefined} requested
 * @param {{outputDir: string, mediaType: string}} cfg
 * @returns {string} absolute path inside `cfg.outputDir`
 * @throws {Error} when the request escapes `cfg.outputDir`
 */
export function resolveOutputPath(requested, cfg) {
    const base = resolve(cfg.outputDir !== '' ? cfg.outputDir : DEFAULTS.outputDir);
    let target;
    if (typeof requested === 'string' && requested.trim() !== '') {
        const p = requested.trim();
        target = isAbsolute(p) ? resolve(p) : resolve(base, p);
    }
    else {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        target = resolve(base, 'tts_' + stamp + '.' + cfg.mediaType);
    }
    if (!isInsideDir(base, target)) {
        throw new Error('输出路径越界：' + target + ' 不在 outputDir（' + base + '）之内。'
            + '请改用相对路径，或先把 config.outputDir 指到你想写的目录。');
    }
    return target;
}

/**
 * Validate a reference audio path: it must exist, be a regular file, carry a
 * supported extension and have a plausible size. Called before any request is
 * sent to the TTS server.
 *
 * @returns {{ok: boolean, path?: string, bytes?: number, reason?: string}}
 */
export function validateRefAudio(refPath) {
    const p = str(refPath, '');
    if (p === '') {
        return {
            ok: false,
            reason: '未配置参考音频（refAudioPath）—— 音色克隆必须给一段 3–10 秒的干净人声（16k+ 单声道 WAV 最佳）。',
        };
    }
    const ext = extname(p).toLowerCase();
    if (!REF_AUDIO_EXTS.includes(ext)) {
        return {
            ok: false,
            reason: '参考音频扩展名不受支持（' + (ext === '' ? '(无扩展名)' : ext) + '）；支持：' + REF_AUDIO_EXTS.join(' / '),
        };
    }
    let stat;
    try {
        stat = statSync(p);
    }
    catch {
        return { ok: false, reason: '参考音频不存在或无法读取：' + p };
    }
    if (!stat.isFile())
        return { ok: false, reason: '参考音频不是普通文件：' + p };
    if (stat.size < REF_AUDIO_MIN_BYTES) {
        return {
            ok: false,
            reason: '参考音频过小（' + stat.size + ' B）—— 至少 ' + REF_AUDIO_MIN_BYTES + ' B，3–10 秒为宜。',
        };
    }
    if (stat.size > REF_AUDIO_MAX_BYTES) {
        return {
            ok: false,
            reason: '参考音频过大（' + stat.size + ' B）—— 上限 ' + REF_AUDIO_MAX_BYTES + ' B，3–10 秒为宜。',
        };
    }
    return { ok: true, path: resolve(p), bytes: stat.size };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const textOut = (properties) => ({
    schema: { type: 'object', properties, additionalProperties: true },
    render: (_args, value) => {
        const v = typeof value === 'object' && value !== null ? value : {};
        if (typeof v.summary === 'string')
            return [{ type: 'text', text: v.summary }];
        return [{ type: 'text', text: '本地合成完成：' + v.output + '（' + v.bytes + ' 字节，参考音频 ' + v.refAudioPath + '）' }];
    },
});

/** Build the three tools: voice_local_health / voice_local_presets / voice_tts_local. */
export function buildTools(cfg) {
    const health = {
        name: 'voice_local_health',
        description: '本机语音服务自检：Whisper STT（语音转文字）与 GPT-SoVITS TTS（音色克隆）是否就绪，以及参考音频与预设数量。地址取自配置。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOut({ summary: { type: 'string' }, stt: { type: 'string' }, tts: { type: 'string' }, refAudioPath: { type: 'string' } }),
        async execute() {
            const sp = hostPortFromUrl(cfg.sttHealthUrl, 9000);
            const sttJson = await httpJson(cfg.sttHealthUrl, 4000);
            const stt = sttJson !== null
                ? '✅ 就绪 device=' + (sttJson.device ?? '?') + ' compute=' + (sttJson.compute_type ?? '?')
                : (await tcpCheck(sp.port, sp.host) ? '⚠️ 端口在监听，但 /health 未正常响应' : '❌ 未运行');
            const hp = ttsHostPort(cfg);
            const tts = (await tcpCheck(hp.port, hp.host, 2000))
                ? '✅ 端口在监听 ' + hp.host + ':' + hp.port
                : '❌ 未运行（' + hp.host + ':' + hp.port + ' 未监听）';
            const refCheck = validateRefAudio(cfg.refAudioPath);
            return {
                stt,
                tts,
                refAudioPath: cfg.refAudioPath,
                summary: '本地语音服务：\n- STT ' + sp.port + '：' + stt + '\n- TTS ' + hp.port + '：' + tts +
                    '\n- 默认参考音频：' + (cfg.refAudioPath === '' ? '（未配置，voice_tts_local 会报错）' : cfg.refAudioPath) +
                    '\n- 默认参考音频校验：' + (cfg.refAudioPath === '' ? '（跳过）' : (refCheck.ok ? '✅ 可用' : '❌ ' + refCheck.reason)) +
                    '\n- 输出目录：' + cfg.outputDir +
                    '\n- 预设音色：' + (cfg.presets.length === 0 ? '（未配置）'
                        : cfg.presets.map((p) => p.id).join(' / ')) +
                    '\n- 自动播放：' + (cfg.autoPlay ? '开' : '关'),
            };
        },
    };

    const list = {
        name: 'voice_local_presets',
        description: '列出本机可用的预设音色（语言／情绪／参考音频／对应文本），用于 voice_tts_local 的 preset 参数。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOut({ summary: { type: 'string' } }),
        async execute() {
            if (cfg.presets.length === 0)
                return { summary: '未配置任何预设（config.presets 为空）。' };
            const lines = cfg.presets.map((p) => '- ' + p.id + '｜' + p.label +
                (p.emotion === '' ? '' : '｜情绪：' + p.emotion) + '｜语言：' + p.lang +
                '\n    文本：' + (p.promptText === '' ? '(空)' : p.promptText) +
                '\n    音频：' + p.refAudioPath);
            return { summary: '预设音色（' + cfg.presets.length + ' 个）：\n' + lines.join('\n') };
        },
    };

    const tts = {
        name: 'voice_tts_local',
        description: '本地音色克隆语音合成（本机 GPT-SoVITS，零云端、零密钥）：用参考音频的音色把 text 念出来。'
            + '默认走 config 的参考音频（中文）；用 preset 可一句切换到其它语言音色（如 preset:"ja"/"en"/"ko"），'
            + '此时 text 请写对应语言的句子、textLang 用同语言代码。play:true 会用本机扬声器直接放出来（限 wav）。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '要合成的文本（必填）。用 preset 时请写该预设对应语言的句子。' },
                preset: { type: 'string', description: '预设音色 id（可选，见 voice_local_presets；不传＝用 config 默认参考音频）。' },
                refAudioPath: { type: 'string', description: '参考音频路径（可选，覆盖预设/配置；3–10 秒单人干净人声最佳）。' },
                promptText: { type: 'string', description: '参考音频对应的文字（可选，覆盖预设/配置）。' },
                textLang: { type: 'string', description: '文本语言（可选，zh/ja/en/ko/auto，默认跟随所选预设）。' },
                output: { type: 'string', description: '输出音频路径（可选；必须落在 config.outputDir 之内，缺省为 <outputDir>/tts_<时间戳>.<格式>）。' },
                play: { type: 'boolean', description: '合成后是否立刻用本机扬声器播放（可选；缺省取 config.autoPlay）。' },
                format: { type: 'string', description: '输出格式 wav|mp3（可选；缺省取 config.outFormat）。mp3 由本机 ffmpeg 转（GPT-SoVITS 本身只出 wav）。' },
            },
            required: ['text'],
        },
        output: textOut({ output: { type: 'string' }, bytes: { type: 'number' }, refAudioPath: { type: 'string' } }),
        async execute(rawArgs) {
            const args = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {};
            const text = typeof args.text === 'string' ? args.text.trim() : '';
            if (text === '')
                throw new Error('text 为必填，请提供要合成的文本。');

            let preset = null;
            if (typeof args.preset === 'string' && args.preset.trim() !== '') {
                const want = args.preset.trim();
                preset = cfg.presets.find((p) => p.id === want) ?? null;
                if (preset === null) {
                    throw new Error('未知预设 "' + want + '"；可用：' +
                        (cfg.presets.length === 0 ? '（config.presets 为空，先配置）' : cfg.presets.map((p) => p.id).join(', ')));
                }
            }

            const refCheck = validateRefAudio(str(args.refAudioPath, preset?.refAudioPath ?? cfg.refAudioPath));
            if (!refCheck.ok)
                throw new Error(refCheck.reason);
            const ref = refCheck.path;
            const promptText = str(args.promptText, preset?.promptText ?? cfg.promptText);
            const promptLang = preset?.lang ?? cfg.promptLang;
            const textLang = str(args.textLang, preset?.textLang ?? cfg.textLang);

            // Fail fast on an out-of-bounds output path, before any synthesis work.
            const wantMp3 = str(args.format, cfg.outFormat).toLowerCase() === 'mp3';
            const requested = resolveOutputPath(args.output, cfg);
            // The default name already carries an extension, so strip any trailing
            // `.wav`/`.mp3` and append exactly one.
            const basePath = requested.replace(/(\.wav)+$/i, '').replace(/\.mp3$/i, '');
            const wavTarget = wantMp3 ? basePath + '.wav' : requested;

            const url = new URL(cfg.ttsBaseUrl + '/tts');
            url.searchParams.set('text', text);
            url.searchParams.set('text_lang', textLang);
            url.searchParams.set('ref_audio_path', ref);
            url.searchParams.set('prompt_text', promptText);
            url.searchParams.set('prompt_lang', promptLang);
            url.searchParams.set('text_split_method', cfg.textSplitMethod);
            url.searchParams.set('media_type', cfg.mediaType);
            url.searchParams.set('streaming_mode', 'false');
            let res;
            try {
                res = await fetch(url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
            }
            catch (error) {
                throw new Error('连不上本机 GPT-SoVITS（' + cfg.ttsBaseUrl + '）：' + (error?.message ?? String(error)) +
                    ' —— 先用 voice_local_health 看看端口在不在。');
            }
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error('本地 TTS 失败：HTTP ' + res.status + ' ' + body.slice(0, 200));
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length === 0)
                throw new Error('本地 TTS 返回空音频 —— 检查参考音频路径、prompt_text 与 GPT-SoVITS 日志。');
            mkdirSync(dirname(wavTarget), { recursive: true });
            writeFileSync(wavTarget, buf);

            // Head processing. These two stages are the only writers, and both own
            // the file they just wrote, so they may overwrite it in place.
            const owned = { overwrite: true };
            let trimNote = '未启用';
            if (cfg.trimAspiration) {
                const tr = trimLeadingAspiration(wavTarget, cfg.trimRiseMin, TRIM_HEAD_FLOOR_DB,
                    TRIM_RATIO_DELTA_DB, TRIM_NARROW_DELTA_DB, owned);
                trimNote = tr.trimmed
                    ? '✅ 已裁掉开头吸气：' + tr.oldSeconds.toFixed(2) + 's → ' + tr.newSeconds.toFixed(2) + 's（裁点 ' + tr.cut.toFixed(2) + 's · rise ' + tr.riseTime.toFixed(2) + 's' + (tr.narrow ? ' · 窄通道' : '') + '）'
                    : '无需裁（' + (tr.reason ?? '正常') + '）';
            }

            let headNote = '未启用';
            if (cfg.headAttenuateEnable) {
                const capMs = cfg.headAttenuateMs ?? HEAD_MS;
                const ms = cfg.headAttenuateAdaptive
                    ? adaptiveHeadWindowMs(wavTarget, capMs, cfg.headAttenuateRelDb ?? 6)
                    : capMs;
                if (cfg.headAttenuateAdaptive && ms <= 40) {
                    headNote = '开头即语音起音，未压（自适应窗口）';
                }
                else {
                    const at = attenuateHead(wavTarget, ms, cfg.headAttenuateDb ?? HEAD_GAIN_DB, HEAD_FADE_MS, owned);
                    headNote = at.ok
                        ? '✅ 开头 ' + at.ms + 'ms 已压 ' + at.gainDb + 'dB（自适应窗口）'
                        : '跳过（' + (at.reason ?? '?') + '）';
                }
            }

            let finalPath = wavTarget;
            let formatNote = cfg.mediaType;
            if (wantMp3) {
                const mp3Path = basePath + '.mp3';
                const conv = await convertToMp3(wavTarget, mp3Path, cfg.ffmpegPath);
                if (conv.ok) {
                    finalPath = mp3Path;
                    formatNote = 'mp3（本机 ffmpeg 转）';
                }
                else {
                    formatNote = 'wav（mp3 转换失败：' + (conv.reason ?? '') + '，已保留同名 wav）';
                }
            }

            const wantPlay = bool(args.play, cfg.autoPlay);
            const playResult = wantPlay ? playAudio(wavTarget, cfg) : { played: false, reason: '未请求播放' };
            const finalBytes = (() => {
                try {
                    return statSync(finalPath).size;
                }
                catch {
                    return buf.length;
                }
            })();
            return {
                output: finalPath,
                bytes: finalBytes,
                refAudioPath: ref,
                preset: preset === null ? '(默认)' : preset.id,
                textLang,
                play: playResult.played ? '✅ 已用扬声器播放' : '未播放（' + (playResult.reason ?? '') + '）',
                summary: '本地合成完成：' + finalPath + '\n- 预设：' + (preset === null ? '(默认)' : preset.id + '（' + preset.label + '）') +
                    '\n- 语言：' + textLang + '｜格式：' + formatNote + '｜字节：' + finalBytes + '（合成 wav ' + buf.length + ' B）' +
                    '\n- 开头吸气裁剪：' + trimNote + '\n- 开头气压声：' + headNote +
                    '\n- 参考音频：' + ref + '\n- 播放：' + (playResult.played ? '✅ 已出声' : '未播放（' + (playResult.reason ?? '') + '）'),
            };
        },
    };

    return [health, list, tts];
}

/** Plugin entry point: register the tools and bring the local servers up. Never throws. */
export function apply(ctx, config) {
    try {
        const cfg = resolveConfig(config);
        const disposers = [];
        for (const def of buildTools(cfg)) {
            if (def.name === 'voice_tts_local' && !cfg.ttsEnable)
                continue;
            try {
                disposers.push(ctx.tools.register(def));
            }
            catch (error) {
                console.warn(LOG + '注册工具 ' + def.name + ' 失败：' + (error?.message ?? String(error)));
            }
        }
        let sttChild = null;
        if (cfg.sttEnable) {
            ensureStt(cfg)
                .then((child) => { sttChild = child; })
                .catch((error) => console.warn(LOG + 'STT 拉起异常：' + (error?.message ?? String(error))));
        }
        let ttsChild = null;
        if (cfg.ttsEnable) {
            ensureTts(cfg)
                .then((child) => { ttsChild = child; })
                .catch((error) => console.warn(LOG + 'TTS 拉起异常：' + (error?.message ?? String(error))));
        }
        if (typeof ctx.on === 'function') {
            ctx.on('dispose', () => {
                for (const dispose of disposers) {
                    try {
                        dispose();
                    }
                    catch { /* ignore */ }
                }
                try {
                    sttChild?.kill();
                }
                catch { /* ignore */ }
                try {
                    ttsChild?.kill();
                }
                catch { /* ignore */ }
            });
        }
        console.log(LOG + '已加载：STT 随起=' + cfg.sttEnable + '｜TTS 随起=' + cfg.ttsEnable +
            '｜预设=' + (cfg.presets.length === 0 ? '0' : cfg.presets.map((p) => p.id).join('/')) +
            '｜自动播放=' + cfg.autoPlay + '｜输出目录=' + cfg.outputDir);
    }
    catch (error) {
        console.warn(LOG + '初始化失败（已忽略，不影响 DSH 启动）：' + (error?.message ?? String(error)));
    }
}
