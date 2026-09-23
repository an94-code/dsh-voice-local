// Tests for the file-system wrappers around wav-head-trim.
//
// Every fixture is synthesised in code and written into a fresh directory under
// the system temp dir — no binary sample ships with the repo, no real user file
// is touched, nothing here talks to the network or starts a service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adaptiveHeadWindowMs, attenuateHead, trimLeadingAspiration, writeWavNonDestructive } from '../lib/index.js';
import {
    adaptiveHeadWindowMs as wavAdaptiveHeadWindowMs,
    attenuateHead as wavAttenuateHead,
    trimLeadingAspiration as wavTrimLeadingAspiration,
} from 'wav-head-trim';

const SR = 32000;

// --------------------------------------------------------------------------
// fixture builders (same shape as the wav-head-trim test fixtures)
// --------------------------------------------------------------------------

/** Peak amplitude (0..1) of a full-scale sine whose RMS sits at `db`. */
const ampFromDb = (db) => Math.sqrt(2) * Math.pow(10, db / 20);

/** Canonical 44-byte-header PCM file. */
function wavFile({ sampleRate = SR, channels = 1, bitsPerSample = 16, formatTag = 1, data }) {
    const blockAlign = channels * bitsPerSample / 8;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + data.length, 4);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(formatTag, 20);
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * blockAlign, 28);
    h.writeUInt16LE(blockAlign, 32);
    h.writeUInt16LE(bitsPerSample, 34);
    h.write('data', 36);
    h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

/** Synthesise a mono 16-bit file from a segment list (`db: null` = digital silence). */
function synth(segments, { sampleRate = SR, channels = 1 } = {}) {
    const parts = [];
    for (const s of segments) {
        const n = Math.round(s.sec * sampleRate);
        const buf = Buffer.alloc(n * channels * 2);
        if (s.db !== null && s.db !== undefined) {
            const a = ampFromDb(s.db);
            const f = s.freq ?? 200;
            for (let i = 0; i < n; i++) {
                const v = Math.max(-32768, Math.min(32767,
                    Math.round(32767 * a * Math.sin(2 * Math.PI * f * i / sampleRate))));
                for (let c = 0; c < channels; c++)
                    buf.writeInt16LE(v, (i * channels + c) * 2);
            }
        }
        parts.push(buf);
    }
    return wavFile({ sampleRate, channels, data: Buffer.concat(parts) });
}

const seg = (sec, db, freq) => ({ sec, db, freq });

/** -75 dB = a real pause (near silence, but not digital silence). */
const PAUSE_DB = -75;

/** 3.0 s: 0.20 s of breath at -30 dB, 0.20 s pause, then loud speech. */
const WIDE_ASPIRATION = () => synth([
    seg(0.20, -30), seg(0.20, PAUSE_DB), seg(1.10, -20), seg(1.50, -20),
]);

/** 3.0 s of continuous speech — crisp onset, no valley. */
const CRISP = () => synth([seg(1.50, -20), seg(1.50, -20)]);

/** 2.0 s: 0.40 s of quiet breath, then speech (never rises inside scanMs). */
const QUIET_BREATH = () => synth([seg(0.40, -39), seg(1.60, -20)]);

function tempDir(t) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-local-wav-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** Write `wav` into a fresh temp file and return its path. */
function wavIn(dir, wav, name = 'sample.wav') {
    const file = join(dir, name);
    writeFileSync(file, wav);
    return file;
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            return i;
    return a.length === b.length ? -1 : n;
}

// --------------------------------------------------------------------------
// trimLeadingAspiration
// --------------------------------------------------------------------------

test('trimLeadingAspiration: a crisp onset is left alone and nothing is written', (t) => {
    const dir = tempDir(t);
    const wav = CRISP();
    const file = wavIn(dir, wav);

    const r = trimLeadingAspiration(file);
    assert.equal(r.trimmed, false);
    assert.equal(r.code, 'no-valley');
    assert.equal(typeof r.reason, 'string');
    assert.deepEqual(readFileSync(file), wav, 'the file must be untouched');
    assert.deepEqual(readdirSync(dir), ['sample.wav'], 'no backup, no temp file');
});

