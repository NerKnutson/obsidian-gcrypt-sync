// Node test: pull a local gcrypt gitception repo into a directory, then compare with `git ls-tree`.
// usage: gpg --export-secret-keys --armor FPR | node test/run.mjs <remote.git> <vaultDir> [stateFile]
import { pull, loadKey, lockKey } from '../src/core.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [remoteDir, vaultDir, stateFile] = process.argv.slice(2);
const armored = fs.readFileSync(0, 'utf8');
const locked = await lockKey(armored, 'pw');            // exercise the passphrase path
const key = await loadKey(locked, async () => 'pw');

const git = (...a) => execFileSync('git', ['-C', remoteDir, ...a], { maxBuffer: 1 << 28 });
const remote = {   // same interface the GitHub backend implements
  async list() {
    const m = new Map();
    for (const l of git('ls-tree', 'master').toString().trim().split('\n')) {
      const [meta, name] = l.split('\t'); m.set(name, meta.split(' ')[2]);
    }
    return m;
  },
  async get(sha) { return new Uint8Array(git('cat-file', 'blob', sha)); },
};
const cacheDir = path.join(vaultDir, '.cache-test');
const cache = {
  async get(id) { try { return new Uint8Array(fs.readFileSync(path.join(cacheDir, id))); } catch { return null; } },
  async put(id, b) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(path.join(cacheDir, id), b); },
};
const vault = {
  async read(p) { try { return new Uint8Array(fs.readFileSync(path.join(vaultDir, p))); } catch { return null; } },
  async write(p, b) { fs.mkdirSync(path.dirname(path.join(vaultDir, p)), { recursive: true }); fs.writeFileSync(path.join(vaultDir, p), b); },
  async remove(p) { fs.unlinkSync(path.join(vaultDir, p)); },
  async rename(a, b) { fs.renameSync(path.join(vaultDir, a), path.join(vaultDir, b)); },
};
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const t0 = performance.now();
const res = await pull({ remote, cache, vault, key, excludes: ['.obsidian/'], state, log: (m) => console.log(' ', m) });
if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(res.state));
const s = res.summary;
console.log(`commit ${s.commit.slice(0, 7)}: ${s.written.length} written, ${s.unchanged} unchanged, ${s.deleted.length} deleted, conflicts: ${JSON.stringify(s.conflicts)} (${(performance.now() - t0).toFixed(0)} ms)`);
