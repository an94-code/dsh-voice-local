// Tests for the pure/configuration layer of dsh-voice-local.
//
// No network, no services, no real user files: everything here either stays in
// memory or works inside a fresh directory under the system temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
    DEFAULTS,
    ENV,
    parsePresets,
    resolveConfig,
    resolveOutputPath,
    validateRefAudio,
} from '../lib/index.js';

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

const ENV_KEYS = Object.values(ENV);

/** Run `fn` with every DSH_VOICE_LOCAL_* variable removed, then restore them. */
function withCleanEnv(fn) {
    const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS)
        delete process.env[k];
    try {
        return fn();
    }
    finally {
        for (const [k, v] of saved) {
            if (v === undefined)
                delete process.env[k];
            else
                process.env[k] = v;
        }
    }
}

function tempDir(t) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-local-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const cfgWith = (outputDir) => ({ outputDir, mediaType: 'wav' });

// --------------------------------------------------------------------------
// resolveConfig
// --------------------------------------------------------------------------

test('resolveConfig: an empty config yields the documented defaults', () => {
    withCleanEnv(() => {
        const cfg = resolveConfig();
        assert.equal(cfg.sttEnable, true);
        assert.equal(cfg.sttCmd, '');
        assert.equal(cfg.sttHealthUrl, 'http://127.0.0.1:9000/health');
        assert.equal(cfg.sttWaitMs, 60000);
        assert.equal(cfg.ttsEnable, true);
        assert.equal(cfg.ttsBaseUrl, 'http://127.0.0.1:9880');
        assert.equal(cfg.ttsCmd, '');
        assert.equal(cfg.ttsWaitMs, 180000);
        assert.equal(cfg.refAudioPath, '');
        assert.equal(cfg.promptText, '');
        assert.equal(cfg.promptLang, 'zh');
        assert.equal(cfg.textLang, 'zh');
        assert.equal(cfg.mediaType, 'wav');
        assert.equal(cfg.textSplitMethod, 'cut5');
        assert.equal(cfg.timeoutMs, 300000);
        assert.equal(cfg.outputDir, DEFAULTS.outputDir);
        assert.deepEqual(cfg.presets, []);
        assert.equal(cfg.autoPlay, false);
        assert.equal(cfg.outFormat, 'wav');
        assert.equal(cfg.ffmpegPath, '');
        assert.equal(cfg.powershellPath, '');
        assert.equal(cfg.trimAspiration, true);
        assert.equal(cfg.trimRiseMin, 0.30);
        assert.equal(cfg.headAttenuateEnable, true);
        assert.equal(cfg.headAttenuateDb, -15);
        assert.equal(cfg.headAttenuateMs, 300);
        assert.equal(cfg.headAttenuateAdaptive, true);
        assert.equal(cfg.headAttenuateRelDb, 6);

        const cfg2 = resolveConfig(null);
        assert.deepEqual(cfg2, cfg);
    });
});

test('resolveConfig: no machine-specific path is baked in', () => {
    withCleanEnv(() => {
        const cfg = resolveConfig({});
        for (const key of ['sttCmd', 'ttsCmd', 'ffmpegPath', 'powershellPath', 'refAudioPath']) {
            assert.equal(cfg[key], '', key + ' must default to empty');
        }
        assert.ok(cfg.outputDir.startsWith(resolve(tmpdir())), 'outputDir sits under the temp dir');
    });
});

test('resolveConfig: invalid values fall back one by one', () => {
    withCleanEnv(() => {
        const cfg = resolveConfig({
            sttEnable: 'yes',
            sttCmd: 42,
            sttHealthUrl: '   ',
            sttWaitMs: -5,
            ttsBaseUrl: 7,
            ttsWaitMs: 0,
            refAudioPath: null,
            promptText: 123,
            promptLang: '',
            mediaType: {},
            timeoutMs: Number.NaN,
            outputDir: '',
            presets: 'not-an-array',
            autoPlay: 'no',
            outFormat: 'FLAC',
            headAttenuateDb: 'loud',
            headAttenuateMs: -300,
            headAttenuateRelDb: -6,
            trimRiseMin: -1,
        });
        assert.equal(cfg.sttEnable, true);
        assert.equal(cfg.sttCmd, '');
        assert.equal(cfg.sttHealthUrl, 'http://127.0.0.1:9000/health');
        assert.equal(cfg.sttWaitMs, 60000);
        assert.equal(cfg.ttsBaseUrl, 'http://127.0.0.1:9880');
        assert.equal(cfg.ttsWaitMs, 180000);
        assert.equal(cfg.refAudioPath, '');
        assert.equal(cfg.promptText, '');
        assert.equal(cfg.promptLang, 'zh');
        assert.equal(cfg.mediaType, 'wav');
        assert.equal(cfg.timeoutMs, 300000);
        assert.equal(cfg.outputDir, DEFAULTS.outputDir);
        assert.deepEqual(cfg.presets, []);
        assert.equal(cfg.autoPlay, false);
        assert.equal(cfg.outFormat, 'wav');
        assert.equal(cfg.headAttenuateDb, -15);
        assert.equal(cfg.headAttenuateMs, 300);
        assert.equal(cfg.headAttenuateRelDb, 6);
        assert.equal(cfg.trimRiseMin, 0.30);
    });
});