test('trimLeadingAspiration: trims like the module and keeps the original as .orig', (t) => {
    const dir = tempDir(t);
    const wav = WIDE_ASPIRATION();
    const file = wavIn(dir, wav);

    const r = trimLeadingAspiration(file);
    const expected = wavTrimLeadingAspiration(wav);

    assert.equal(expected.diag.trimmed, true, 'fixture self-check: this file should be trimmable');
    assert.equal(r.trimmed, true);
    assert.equal(r.code, 'trimmed');
    assert.equal(r.narrow, expected.diag.narrow);
    assert.equal(r.cut, expected.diag.cut);
    assert.equal(r.oldSeconds, expected.diag.oldSeconds);
    assert.equal(r.newSeconds, expected.diag.newSeconds);
    assert.equal(r.riseTime, expected.diag.riseTime);
    assert.equal(r.backup, file + '.orig');

    assert.deepEqual(readFileSync(file), expected.buffer, 'the trimmed bytes are the module output');
    assert.deepEqual(readFileSync(file + '.orig'), wav, 'the backup holds the original bytes');
    assert.deepEqual(readdirSync(dir).sort(), ['sample.wav', 'sample.wav.orig']);
});

test('trimLeadingAspiration: overwrite:true skips the backup', (t) => {
    const dir = tempDir(t);
    const wav = WIDE_ASPIRATION();
    const file = wavIn(dir, wav);

    const r = trimLeadingAspiration(file, 0.30, 35, 8, 5, { overwrite: true });
    assert.equal(r.trimmed, true);
    assert.equal(r.backup, null);
    assert.deepEqual(readdirSync(dir), ['sample.wav']);
    assert.deepEqual(readFileSync(file), wavTrimLeadingAspiration(wav).buffer);
});

test('trimLeadingAspiration: threshold arguments are forwarded to the module', (t) => {
    const dir = tempDir(t);
    const wav = WIDE_ASPIRATION();
    const file = wavIn(dir, wav);

    // riseMin above the measured rise => the module reports a crisp onset.
    const r = trimLeadingAspiration(file, 1.5);
    assert.equal(r.trimmed, false);
    assert.equal(r.code, 'crisp-onset');
    assert.deepEqual(readFileSync(file), wav);
});

test('trimLeadingAspiration: unsupported and unreadable inputs are reported, not thrown', (t) => {
    const dir = tempDir(t);
    const eightBit = wavFile({ bitsPerSample: 8, data: Buffer.alloc(6000, 128) });
    const file = wavIn(dir, eightBit, 'eight-bit.wav');

    const r = trimLeadingAspiration(file);
    assert.equal(r.trimmed, false);
    assert.equal(r.code, 'unsupported-format');
    assert.deepEqual(readFileSync(file), eightBit);
    assert.deepEqual(readdirSync(dir), ['eight-bit.wav']);

    const missing = trimLeadingAspiration(join(dir, 'nope.wav'));
    assert.equal(missing.trimmed, false);
    assert.equal(typeof missing.reason, 'string');
});

// --------------------------------------------------------------------------
// attenuateHead
// --------------------------------------------------------------------------

test('attenuateHead: only the head window changes, and the original is kept', (t) => {
    const dir = tempDir(t);
    const wav = CRISP();
    const file = wavIn(dir, wav);

    const r = attenuateHead(file, 100, -15, 40);
    const expected = wavAttenuateHead(wav, { ms: 100, gainDb: -15, fadeMs: 40 });

    assert.equal(r.ok, true);
    assert.equal(r.ms, 100);
    assert.equal(r.gainDb, -15);
    assert.equal(r.fadeMs, 40);
    assert.equal(r.sampleRate, SR);
    assert.equal(r.changed, true);
    assert.equal(r.samplesPerChannel, 3200);
    assert.equal(r.backup, file + '.orig');

    const out = readFileSync(file);
    assert.deepEqual(out, expected.buffer);
    assert.deepEqual(out.subarray(0, 44), wav.subarray(0, 44), 'header untouched');
    assert.equal(firstDiff(out.subarray(44 + 2 * 3200), wav.subarray(44 + 2 * 3200)), -1, 'tail untouched');
    assert.ok(Math.abs(out.readInt16LE(44 + 10 * 2)) < Math.abs(wav.readInt16LE(44 + 10 * 2)));
    assert.deepEqual(readFileSync(file + '.orig'), wav);
});

