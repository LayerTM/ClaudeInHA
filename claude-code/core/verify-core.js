#!/usr/bin/env node
'use strict';

/*
 * Consumer-side verifier for an ha-agent-core release archive.
 *
 * A consumer pins one release in a lock file it keeps in its own repository:
 *
 *   { "lockVersion": 1, "version": "X.Y.Z", "commit": "<40 hex>",
 *     "url": "https://.../releases/download/vX.Y.Z/ha-agent-core-X.Y.Z.tar",
 *     "sha256": "<64 hex>", "adapterApi": N }
 *
 * and, at build time, downloads that URL to a file and runs `install`. Nothing is
 * written to the destination unless every check below passes, in this order:
 *
 *   1. the lock is well formed: exactly the keys above, each in its exact shape;
 *   2. the lock does not re-point an already pinned version (with --previous-lock);
 *   3. the adapter API the consumer speaks is the one the lock pins;
 *   4. the archive's SHA-256 equals the pinned digest — the only source of the
 *      expected digest is the lock; nothing downloaded next to the archive is read;
 *   5. the archive is a plain ustar stream of regular files under one root, with no
 *      links, no special entries, no absolute or climbing paths, no duplicates (also
 *      by case), no file/directory collisions and nothing after the end marker;
 *   6. the manifest inside the archive names the pinned version, commit and adapter
 *      API, and lists exactly the files present, with their modes, sizes and digests;
 *   7. the destination does not exist yet — an installed core is never overlaid.
 *
 * Any doubt is a refusal (exit 1). This file has no dependencies on purpose: a
 * consumer copies it into its own repository and reviews it there, so the code that
 * decides whether to trust an archive never arrives inside that archive.
 *
 * Usage:
 *   verify-core.js url     --lock FILE
 *   verify-core.js check   --lock FILE --adapter-api N [--previous-lock FILE]
 *   verify-core.js install --lock FILE --adapter-api N [--previous-lock FILE]
 *                          --archive FILE --dest DIR
 *   verify-core.js check-assembly --core DIR --consumer DIR
 *     (the add-on's app/, ha-tools/ and rootfs/ share no path with the installed
 *     core, and add nothing under a directory the core owns whole)
 * Exit: 0 verified, 1 refused, 2 usage error.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const ROOT = 'ha-agent-core';
const MANIFEST_NAME = 'core-manifest.json';
const LOCK_VERSION = 1;
const LOCK_KEYS = ['adapterApi', 'commit', 'lockVersion', 'sha256', 'url', 'version'];
const MANIFEST_KEYS = ['adapterApi', 'commit', 'files', 'name', 'version'];
const FILE_KEYS = ['mode', 'path', 'sha256', 'size'];
const MODES = new Set([0o644, 0o755]);
const LIMITS = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  entries: 20000,
});

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BLOCK = 512;

class Refusal extends Error {}

function refuse(message) {
  throw new Refusal(message);
}

function archiveName(version) {
  return `${ROOT}-${version}.tar`;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value, keys, what) {
  if (!isPlainObject(value)) refuse(`${what} is not a JSON object`);
  const actual = Object.keys(value).sort();
  const missing = keys.filter((k) => !actual.includes(k));
  const unknown = actual.filter((k) => !keys.includes(k));
  if (missing.length) refuse(`${what} is missing: ${missing.join(', ')}`);
  if (unknown.length) refuse(`${what} has unknown keys: ${unknown.join(', ')}`);
}

function isApiVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return refuse(`${what} is not valid JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

function parseLock(text) {
  const lock = parseJson(text, 'lock');
  requireExactKeys(lock, LOCK_KEYS, 'lock');
  if (lock.lockVersion !== LOCK_VERSION) {
    refuse(`lock.lockVersion is ${JSON.stringify(lock.lockVersion)}, this verifier reads ${LOCK_VERSION}`);
  }
  if (typeof lock.version !== 'string' || !SEMVER.test(lock.version)) {
    refuse(`lock.version ${JSON.stringify(lock.version)} is not a release version (X.Y.Z)`);
  }
  if (typeof lock.commit !== 'string' || !HEX40.test(lock.commit)) {
    refuse('lock.commit is not a full lowercase commit id');
  }
  if (typeof lock.sha256 !== 'string' || !HEX64.test(lock.sha256)) {
    refuse('lock.sha256 is not a lowercase SHA-256 digest');
  }
  if (!isApiVersion(lock.adapterApi)) {
    refuse('lock.adapterApi is not a positive integer');
  }
  checkUrl(lock.url, lock.version);
  return Object.freeze({ ...lock });
}

// The URL must name the release asset of exactly the pinned version: an https
// release-download path ending in vX.Y.Z/ha-agent-core-X.Y.Z.tar, with no
// credentials, query or fragment that could make the same text fetch something else.
function checkUrl(url, version) {
  if (typeof url !== 'string') refuse('lock.url is not a string');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    refuse('lock.url is not a URL');
  }
  if (parsed.href !== url) refuse('lock.url is not in canonical form');
  if (parsed.protocol !== 'https:') refuse('lock.url is not https');
  if (parsed.username || parsed.password) refuse('lock.url carries credentials');
  if (parsed.search || parsed.hash || url.includes('?') || url.includes('#')) {
    refuse('lock.url carries a query or fragment');
  }
  const tail = `/releases/download/v${version}/${archiveName(version)}`;
  if (!parsed.pathname.endsWith(tail) || parsed.pathname.length === tail.length) {
    refuse(`lock.url does not end in ${tail}`);
  }
}

// A published version names one archive forever. A lock change that keeps the
// version and changes anything else is a replacement, and is refused.
function checkTransition(previous, next) {
  if (previous.version !== next.version) return;
  const changed = LOCK_KEYS.filter((k) => previous[k] !== next[k]);
  if (changed.length) {
    refuse(`version ${next.version} is already pinned; this lock changes ${changed.join(', ')} ` +
      'without changing the version — a release is never replaced, publish a new version');
  }
}

function checkAdapterApi(lock, adapterApi) {
  if (!isApiVersion(adapterApi)) refuse('the consumer adapter API is not a positive integer');
  if (lock.adapterApi !== adapterApi) {
    refuse(`the lock pins adapter API ${lock.adapterApi}, this consumer speaks ${adapterApi}`);
  }
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

function isZero(buf) {
  for (const byte of buf) if (byte !== 0) return false;
  return true;
}

function readString(header, offset, length, what) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const bytes = nul === -1 ? field : field.subarray(0, nul);
  if (nul !== -1 && !isZero(field.subarray(nul))) refuse(`${what}: bytes after the terminator`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${what}: not UTF-8`);
  return text;
}

function readOctal(header, offset, length, what) {
  const raw = header.subarray(offset, offset + length).toString('latin1');
  const match = /^ *([0-7]+)[ \0]*$/.exec(raw);
  if (!match) refuse(`${what}: malformed number`);
  const value = parseInt(match[1], 8);
  if (!Number.isSafeInteger(value)) refuse(`${what}: number out of range`);
  return value;
}

function checkHeaderSum(header, where) {
  const stored = readOctal(header, 148, 8, `${where} checksum`);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (sum !== stored) refuse(`${where}: header checksum mismatch`);
}

function checkEntryPath(entryPath) {
  if (/[\p{Cc}\\]/u.test(entryPath)) refuse(`${JSON.stringify(entryPath)}: forbidden character`);
  if (entryPath.normalize('NFC') !== entryPath) refuse(`${JSON.stringify(entryPath)}: not NFC-normalised`);
  const segments = entryPath.split('/');
  if (segments[0] !== ROOT || segments.length < 2) {
    refuse(`${JSON.stringify(entryPath)}: outside the ${ROOT}/ root`);
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      refuse(`${JSON.stringify(entryPath)}: empty, '.' or '..' path segment`);
    }
  }
}

// Every path and every directory implied by it, keyed case-insensitively, must
// mean one thing: a file here and a directory there (or two spellings of one name)
// would overlay each other on some filesystem.
function checkCollisions(entries) {
  const seen = new Map();
  const claim = (spelling, kind) => {
    const key = spelling.toLowerCase();
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, { spelling, kind });
      return;
    }
    if (prior.kind === 'file' || kind === 'file' || prior.spelling !== spelling) {
      refuse(`${JSON.stringify(spelling)} collides with ${JSON.stringify(prior.spelling)}`);
    }
  };
  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let i = 2; i < segments.length; i += 1) claim(segments.slice(0, i).join('/'), 'dir');
    claim(entry.path, 'file');
  }
}

function parseTar(tar) {
  if (tar.length % BLOCK !== 0) refuse('archive is not a whole number of tar blocks');
  const entries = [];
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > tar.length) refuse('archive ends without an end-of-archive marker');
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZero(header)) {
      if (offset + 2 * BLOCK > tar.length) refuse('archive ends inside the end-of-archive marker');
      if (!isZero(tar.subarray(offset))) refuse('data after the end-of-archive marker');
      break;
    }
    const where = `entry ${entries.length + 1}`;
    checkHeaderSum(header, where);
    if (header.subarray(257, 265).toString('latin1') !== 'ustar\x0000') refuse(`${where}: not a ustar header`);
    const type = header[156];
    if (type !== 0x30 && type !== 0) {
      refuse(`${where}: entry type ${JSON.stringify(String.fromCharCode(type))} — only regular files are accepted`);
    }
    if (readString(header, 157, 100, `${where} link name`) !== '') refuse(`${where}: regular file with a link name`);
    const name = readString(header, 0, 100, `${where} name`);
    const prefix = readString(header, 345, 155, `${where} prefix`);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    checkEntryPath(entryPath);
    const mode = readOctal(header, 100, 8, `${entryPath} mode`);
    if (!MODES.has(mode)) refuse(`${entryPath}: mode ${mode.toString(8)} is neither 644 nor 755`);
    const size = readOctal(header, 124, 12, `${entryPath} size`);
    offset += BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + padded > tar.length) refuse(`${entryPath}: truncated`);
    if (!isZero(tar.subarray(offset + size, offset + padded))) refuse(`${entryPath}: non-zero padding`);
    entries.push({ path: entryPath, mode, size, data: tar.subarray(offset, offset + size) });
    if (entries.length > LIMITS.entries) refuse('archive has too many entries');
    offset += padded;
  }
  checkCollisions(entries);
  return entries;
}

function checkManifest(entries, lock) {
  const manifestPath = `${ROOT}/${MANIFEST_NAME}`;
  const manifestEntry = entries.find((e) => e.path === manifestPath);
  if (!manifestEntry) refuse(`archive has no ${manifestPath}`);
  const manifest = parseJson(manifestEntry.data.toString('utf8'), 'manifest');
  requireExactKeys(manifest, MANIFEST_KEYS, 'manifest');
  if (manifest.name !== ROOT) refuse(`manifest.name is ${JSON.stringify(manifest.name)}, not ${ROOT}`);
  for (const key of ['version', 'commit', 'adapterApi']) {
    if (manifest[key] !== lock[key]) {
      refuse(`manifest.${key} is ${JSON.stringify(manifest[key])}, the lock pins ${JSON.stringify(lock[key])}`);
    }
  }
  if (!Array.isArray(manifest.files)) refuse('manifest.files is not a list');
  const present = new Map(entries.filter((e) => e !== manifestEntry).map((e) => [e.path, e]));
  if (manifest.files.length !== present.size) {
    refuse(`manifest lists ${manifest.files.length} files, the archive holds ${present.size}`);
  }
  const listed = new Set();
  for (const file of manifest.files) {
    requireExactKeys(file, FILE_KEYS, 'manifest file entry');
    const full = `${ROOT}/${file.path}`;
    const entry = present.get(full);
    if (!entry || listed.has(full)) refuse(`manifest entry ${JSON.stringify(file.path)} does not match the archive`);
    listed.add(full);
    if (file.mode !== entry.mode || file.size !== entry.size || file.sha256 !== sha256(entry.data)) {
      refuse(`${full}: mode, size or digest differs from the manifest`);
    }
  }
  return manifest;
}

// Everything that can be decided from the bytes alone. Returns the entries only
// when the archive is exactly what the lock pins.
function inspectArchive(archive, lock) {
  if (archive.length > LIMITS.archiveBytes) refuse('archive exceeds the size limit');
  const actual = sha256(archive);
  if (actual !== lock.sha256) refuse(`digest mismatch: the lock pins ${lock.sha256}, the archive is ${actual}`);
  const entries = parseTar(archive);
  checkManifest(entries, lock);
  return entries;
}

function readFileBounded(file, limit, what) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    refuse(`${what} cannot be read: ${err.message}`);
  }
  if (!stat.isFile()) refuse(`${what} is not a regular file`);
  if (stat.size > limit) refuse(`${what} exceeds the size limit`);
  return fs.readFileSync(file);
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

// The destination is claimed first with an exclusive mkdir, which fails if
// anything already exists there — however recently it appeared. The tree is
// written into a fresh sibling directory and renamed onto that claim: rename
// replaces a directory only while it is empty, so content that someone else put
// at the destination is never replaced, and the destination is either the empty
// claim or the complete, verified tree.
function extract(entries, dest) {
  const target = path.resolve(dest);
  const parent = path.dirname(target);
  if (!fs.statSync(parent).isDirectory()) refuse(`${parent} is not a directory`);
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (err) {
    if (err.code === 'EEXIST') refuse(`${target} already exists — an installed core is never overlaid`);
    throw err;
  }
  const claim = fs.lstatSync(target);
  let staging;
  try {
    staging = fs.mkdtempSync(path.join(parent, `.${ROOT}-staging-`));
    // Directories are 755 whatever the umask or mkdtemp chose: the tree is read
    // by whichever user the consumer's service runs as.
    const dirs = new Set([staging]);
    for (const entry of entries) {
      const out = path.join(staging, entry.path.slice(ROOT.length + 1));
      if (!out.startsWith(staging + path.sep)) refuse(`${entry.path}: resolves outside the destination`);
      for (let dir = path.dirname(out); dir !== staging; dir = path.dirname(dir)) dirs.add(dir);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, entry.data, { flag: 'wx', mode: entry.mode });
      fs.chmodSync(out, entry.mode);
    }
    for (const dir of dirs) fs.chmodSync(dir, 0o755);
    try {
      fs.renameSync(staging, target);
    } catch (err) {
      if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || err.code === 'ENOTDIR') {
        refuse(`${target} was filled by someone else during installation — an installed core is never overlaid`);
      }
      throw err;
    }
    staging = undefined;
  } catch (err) {
    if (staging !== undefined) fs.rmSync(staging, { recursive: true, force: true });
    // Only our own, still-empty claim is removed; anything else stays as found.
    try {
      if (sameInode(fs.lstatSync(target), claim)) fs.rmdirSync(target);
    } catch {
      // Gone, replaced or no longer empty: not ours to remove.
    }
    throw err;
  }
  return target;
}

function loadLocks({ lock, previousLock }) {
  const current = parseLock(readFileBounded(lock, 64 * 1024, 'lock').toString('utf8'));
  if (previousLock !== undefined) {
    const previous = parseLock(readFileBounded(previousLock, 64 * 1024, 'previous lock').toString('utf8'));
    checkTransition(previous, current);
  }
  return current;
}

function install({ lock, previousLock, adapterApi, archive, dest }) {
  const current = loadLocks({ lock, previousLock });
  checkAdapterApi(current, adapterApi);
  const entries = inspectArchive(readFileBounded(archive, LIMITS.archiveBytes, 'archive'), current);
  const target = extract(entries, dest);
  return { version: current.version, files: entries.length, dest: target };
}

// ---------------------------------------------------------------------------
// Assembly: an add-on's own files next to an installed core
// ---------------------------------------------------------------------------

// The trees an add-on image is assembled from. A path is claimed by the core or
// by the add-on, never by both (also not by letter case): the add-on may not put
// a file where the core has a file or a directory, nor a directory where the core
// has a file, and it has nothing at all at or under a directory the core owns
// whole. Links and special files count as files — a copy would place them.
const ASSEMBLY_ROOTS = ['app', 'ha-tools', 'rootfs'];
const CORE_ONLY_DIRS = ['app/server'];

// Every entry of the add-on's assembled roots, directories included, as
// { rel, kind } with kind one of dir, file, link, other.
function consumerEntries(consumer) {
  const found = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(consumer, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        found.push({ rel: child, kind: 'dir' });
        walk(child);
      } else {
        const kind = entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : 'other';
        found.push({ rel: child, kind });
      }
    }
  };
  for (const root of ASSEMBLY_ROOTS) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(consumer, root));
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!stat.isDirectory()) {
      found.push({ rel: root, kind: stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'other' });
      continue;
    }
    walk(root);
  }
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Shipped scripts: does what a script names exist in the ASSEMBLED tree?
// ---------------------------------------------------------------------------

// A shipped `package.json` keeps the scripts `haAgentCore.unshippedScripts` does
// not drop, and nine of the ten that ship today name files the ADD-ON supplies —
// its tests, its lint and type configuration. The archive therefore cannot answer
// whether they resolve; only a tree with both halves can, which is here.
//
// THE RULE, stated rather than felt, because a heuristic that under-matches makes
// this check vacuous while it reads green. A command is split on whitespace, each
// word is unquoted, and a word is a CLAIM ABOUT THE TREE when all of these hold:
//
//   * it does not begin with `-` (an option, not a path);
//   * it is not a shell operator (`|`, `||`, `&&`, `;`, `&`, a redirection);
//   * it has no `://` (a URL is not in the tree);
//   * it does not begin with `/` or `~` (an absolute path is not in the tree);
//   * and it either contains `/` or ends in .js .mjs .cjs .sh .json .ts.
//
// Everything else is left alone, DELIBERATELY: `eslint .` names no path by this
// rule, and its real dependency (the add-on's `eslint.config.js`) is named by
// nothing at all, so this check says nothing about `lint`. That silence is the
// rule's limit, and it is held by a test rather than by this comment.
//
// A claim with `*` or `?` must match at least one entry; any other claim must be
// a file in the tree. The word after `npm run` is a claim of a different kind: a
// script of the same manifest, which must still be declared there — a chain the
// list broke is a break at assembly too.
const CLAIM_SUFFIX = /\.(?:js|mjs|cjs|sh|json|ts)$/;
const OPERATORS = new Set(['|', '||', '&&', ';', '&', '>', '>>', '<']);
const GLOB_CHARS = /[*?]/;

function unquote(word) {
  return word.replace(/^["']|["']$/g, '');
}

// The words of one command, unquoted and without the operators.
function words(command) {
  return String(command).split(/\s+/).filter(Boolean).map(unquote).filter((w) => !OPERATORS.has(w));
}

function isTreeClaim(word) {
  if (!word || word.startsWith('-')) return false;
  if (word.includes('://')) return false;
  if (word.startsWith('/') || word.startsWith('~')) return false;
  return word.includes('/') || CLAIM_SUFFIX.test(word);
}

// The scripts one command asks npm to run: the first non-option word after
// `npm run`, for each occurrence.
function runClaims(command) {
  const list = words(command);
  const names = [];
  for (let i = 0; i < list.length - 1; i += 1) {
    if (list[i] !== 'npm' || list[i + 1] !== 'run') continue;
    const name = list.slice(i + 2).filter((w) => !w.startsWith('-'))[0];
    if (name) names.push(name);
  }
  return names;
}

// `app/test/**/*.test.js` -> /^app\/test\/(?:.*\/)?[^/]*\.test\.js$/
// `**` crosses directories, `*` and `?` do not, and `/**/` also matches none.
function globToRegExp(claim) {
  let out = '';
  for (let i = 0; i < claim.length; i += 1) {
    const c = claim[i];
    if (c === '*' && claim[i + 1] === '*') {
      if (claim.slice(i - 1, i + 3) === '/**/') { out = `${out.slice(0, -1)}/(?:.*/)?`; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// Every shipped manifest INSIDE the assembly roots, and only those: outside them
// `consumerEntries` walks nothing, so the add-on's half of the tree is unknown
// and a resolution check would be the archive-as-oracle mistake again — one half
// pretending to be the answer. The core's own root `package.json` is therefore
// not checked here, and a test holds that too.
function assembledManifests(manifestFiles) {
  return manifestFiles
    .map((f) => f.path)
    .filter((rel) => path.basename(rel) === 'package.json'
      && ASSEMBLY_ROOTS.includes(rel.split('/')[0]));
}

// Refuses when a shipped script names something neither half of the assembled
// tree has. `tree` is the lower-cased set of files from both halves.
function checkShippedScripts({ core, manifest, tree }) {
  const problems = [];
  let scripts = 0;
  let claims = 0;
  for (const rel of assembledManifests(manifest.files)) {
    const file = path.join(core, rel);
    const parsed = parseJson(readFileBounded(file, 1024 * 1024, `shipped ${rel}`).toString('utf8'), `shipped ${rel}`);
    const declared = isPlainObject(parsed.scripts) ? parsed.scripts : {};
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    for (const [name, command] of Object.entries(declared)) {
      if (typeof command !== 'string') continue;
      scripts += 1;
      for (const claim of words(command).filter(isTreeClaim)) {
        claims += 1;
        const full = dir ? `${dir}/${claim}` : claim;
        const lower = full.toLowerCase();
        let resolved;
        if (GLOB_CHARS.test(claim)) {
          const re = globToRegExp(lower);
          resolved = false;
          for (const entry of tree) if (re.test(entry)) { resolved = true; break; }
        } else {
          resolved = tree.has(lower);
        }
        if (!resolved) {
          problems.push(`${rel} script ${JSON.stringify(name)} runs ${claim}, and the assembled tree has no ${full}`);
        }
      }
      for (const wanted of runClaims(command)) {
        if (!Object.hasOwn(declared, wanted)) {
          problems.push(`${rel} script ${JSON.stringify(name)} runs the script ${JSON.stringify(wanted)}, which ${rel} does not declare`);
        }
      }
    }
  }
  if (problems.length) {
    refuse(`a shipped script names what the assembled tree does not have:\n  ${problems.join('\n  ')}\n`
      + '  supply the file, or have the core drop the script in haAgentCore.unshippedScripts');
  }
  return { scripts, claims };
}

function checkAssembly({ core, consumer }) {
  const manifestFile = path.join(core, MANIFEST_NAME);
  const manifest = parseJson(
    readFileBounded(manifestFile, LIMITS.archiveBytes, 'installed manifest').toString('utf8'),
    'installed manifest',
  );
  requireExactKeys(manifest, MANIFEST_KEYS, 'installed manifest');
  if (manifest.name !== ROOT || !Array.isArray(manifest.files)
      || !manifest.files.every((f) => isPlainObject(f) && typeof f.path === 'string')) {
    refuse(`${manifestFile} is not an ${ROOT} manifest`);
  }
  const coreFiles = new Set();
  const coreDirs = new Set();
  for (const { path: rel } of manifest.files) {
    const lower = rel.toLowerCase();
    coreFiles.add(lower);
    for (let i = lower.indexOf('/'); i !== -1; i = lower.indexOf('/', i + 1)) coreDirs.add(lower.slice(0, i));
  }
  let stat;
  try {
    stat = fs.statSync(consumer);
  } catch (err) {
    refuse(`${consumer} cannot be read: ${err.message}`);
  }
  if (!stat.isDirectory()) refuse(`${consumer} is not a directory`);
  const problems = [];
  const entries = consumerEntries(consumer);
  for (const { rel, kind } of entries) {
    const lower = rel.toLowerCase();
    if (kind === 'dir') {
      if (coreFiles.has(lower)) problems.push(`${rel} is a directory where the core has a file`);
    } else {
      if (coreFiles.has(lower)) problems.push(`${rel} is also a core file`);
      if (coreDirs.has(lower)) problems.push(`${rel} is a ${kind} where the core has a directory`);
    }
    for (const dir of CORE_ONLY_DIRS) {
      if (lower === dir || lower.startsWith(`${dir}/`)) problems.push(`${rel} is at or inside ${dir}, which the core owns`);
    }
  }
  if (problems.length) refuse(`the add-on and ${ROOT} ${manifest.version} overlap:\n  ${problems.join('\n  ')}`);
  const files = entries.filter((e) => e.kind !== 'dir').length;
  // Both halves, as one set of files: the only place a shipped script's claim can
  // be resolved. Directories are left out — a script names a file to run.
  const tree = new Set(coreFiles);
  for (const { rel, kind } of entries) if (kind !== 'dir') tree.add(rel.toLowerCase());
  const scripts = checkShippedScripts({ core, manifest, tree });
  return {
    version: manifest.version,
    consumerFiles: files,
    coreFiles: manifest.files.length,
    scripts: scripts.scripts,
    claims: scripts.claims,
  };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = `usage:
  verify-core.js url     --lock FILE
  verify-core.js check   --lock FILE --adapter-api N [--previous-lock FILE]
  verify-core.js install --lock FILE --adapter-api N [--previous-lock FILE] --archive FILE --dest DIR
  verify-core.js check-assembly --core DIR --consumer DIR`;

const REQUIRED = {
  url: ['lock'],
  check: ['lock', 'adapter-api'],
  install: ['lock', 'adapter-api', 'archive', 'dest'],
  'check-assembly': ['core', 'consumer'],
};
const OPTIONAL_FLAGS = { check: ['previous-lock'], install: ['previous-lock'] };

class UsageError extends Error {}

function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(REQUIRED, command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: {
        lock: { type: 'string' },
        'previous-lock': { type: 'string' },
        'adapter-api': { type: 'string' },
        archive: { type: 'string' },
        dest: { type: 'string' },
        core: { type: 'string' },
        consumer: { type: 'string' },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  const allowed = new Set([...REQUIRED[command], ...(OPTIONAL_FLAGS[command] || [])]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new UsageError(`--${key} is not an option of ${command}`);
  }
  for (const key of REQUIRED[command]) {
    if (values[key] === undefined) throw new UsageError(`${command} needs --${key}`);
  }
  let adapterApi;
  if (values['adapter-api'] !== undefined) {
    if (!/^[1-9]\d*$/.test(values['adapter-api'])) throw new UsageError('--adapter-api must be a positive integer');
    adapterApi = Number(values['adapter-api']);
  }
  return {
    command,
    options: {
      lock: values.lock,
      previousLock: values['previous-lock'],
      adapterApi,
      archive: values.archive,
      dest: values.dest,
      core: values.core,
      consumer: values.consumer,
    },
  };
}

function run(argv, out = process.stdout, err = process.stderr) {
  let parsed;
  try {
    parsed = parseCommand(argv);
  } catch (e) {
    err.write(`${e.message}\n${USAGE}\n`);
    return 2;
  }
  const { command, options } = parsed;
  try {
    if (command === 'url') {
      out.write(`${loadLocks(options).url}\n`);
    } else if (command === 'check') {
      const lock = loadLocks(options);
      checkAdapterApi(lock, options.adapterApi);
      out.write(`lock verified: ${ROOT} ${lock.version}\n`);
    } else if (command === 'check-assembly') {
      const result = checkAssembly(options);
      out.write(`assembly verified: ${result.consumerFiles} add-on files, ${result.coreFiles} files of ${ROOT} ${result.version}, `
        + `${result.claims} path claims of ${result.scripts} shipped scripts resolved\n`);
    } else {
      const result = install(options);
      out.write(`installed ${ROOT} ${result.version} (${result.files} files) into ${result.dest}\n`);
    }
    return 0;
  } catch (e) {
    const reason = e instanceof Refusal ? e.message : `unexpected error: ${e.message}`;
    err.write(`refused: ${reason}\n`);
    return 1;
  }
}

module.exports = {
  ROOT,
  MANIFEST_NAME,
  LOCK_VERSION,
  LIMITS,
  SEMVER,
  Refusal,
  archiveName,
  sha256,
  parseLock,
  checkTransition,
  checkAdapterApi,
  parseTar,
  inspectArchive,
  install,
  checkAssembly,
  run,
};

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
