#!/usr/bin/env node
/**
 * Compare this plugin's head-processing wrappers against a reference
 * implementation, file by file, byte for byte.
 *
 * The reference is the original plugin version whose algorithm has since been
 * extracted into `wav-head-trim`. It exposes the same three functions, but they
 * take a **file path** and rewrite the file in place — so every input is copied
 * into a fresh directory under the system temp dir first, and the corpus itself
 * is only ever read. The temp directory is removed at the end.
 *
 * Usage:
 *
 *   node tools/compare-with-original.mjs <corpus-dir> [<corpus-dir> ...]
 *        [--original <path-to-lib/index.js>] [--limit <n>]
 *
 * The reference module is auto-detected inside the current user's DSH profile
 * (`~/.dsh/profiles/<profile>/local-plugins/dsh-voice-local/lib/index.js`, or
 * `$DSH_HOME` when set); override it with `--original` or the
 * `DSH_VOICE_LOCAL_ORIGINAL` environment variable. No path is hard-coded.
 *
 * Exit code: 0 when every file matches, 1 on any difference or error.
 */
import {
    copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as neutral from '../lib/index.js';

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const limit = flag('--limit') === undefined ? Infinity : Number(flag('--limit'));
const corpora = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--original' && argv[i - 1] !== '--limit');

if (corpora.length === 0) {
    console.error('usage: node tools/compare-with-original.mjs <corpus-dir> [...] [--original <file>] [--limit <n>]');
    process.exit(2);
}

/** Locate the reference implementation without hard-coding anybody's path. */
function autoDetectOriginal() {
    const fromEnv = process.env.DSH_VOICE_LOCAL_ORIGINAL;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && existsSync(fromEnv))
        return fromEnv;
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh');
    const profiles = join(home, 'profiles');
    if (!existsSync(profiles))
        return null;
    for (const profile of readdirSync(profiles)) {
        const candidate = join(profiles, profile, 'local-plugins', 'dsh-voice-local', 'lib', 'index.js');
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}

function walkWavs(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory())
            walkWavs(full, out);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.wav'))
            out.push(full);
    }
    return out;
}

/** Run the historical pipeline (in place) and keep the decision fields. */
function runOriginal(mod, file) {
    const trim = mod.trimLeadingAspiration(file, 0.30);
    const windowMs = mod.adaptiveHeadWindowMs(file, 300, 6, 20, 500, 40);
    const head = windowMs > 40 ? mod.attenuateHead(file, windowMs, -15, 40) : null;
    return {
        trimmed: trim.trimmed === true,
        narrow: trim.narrow ?? null,
        cut: trim.cut ?? null,
        riseTime: trim.riseTime ?? null,
        oldSeconds: trim.oldSeconds ?? null,
        newSeconds: trim.newSeconds ?? null,
        windowMs,
        headOk: head === null ? null : head.ok === true,
        headMs: head?.ms ?? null,
        headGainDb: head?.gainDb ?? null,
        headSkipped: head === null,
    };
}

/** Run the same pipeline through the neutral wrappers (caller owns the copy). */
function runNeutral(mod, file) {
    const owned = { overwrite: true };
    const trim = mod.trimLeadingAspiration(file, 0.30, 35, 8, 5, owned);
    const windowMs = mod.adaptiveHeadWindowMs(file, 300, 6, 20, 500, 40);
    const head = windowMs > 40 ? mod.attenuateHead(file, windowMs, -15, 40, owned) : null;
    return {
        trimmed: trim.trimmed === true,
        narrow: trim.narrow ?? null,
        cut: trim.cut ?? null,
        riseTime: trim.riseTime ?? null,
        oldSeconds: trim.oldSeconds ?? null,
        newSeconds: trim.newSeconds ?? null,
        windowMs,
        headOk: head === null ? null : head.ok === true,
        headMs: head?.ms ?? null,
        headGainDb: head?.gainDb ?? null,
        headSkipped: head === null,
    };
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            return i;
    return a.length === b.length ? -1 : n;
}

const originalPath = flag('--original') ?? autoDetectOriginal();
if (originalPath === null || originalPath === undefined) {
    console.error('could not locate the reference implementation — pass --original <file>');
    process.exit(2);
}
const original = await import(pathToFileURL(resolve(originalPath)).href);
for (const fn of ['trimLeadingAspiration', 'attenuateHead', 'adaptiveHeadWindowMs']) {
    if (typeof original[fn] !== 'function') {
        console.error('reference implementation does not export ' + fn + '()');
        process.exit(2);
    }
}

const files = [];
for (const dir of corpora) {
    if (!existsSync(dir)) {
        console.error('corpus not found: ' + dir);
        process.exit(2);
    }
    files.push(...walkWavs(dir));
    if (files.length >= limit)
        break;
}
const selected = files.slice(0, limit === Infinity ? undefined : limit);
if (selected.length === 0) {
    console.error('no .wav files found in: ' + corpora.join(', '));
    process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'dsh-voice-local-compare-'));
const dirA = join(work, 'original');
const dirB = join(work, 'neutral');
mkdirSync(dirA);
mkdirSync(dirB);

console.log('dsh-voice-local · compare head processing with the reference implementation');
console.log('reference      : ' + resolve(originalPath));
console.log('corpus         : ' + corpora.length + ' director(y|ies)');
console.log('files compared : ' + selected.length + (limit === Infinity ? '' : ' (limited)'));
console.log('temp copies    : ' + work);
console.log('');

let byteIdentical = 0;
let mismatches = 0;
const rows = [];

try {
    let index = 0;
    for (const src of selected) {
        index += 1;
        const name = String(index).padStart(3, '0') + '_' + basename(src);
        const a = join(dirA, name);
        const b = join(dirB, name);
        copyFileSync(src, a);
        copyFileSync(src, b);

        const originalNotes = runOriginal(original, a);
        const neutralNotes = runNeutral(neutral, b);

        const bytesA = readFileSync(a);
        const bytesB = readFileSync(b);
        const diff = firstDiff(bytesA, bytesB);
        const bytesEqual = diff === -1;
        const decisionEqual = JSON.stringify(originalNotes) === JSON.stringify(neutralNotes);

        if (bytesEqual)
            byteIdentical += 1;
        if (!bytesEqual || !decisionEqual)
            mismatches += 1;

        rows.push({
            file: basename(src),
            srcBytes: statSync(src).size,
            outBytesOriginal: bytesA.length,
            outBytesNeutral: bytesB.length,
            bytesEqual,
            firstDiff: diff,
            decisionEqual,
            originalNotes,
            neutralNotes,
        });
    }
}
finally {
    try {
        rmSync(work, { recursive: true, force: true });
    }
    catch { /* ignore */ }
}

for (const row of rows) {
    const mark = row.bytesEqual && row.decisionEqual ? 'OK  ' : 'DIFF';
    console.log(mark + ' ' + row.file +
        '  bytes ' + row.srcBytes + ' -> ' + row.outBytesOriginal + '/' + row.outBytesNeutral +
        '  trim=' + row.originalNotes.trimmed + ' window=' + row.originalNotes.windowMs + 'ms' +
        (row.bytesEqual ? '' : '  firstByteDiff=' + row.firstDiff));
    if (!row.decisionEqual) {
        console.log('     original: ' + JSON.stringify(row.originalNotes));
        console.log('     neutral : ' + JSON.stringify(row.neutralNotes));
    }
}

console.log('');
console.log('result: ' + rows.length + ' file(s) / byte-identical ' + byteIdentical +
    ' / mismatched ' + mismatches);
console.log('temp copies removed: ' + !existsSync(work));
process.exit(mismatches === 0 ? 0 : 1);