test('attenuateHead: a no-op gain leaves the file byte-identical and writes no backup', (t) => {
    const dir = tempDir(t);
    const wav = CRISP();
    const file = wavIn(dir, wav);

    const r = attenuateHead(file, 300, 0, 40);
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.equal(r.backup, null);
    assert.deepEqual(readFileSync(file), wav);
    assert.deepEqual(readdirSync(dir), ['sample.wav']);
});

test('attenuateHead: an unreadable/non-PCM input is reported and never written', (t) => {
    const dir = tempDir(t);
    const eightBit = wavFile({ bitsPerSample: 8, data: Buffer.alloc(6000, 128) });
    const file = wavIn(dir, eightBit, 'eight-bit.wav');

    const r = attenuateHead(file);
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
    assert.deepEqual(readFileSync(file), eightBit);
    assert.deepEqual(readdirSync(dir), ['eight-bit.wav']);

    const missing = attenuateHead(join(dir, 'nope.wav'));
    assert.equal(missing.ok, false);
    assert.equal(typeof missing.reason, 'string');
});

// --------------------------------------------------------------------------
// adaptiveHeadWindowMs
// --------------------------------------------------------------------------

test('adaptiveHeadWindowMs: window decisions match the module', (t) => {
    const dir = tempDir(t);
    const cases = [
        ['speech-at-head.wav', CRISP(), 40],
        ['quiet-breath.wav', QUIET_BREATH(), 300],
    ];
    for (const [n, wav, expected] of cases) {
        const file = wavIn(dir, wav, n);
        const ms = adaptiveHeadWindowMs(file);
        assert.equal(ms, expected, n);
        assert.equal(ms, wavAdaptiveHeadWindowMs(wav), n + ' vs module');
    }
});

test('adaptiveHeadWindowMs: the cap and the guard rails are forwarded', (t) => {
    const dir = tempDir(t);
    const file = wavIn(dir, QUIET_BREATH(), 'q.wav');
    assert.equal(adaptiveHeadWindowMs(file, 200), 200);
    assert.equal(adaptiveHeadWindowMs(file, 300), 300);
});

test('adaptiveHeadWindowMs: unreadable input falls back to maxMs', (t) => {
    const dir = tempDir(t);
    assert.equal(adaptiveHeadWindowMs(join(dir, 'nope.wav')), 300);
    assert.equal(adaptiveHeadWindowMs(join(dir, 'nope.wav'), 120), 120);
});

// --------------------------------------------------------------------------
// writeWavNonDestructive
// --------------------------------------------------------------------------

test('writeWavNonDestructive: keeps the first original, never leaves a temp file', (t) => {
    const dir = tempDir(t);
    const file = join(dir, 'a.wav');
    writeFileSync(file, Buffer.from('AAAA'));

    const b1 = writeWavNonDestructive(file, Buffer.from('BBBB'));
    assert.equal(b1, file + '.orig');
    assert.deepEqual(readFileSync(file), Buffer.from('BBBB'));
    assert.deepEqual(readFileSync(b1), Buffer.from('AAAA'));
    assert.deepEqual(readdirSync(dir).sort(), ['a.wav', 'a.wav.orig']);

    const b2 = writeWavNonDestructive(file, Buffer.from('CCCC'));
    assert.equal(b2, file + '.orig');
    assert.deepEqual(readFileSync(file), Buffer.from('CCCC'));
    assert.deepEqual(readFileSync(b2), Buffer.from('AAAA'), 'the true original is never overwritten');
});

test('writeWavNonDestructive: overwrite:true is an in-place atomic write', (t) => {
    const dir = tempDir(t);
    const file = join(dir, 'a.wav');
    writeFileSync(file, Buffer.from('AAAA'));

    const backup = writeWavNonDestructive(file, Buffer.from('DDDD'), { overwrite: true });
    assert.equal(backup, null);
    assert.deepEqual(readFileSync(file), Buffer.from('DDDD'));
    assert.deepEqual(readdirSync(dir), ['a.wav']);
});

test('writeWavNonDestructive: a custom backup suffix is honoured', (t) => {
    const dir = tempDir(t);
    const file = join(dir, 'a.wav');
    writeFileSync(file, Buffer.from('AAAA'));

    const backup = writeWavNonDestructive(file, Buffer.from('EEEE'), { backupSuffix: '.keep' });
    assert.equal(backup, file + '.keep');
    assert.deepEqual(readFileSync(backup), Buffer.from('AAAA'));
    assert.deepEqual(readdirSync(dir).sort(), ['a.wav', 'a.wav.keep']);
});
