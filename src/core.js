// Read side of git-remote-gcrypt, with no Obsidian dependencies (tested in Node by test/run.mjs).
//
// Remote layout (gitception, e.g. GitHub): a branch (default "master") whose tree holds
//   91bd0c09…  manifest: gpg -se (public-key encrypted + signed), lines:
//              "<oid> refs/heads/x", "pack :SHA256:<id> <password>", "keep …", "repo …", "extn …"
//   <id>       pack <id>: symmetric gpg message (password from the manifest); <id> = SHA256(ciphertext)
import * as openpgp from 'openpgp';
import { inflateInit, inflate, inflateEnd } from 'pako/lib/zlib/inflate.js';
import ZStream from 'pako/lib/zlib/zstream.js';

export const DEFAULT_MANIFEST = '91bd0c092128cf2e60e1a608c31e92caf1f9c1595f83f2890ef17c0e4881aa0a';

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const te = new TextEncoder();
const td = new TextDecoder();

async function digest(algo, data) {
  const name = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' }[algo];
  if (!name) throw new Error(`unsupported hash ${algo}`);
  return hex(await crypto.subtle.digest(name, data));
}

/** git object id of a blob with this content */
export async function blobOid(content) {
  const head = te.encode(`blob ${content.length}\0`);
  const buf = new Uint8Array(head.length + content.length);
  buf.set(head);
  buf.set(content, head.length);
  return digest('SHA1', buf);
}

// ---------- key ----------

/** Parse the armored secret key; if it is passphrase-protected, call askPassphrase(). */
export async function loadKey(armoredKey, askPassphrase) {
  if (!armoredKey?.trim()) throw new Error('no secret key configured');
  let key = await openpgp.readPrivateKey({ armoredKey });
  if (!key.isDecrypted()) {
    const passphrase = await askPassphrase();
    if (passphrase == null) throw new Error('passphrase entry cancelled');
    key = await openpgp.decryptKey({ privateKey: key, passphrase });
  }
  return key;
}

/** Re-armor a key protected with a passphrase (for storage on the phone). */
export async function lockKey(armoredKey, passphrase) {
  const key = await openpgp.readPrivateKey({ armoredKey });
  if (!key.isDecrypted()) throw new Error('key is already passphrase-protected');
  return (await openpgp.encryptKey({ privateKey: key, passphrase })).armor();
}

// ---------- manifest and packs ----------

export async function decryptManifest(bytes, key, extraVerificationKeys = []) {
  const { data, signatures } = await openpgp.decrypt({
    message: await openpgp.readMessage({ binaryMessage: bytes }),
    decryptionKeys: key,
    verificationKeys: [key.toPublic(), ...extraVerificationKeys],
    expectSigned: true,
    format: 'utf8',
  });
  await signatures[0].verified; // throws if the signature is bad or from an unknown key
  const refs = {};
  const packs = [];
  for (const line of data.split('\n')) {
    let m;
    if ((m = /^([0-9a-f]{40}) (refs\/\S+)$/.exec(line))) refs[m[2]] = m[1];
    else if ((m = /^pack :(\w+):([0-9a-f]+) (\S+)$/.exec(line))) packs.push({ algo: m[1], id: m[2], password: m[3] });
  }
  return { refs, packs };
}

export async function decryptPack(pack, encrypted) {
  const got = await digest(pack.algo, encrypted);
  if (got !== pack.id) throw new Error(`pack ${pack.id.slice(0, 12)}: digest mismatch`);
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ binaryMessage: encrypted }),
    passwords: [pack.password],
    format: 'binary',
  });
  return data;
}

// ---------- git pack parsing ----------

const TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// Inflate one zlib stream starting at buf[off] whose output is `size` bytes; report bytes consumed.
// (pako's high-level Inflate treats the following pack bytes as a second stream, so use the zlib port.)
function inflateAt(buf, off, size) {
  const strm = new ZStream();
  inflateInit(strm);
  strm.input = buf; strm.next_in = off; strm.avail_in = buf.length - off;
  strm.output = new Uint8Array(size); strm.next_out = 0; strm.avail_out = size;
  const ret = inflate(strm, 4 /* Z_FINISH */);
  inflateEnd(strm);
  if (ret !== 1 /* Z_STREAM_END */ || strm.next_out !== size) throw new Error(`inflate failed at ${off} (${ret})`);
  return { data: strm.output, used: strm.next_in - off };
}