test('resolveConfig: explicit values win, including a signed dB gain and upper-case MP3', () => {
    withCleanEnv(() => {
        const cfg = resolveConfig({
            sttEnable: false,
            ttsBaseUrl: 'http://192.168.1.9:9880///',
            outputDir: 'C:\\voices\\out',
            outFormat: 'MP3',
            headAttenuateDb: -21.5,
            headAttenuateEnable: false,
            trimAspiration: false,
            trimRiseMin: 0.45,
            refAudioPath: 'C:\\voices\\me.wav',
        });
        assert.equal(cfg.sttEnable, false);
        assert.equal(cfg.ttsBaseUrl, 'http://192.168.1.9:9880');
        assert.equal(cfg.outputDir, 'C:\\voices\\out');
        assert.equal(cfg.outFormat, 'mp3');
        assert.equal(cfg.headAttenuateDb, -21.5);
        assert.equal(cfg.headAttenuateEnable, false);
        assert.equal(cfg.trimAspiration, false);
        assert.equal(cfg.trimRiseMin, 0.45);
        assert.equal(cfg.refAudioPath, 'C:\\voices\\me.wav');
    });
});

test('resolveConfig: the environment fills empty keys, but config still wins', () => {
    withCleanEnv(() => {
        process.env[ENV.ttsBaseUrl] = 'http://127.0.0.1:9999/';
        process.env[ENV.ttsCmd] = 'C:\\tools\\start-api.cmd';
        process.env[ENV.outputDir] = 'C:\\env-out';
        process.env[ENV.refAudioPath] = 'C:\\env\\ref.wav';

        const fromEnv = resolveConfig({});
        assert.equal(fromEnv.ttsBaseUrl, 'http://127.0.0.1:9999');
        assert.equal(fromEnv.ttsCmd, 'C:\\tools\\start-api.cmd');
        assert.equal(fromEnv.outputDir, 'C:\\env-out');
        assert.equal(fromEnv.refAudioPath, 'C:\\env\\ref.wav');

        const explicit = resolveConfig({ ttsCmd: 'C:\\mine\\start.cmd', ttsBaseUrl: 'http://127.0.0.1:8123' });
        assert.equal(explicit.ttsCmd, 'C:\\mine\\start.cmd');
        assert.equal(explicit.ttsBaseUrl, 'http://127.0.0.1:8123');
        assert.equal(explicit.outputDir, 'C:\\env-out', 'untouched keys still come from the environment');
    });
});

// --------------------------------------------------------------------------
// parsePresets
// --------------------------------------------------------------------------

test('parsePresets: rejects non-arrays and entries missing id or refAudioPath', () => {
    assert.deepEqual(parsePresets(undefined), []);
    assert.deepEqual(parsePresets(null), []);
    assert.deepEqual(parsePresets({ id: 'zh' }), []);
    assert.deepEqual(parsePresets([null, 'zh', 7, {}]), []);
    assert.deepEqual(parsePresets([{ id: 'zh' }]), []);
    assert.deepEqual(parsePresets([{ refAudioPath: 'C:\\a.wav' }]), []);
    assert.deepEqual(parsePresets([{ id: '  ', refAudioPath: 'C:\\a.wav' }]), []);
});

test('parsePresets: fills every optional field independently', () => {
    const out = parsePresets([
        { id: 'zh', refAudioPath: 'C:\\a.wav', promptText: 'hi' },
        { id: 'ja', label: 'Japanese', emotion: 'calm', refAudioPath: 'C:\\b.wav', promptLang: 'ja' },
        { id: 'ko', refAudioPath: 'C:\\c.wav', promptLang: 'ko', textLang: 'ko' },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], {
        id: 'zh',
        label: 'zh',
        emotion: '',
        lang: 'zh',
        refAudioPath: 'C:\\a.wav',
        promptText: 'hi',
        textLang: 'zh',
    });
    assert.equal(out[1].label, 'Japanese');
    assert.equal(out[1].emotion, 'calm');
    assert.equal(out[1].lang, 'ja');
    assert.equal(out[1].textLang, 'ja', 'textLang follows promptLang');
    assert.equal(out[1].promptText, '');
    assert.equal(out[2].lang, 'ko');
    assert.equal(out[2].textLang, 'ko');
});

