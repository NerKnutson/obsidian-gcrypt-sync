// Load dist/main.js with a mock 'obsidian' module; GitHub API served from a local gitception repo.
// usage: gpg --export-secret-keys --armor FPR | node test/plugin.cjs <remote.git> <outDir>
const Module = require('module'); const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const [remoteDir, outDir] = process.argv.slice(2);
const git = (...a) => execFileSync('git', ['-C', remoteDir, ...a], { maxBuffer: 1 << 28 });
const calls = [];
class TAbstractFile { constructor(p) { this.path = p; } } class TFile extends TAbstractFile {} class TFolder extends TAbstractFile {}
const files = new Map(); // path -> TFile|TFolder ; contents on disk under outDir
const disk = (p) => path.join(outDir, p);
const vault = {
  getAbstractFileByPath: (p) => files.get(p) ?? null,
  readBinary: async (f) => { const b = fs.readFileSync(disk(f.path)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
  modifyBinary: async (f, buf) => fs.writeFileSync(disk(f.path), Buffer.from(buf)),
  createBinary: async (p, buf) => { if (files.has(p)) throw new Error('exists ' + p); fs.writeFileSync(disk(p), Buffer.from(buf)); files.set(p, new TFile(p)); },
  createFolder: async (p) => { fs.mkdirSync(disk(p)); files.set(p, new TFolder(p)); },
  trash: async (f) => { fs.unlinkSync(disk(f.path)); files.delete(f.path); },
  rename: async (f, to) => { fs.renameSync(disk(f.path), disk(to)); files.delete(f.path); f.path = to; files.set(to, f); },
  adapter: {
    exists: async (p) => fs.existsSync(disk(p)), mkdir: async (p) => fs.mkdirSync(disk(p), { recursive: true }),
    readBinary: async (p) => { const b = fs.readFileSync(disk(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
    writeBinary: async (p, buf) => fs.writeFileSync(disk(p), Buffer.from(buf)),
    list: async (p) => ({ files: fs.readdirSync(disk(p)).map((f) => `${p}/${f}`), folders: [] }),
    remove: async (p) => fs.unlinkSync(disk(p)),
  },
};
let pending = [];
const mock = {
  TFile, TFolder, normalizePath: (p) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/',
  base64ToArrayBuffer: (s) => { const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
  requestUrl: async ({ url, headers }) => {
    calls.push(url);
    if (headers.Authorization !== 'Bearer test-token') return { status: 401, json: {} };
    let m;
    if ((m = /\/repos\/me\/wiki\/git\/trees\/(\w+)$/.exec(url))) return { status: 200, json: { tree: git('ls-tree', '-l', m[1]).toString().trim().split('\n').map((l) => { const [meta, p] = l.split('\t'); const [mode, type, sha] = meta.split(/\s+/); return { path: p, mode, type, sha }; }) } };
    if ((m = /\/repos\/me\/wiki\/git\/blobs\/([0-9a-f]{40})$/.exec(url))) { const b64 = git('cat-file', 'blob', m[1]).toString('base64').replace(/(.{60})/g, '$1\n'); return { status: 200, json: { encoding: 'base64', content: b64 } }; }
    return { status: 404, json: {} };
  },
  Notice: class { constructor(m) { console.log('[Notice]', m); } setMessage() {} hide() {} },
  Modal: class { constructor(app) { this.app = app; } open() { this.onClose(); } }, // never used if key unprotected
  Setting: class {}, PluginSettingTab: class {},
  Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; this._data = null; }
    async loadData() { return this._data; } async saveData(d) { this._data = JSON.parse(JSON.stringify(d)); }
    addSettingTab() {} addCommand() {} addRibbonIcon() {} registerInterval(x) { return x; } },
};
const orig = Module._load; Module._load = function (req, ...r) { return req === 'obsidian' ? mock : orig.call(this, req, ...r); };
(async () => {
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir);
  const Plugin = require(path.resolve(__dirname, '../dist/main.js')).default;
  const app = { vault, workspace: { onLayoutReady: (cb) => (pending.push(cb)) } };
  const p = new Plugin(app, { dir: '.obsidian/plugins/gcrypt-sync' });
  p._data = { repo: 'me/wiki', token: 'test-token', armoredKey: fs.readFileSync(0, 'utf8') };
  await p.onload();
  for (const cb of pending) cb();               // startup pull (quiet)
  while (p.busy !== false) await new Promise((r) => setTimeout(r, 20));
  await p.sync();                               // second pull: nothing to do, packs from cache
  console.log('API calls:', calls.length, '| last sync:', p._data.lastSync, '| cache:', fs.readdirSync(disk('.obsidian/plugins/gcrypt-sync/cache')).length, 'pack(s)');
  p.settings.token = 'bad'; await p.sync();
})();