function applyDelta(base, delta) {
  let p = 0;
  const varint = () => {
    let v = 0, s = 0, b;
    do { b = delta[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return v >>> 0;
  };
  const baseLen = varint();
  if (baseLen !== base.length) throw new Error('delta base length mismatch');
  const out = new Uint8Array(varint());
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0, size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= delta[p++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[p++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.set(base.subarray(off >>> 0, (off >>> 0) + size), o);
      o += size;
    } else if (op) {
      out.set(delta.subarray(p, p + op), o);
      o += op; p += op;
    } else throw new Error('bad delta opcode 0');
  }
  if (o !== out.length) throw new Error('delta result length mismatch');
  return out;
}

/** Object store over one or more packs. */
export class ObjectStore {
  constructor() { this.objects = new Map(); this.pendingRef = []; }

  async addPack(pack) {
    const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    if (td.decode(pack.subarray(0, 4)) !== 'PACK') throw new Error('not a git pack');
    const n = dv.getUint32(8);
    const byOffset = new Map();
    const raw = [];
    let p = 12;
    for (let i = 0; i < n; i++) {
      const start = p;
      let b = pack[p++];
      const type = (b >> 4) & 7;
      let size = b & 15, shift = 4;
      while (b & 0x80) { b = pack[p++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
      let base;
      if (type === 6) { // OFS_DELTA
        b = pack[p++];
        let off = b & 0x7f;
        while (b & 0x80) { b = pack[p++]; off = ((off + 1) << 7) | (b & 0x7f); }
        base = { offset: start - off };
      } else if (type === 7) { // REF_DELTA
        base = { oid: hex(pack.subarray(p, p + 20)) };
        p += 20;
      }
      const { data, used } = inflateAt(pack, p, size);
      p += used;
      const entry = { start, type, data, base };
      byOffset.set(start, entry);
      raw.push(entry);
    }
    const resolve = (e) => {
      if (e.resolved) return e.resolved;
      if (TYPES[e.type]) return (e.resolved = { type: TYPES[e.type], data: e.data });
      const b = e.base.offset !== undefined ? resolve(byOffset.get(e.base.offset)) : this.objects.get(e.base.oid);
      if (!b) return null;
      return (e.resolved = { type: b.type, data: applyDelta(b.data, e.data) });
    };
    for (const e of raw) {
      const r = resolve(e);
      if (r) await this.put(r); else this.pendingRef.push({ e, resolve });
    }
  }

  async put({ type, data }) {
    const head = te.encode(`${type} ${data.length}\0`);
    const buf = new Uint8Array(head.length + data.length);
    buf.set(head); buf.set(data, head.length);
    this.objects.set(await digest('SHA1', buf), { type, data });
  }

  /** Resolve REF_DELTAs whose base was in a later pack. */
  async finish() {
    let progress = true;
    while (this.pendingRef.length && progress) {
      progress = false;
      const left = [];
      for (const x of this.pendingRef) {
        const r = x.resolve(x.e);
        if (r) { await this.put(r); progress = true; } else left.push(x);
      }
      this.pendingRef = left;
    }
    if (this.pendingRef.length) throw new Error(`${this.pendingRef.length} delta objects with missing base`);
  }

  get(oid, type) {
    const o = this.objects.get(oid);
    if (!o) throw new Error(`missing object ${oid}`);
    if (type && o.type !== type) throw new Error(`object ${oid} is ${o.type}, expected ${type}`);
    return o.data;
  }

  /** commit oid -> Map(path -> blob oid), regular files only */
  listFiles(commitOid) {
    const commit = td.decode(this.get(commitOid, 'commit'));
    const m = /^tree ([0-9a-f]{40})/.exec(commit);
    if (!m) throw new Error('commit without tree');
    const files = new Map();
    const walk = (treeOid, prefix) => {
      const t = this.get(treeOid, 'tree');
      let p = 0;
      while (p < t.length) {
        const sp = t.indexOf(0x20, p), nul = t.indexOf(0, sp);
        const mode = td.decode(t.subarray(p, sp));
        const name = td.decode(t.subarray(sp + 1, nul));
        const oid = hex(t.subarray(nul + 1, nul + 21));
        p = nul + 21;
        if (mode === '40000') walk(oid, prefix + name + '/');
        else if (mode === '100644' || mode === '100755') files.set(prefix + name, oid);
        // symlinks (120000) and submodules (160000) are skipped
      }
    };
    walk(m[1], '');
    return files;
  }
}

// ---------- sync ----------

export function isExcluded(path, excludes) {
  return excludes.some((x) => (x.endsWith('/') ? path.startsWith(x) || path + '/' === x : path === x));
}

function conflictName(path) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash + 1
    ? `${path.slice(0, dot)} (phone edit ${stamp})${path.slice(dot)}`
    : `${path} (phone edit ${stamp})`;
}

/**
 * Pull the remote into the vault (one-way: remote wins, but local edits are kept as copies).
 *  remote: { list(): Promise<Map name->handle>, get(handle): Promise<Uint8Array> }
 *  cache:  { get(id): Promise<Uint8Array|null>, put(id, bytes) }   encrypted packs by id
 *  vault:  { read(path): Promise<Uint8Array|null>, write(path, bytes), remove(path), rename(from, to) }
 *  state:  { commit, files: {path: oid} } from the previous sync (or null)
 * Returns { state, summary }.
 */
export async function pull({ remote, cache, vault, key, branch = 'main', folder = '', excludes = [],
  manifestName = DEFAULT_MANIFEST, extraVerificationKeys = [], state, log = () => {} }) {
  const listing = await remote.list();
  if (!listing.has(manifestName)) throw new Error('no gcrypt manifest on the remote');
  const manifest = await decryptManifest(await remote.get(listing.get(manifestName)), key, extraVerificationKeys);
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const commit = manifest.refs[ref];
  if (!commit) throw new Error(`branch ${ref} not on remote (has: ${Object.keys(manifest.refs).join(', ')})`);
  log(`manifest OK, ${ref} = ${commit.slice(0, 7)}, ${manifest.packs.length} pack(s)`);

  const prev = state?.files ?? {};
  const summary = { commit, written: [], deleted: [], conflicts: [], unchanged: 0 };
  if (state?.commit === commit) log('remote unchanged since last sync; checking local files');

  const store = new ObjectStore();
  for (const pk of manifest.packs) {
    let enc = await cache.get(pk.id);
    if (!enc) {
      if (!listing.has(pk.id)) throw new Error(`pack ${pk.id.slice(0, 12)} listed in manifest but missing on remote`);
      enc = await remote.get(listing.get(pk.id));
      await cache.put(pk.id, enc);
      log(`downloaded pack ${pk.id.slice(0, 12)} (${enc.length} B)`);
    }
    await store.addPack(await decryptPack(pk, enc));
  }
  await store.finish();

  const files = store.listFiles(commit);
  const prefix = folder ? folder.replace(/\/+$/, '') + '/' : '';
  const next = {};
  for (const [path, oid] of files) {
    if (isExcluded(path, excludes)) continue;
    next[path] = oid;
    const target = prefix + path;
    const local = await vault.read(target);
    const localOid = local && (await blobOid(local));
    if (localOid === oid) { summary.unchanged++; continue; }
    if (local && localOid !== prev[path]) {
      // edited on the phone (or created there) since the last sync: keep it beside the remote version
      const keep = conflictName(target);
      await vault.rename(target, keep);
      summary.conflicts.push(keep);
    }
    await vault.write(target, store.get(oid, 'blob'));
    summary.written.push(target);
  }
  for (const [path, oid] of Object.entries(prev)) {
    if (path in next) continue;
    const target = prefix + path;
    const local = await vault.read(target);
    if (!local) continue;
    if ((await blobOid(local)) === oid) { await vault.remove(target); summary.deleted.push(target); }
    else summary.conflicts.push(target); // deleted on remote, edited locally: leave it
  }
  return { state: { commit, files: next }, summary, packIds: manifest.packs.map((p) => p.id) };
}