// --------------------------------------------------------------------------
// resolveOutputPath
// --------------------------------------------------------------------------

test('resolveOutputPath: the default name lands inside outputDir', (t) => {
    const dir = tempDir(t);
    const cfg = cfgWith(dir);
    for (const requested of [undefined, '', '   ']) {
        const p = resolveOutputPath(requested, cfg);
        assert.ok(p.startsWith(resolve(dir)), p);
        assert.match(p, /tts_\d{14}\.wav$/);
    }
    const mp3 = resolveOutputPath(undefined, { outputDir: dir, mediaType: 'mp3' });
    assert.match(mp3, /tts_\d{14}\.mp3$/);
});

test('resolveOutputPath: relative requests resolve against outputDir', (t) => {
    const dir = tempDir(t);
    const cfg = cfgWith(dir);
    assert.equal(resolveOutputPath('a.wav', cfg), resolve(dir, 'a.wav'));
    assert.equal(resolveOutputPath('sub/deep/a.mp3', cfg), resolve(dir, 'sub', 'deep', 'a.mp3'));
});

test('resolveOutputPath: absolute requests are allowed only inside outputDir', (t) => {
    const dir = tempDir(t);
    const cfg = cfgWith(dir);
    const inside = resolve(dir, 'sub', 'a.wav');
    assert.equal(resolveOutputPath(inside, cfg), inside);
    assert.equal(resolveOutputPath(dir, cfg), resolve(dir), 'outputDir itself is allowed');
});

test('resolveOutputPath: escaping requests are rejected', (t) => {
    const dir = tempDir(t);
    const cfg = cfgWith(dir);
    for (const bad of [
        '..\\escape.wav',
        '../escape.wav',
        'sub/../../escape.wav',
        resolve(dir, '..', 'escape.wav'),
        resolve(dir, '..', 'dsh-voice-local-sibling', 'escape.wav'),
        join(dir + '-sibling', 'escape.wav'),
        resolve(tmpdir(), 'escape.wav'),
    ]) {
        assert.throws(() => resolveOutputPath(bad, cfg), /越界/, 'should reject ' + bad);
    }
});

test('resolveOutputPath: an empty outputDir falls back to the default directory', () => {
    withCleanEnv(() => {
        const p = resolveOutputPath('x.wav', { outputDir: '', mediaType: 'wav' });
        assert.equal(p, resolve(DEFAULTS.outputDir, 'x.wav'));
    });
});

// --------------------------------------------------------------------------
// validateRefAudio
// --------------------------------------------------------------------------

test('validateRefAudio: rejects empty, unsupported, missing and tiny files', (t) => {
    const dir = tempDir(t);
    assert.equal(validateRefAudio('').ok, false);
    assert.equal(validateRefAudio(undefined).ok, false);
    assert.equal(validateRefAudio(join(dir, 'a.txt')).ok, false);
    assert.equal(validateRefAudio(join(dir, 'noext')).ok, false);
    assert.match(validateRefAudio(join(dir, 'a.txt')).reason, /扩展名/);
    assert.match(validateRefAudio(join(dir, 'missing.wav')).reason, /不存在/);

    const tiny = join(dir, 'tiny.wav');
    writeFileSync(tiny, Buffer.alloc(10, 1));
    const tinyCheck = validateRefAudio(tiny);
    assert.equal(tinyCheck.ok, false);
    assert.match(tinyCheck.reason, /过小/);

    const aDir = join(dir, 'a-directory.wav');
    mkdirSync(aDir);
    assert.equal(validateRefAudio(aDir).ok, false);
});

test('validateRefAudio: accepts a plausible clip and returns its absolute path', (t) => {
    const dir = tempDir(t);
    const ref = join(dir, 'voice.wav');
    writeFileSync(ref, Buffer.alloc(4096, 7));
    const check = validateRefAudio(ref);
    assert.equal(check.ok, true);
    assert.equal(check.path, resolve(ref));
    assert.equal(check.bytes, 4096);
    assert.equal(validateRefAudio('  ' + ref + '  ').ok, true, 'surrounding blanks are trimmed');
});
