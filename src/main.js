import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, base64ToArrayBuffer, normalizePath, requestUrl } from 'obsidian';
import * as openpgp from 'openpgp';
import { loadKey, lockKey, pull } from './core.js';

const DEFAULTS = {
  repo: '',                 // owner/name on GitHub
  token: '',                // fine-grained PAT, Contents: read-only, this repo only
  storageBranch: 'master',  // where gcrypt keeps its files (gitception)
  branch: 'main',           // the encrypted branch to check out
  folder: '',               // vault folder to mirror into ('' = vault root)
  excludes: '.obsidian/\n.trash/\n.gitignore',
  armoredKey: '',
  keyInfo: '',
  syncOnStartup: true,
  intervalMinutes: 0,
  state: null,              // { commit, files } from the last sync
  lastSync: '',
};

class GitHubRemote {
  constructor(repo, token, branch) {
    this.base = `https://api.github.com/repos/${repo.trim()}`;
    this.branch = branch;
    this.headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) this.headers.Authorization = `Bearer ${token.trim()}`;
  }
  async call(path) {
    const r = await requestUrl({ url: this.base + path, headers: this.headers, throw: false });
    if (r.status !== 200) {
      const hint = r.status === 404 ? ' (wrong repo/branch, or the token cannot read this repo)' : r.status === 401 ? ' (token rejected)' : '';
      throw new Error(`GitHub ${r.status} for ${path}${hint}`);
    }
    return r.json;
  }
  async list() {
    const t = await this.call(`/git/trees/${encodeURIComponent(this.branch)}`);
    return new Map(t.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  }
  async get(sha) {
    const b = await this.call(`/git/blobs/${sha}`);
    if (b.encoding !== 'base64') throw new Error(`unexpected blob encoding ${b.encoding}`);
    return new Uint8Array(base64ToArrayBuffer(b.content.replace(/\s/g, '')));
  }
}

class PassphraseModal extends Modal {
  constructor(app, prompt, resolve) { super(app); this.prompt = prompt; this.resolve = resolve; this.value = null; }
  onOpen() {
    this.titleEl.setText('gcrypt sync');
    this.contentEl.createEl('p', { text: this.prompt });
    const input = this.contentEl.createEl('input', { type: 'password' });
    input.style.width = '100%';
    const done = () => { this.value = input.value; this.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('OK').setCta().onClick(done));
    setTimeout(() => input.focus(), 50);
  }
  onClose() { this.contentEl.empty(); this.resolve(this.value); }
}
const askPassphrase = (app, prompt) => new Promise((res) => new PassphraseModal(app, prompt, res).open());

export default class GcryptSyncPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.key = null; // unlocked key, kept in memory for this session only
    this.addSettingTab(new SettingsTab(this.app, this));
    this.addCommand({ id: 'pull', name: 'Pull encrypted notes now', callback: () => this.sync() });
    this.addCommand({ id: 'forget-key', name: 'Lock key (forget passphrase for this session)', callback: () => { this.key = null; new Notice('gcrypt sync: key locked'); } });
    this.addRibbonIcon('lock', 'gcrypt sync: pull', () => this.sync());
    this.app.workspace.onLayoutReady(() => { if (this.settings.syncOnStartup) this.sync(true); });
    this.scheduleInterval();
  }

  scheduleInterval() {
    if (this.timer) window.clearInterval(this.timer);
    const m = Number(this.settings.intervalMinutes);
    if (m > 0) this.timer = this.registerInterval(window.setInterval(() => this.sync(true), m * 60000));
  }

  async save() { await this.saveData(this.settings); }

  cacheDir() { return normalizePath(`${this.manifest.dir}/cache`); }

  async sync(quiet = false) {
    if (this.busy) return;
    const s = this.settings;
    if (!s.repo || !s.armoredKey) { if (!quiet) new Notice('gcrypt sync: set the repository and import the key first'); return; }
    this.busy = true;
    const notice = new Notice('gcrypt sync: pulling…', 0);
    try {
      if (!this.key) this.key = await loadKey(s.armoredKey, () => askPassphrase(this.app, 'Passphrase for the wiki key:'));
      const adapter = this.app.vault.adapter;
      const dir = this.cacheDir();
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      const cache = {
        get: async (id) => ((await adapter.exists(`${dir}/${id}`)) ? new Uint8Array(await adapter.readBinary(`${dir}/${id}`)) : null),
        put: (id, b) => adapter.writeBinary(`${dir}/${id}`, b.slice().buffer),
      };
      const { state, summary, packIds } = await pull({
        remote: new GitHubRemote(s.repo, s.token, s.storageBranch), cache, vault: this.vaultIO(), key: this.key,
        branch: s.branch, folder: normalizePath(s.folder || '/').replace(/^\/$/, ''),
        excludes: s.excludes.split('\n').map((x) => x.trim()).filter(Boolean), state: s.state,
        log: (m) => { console.log('gcrypt sync:', m); notice.setMessage(`gcrypt sync: ${m}`); },
      });
      await this.pruneCache(packIds);
      s.state = state;
      s.lastSync = `${new Date().toLocaleString()} — ${summary.commit.slice(0, 7)}`;
      await this.save();
      const parts = [`${summary.written.length} updated`, `${summary.deleted.length} removed`];
      if (summary.conflicts.length) parts.push(`${summary.conflicts.length} phone edit(s) kept: ${summary.conflicts.join(', ')}`);
      notice.hide();
      if (!quiet || summary.written.length || summary.deleted.length || summary.conflicts.length)
        new Notice(`gcrypt sync (${summary.commit.slice(0, 7)}): ${parts.join(', ')}`, summary.conflicts.length ? 15000 : 5000);
    } catch (e) {
      console.error('gcrypt sync failed', e);
      if (/passphrase|decrypt.*key|Incorrect key/i.test(String(e))) this.key = null;
      notice.hide();
      new Notice(`gcrypt sync failed: ${e.message ?? e}`, 15000);
    } finally {
      this.busy = false;
    }
  }

  // keep only the packs the current manifest still lists (gcrypt repacks now and then)
  async pruneCache(packIds) {
    const adapter = this.app.vault.adapter;
    const keep = new Set(packIds);
    const listed = await adapter.list(this.cacheDir());
    for (const f of listed.files) if (!keep.has(f.split('/').pop())) await adapter.remove(f);
  }

  vaultIO() {
    const vault = this.app.vault;
    const ensureFolder = async (path) => {
      const parts = path.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        const f = vault.getAbstractFileByPath(p);
        if (!f) await vault.createFolder(p);
        else if (!(f instanceof TFolder)) throw new Error(`${p} is a file, expected a folder`);
      }
    };
    const fileAt = (p) => { const f = vault.getAbstractFileByPath(p); return f instanceof TFile ? f : null; };
    return {
      read: async (p) => { const f = fileAt(p); return f ? new Uint8Array(await vault.readBinary(f)) : null; },
      write: async (p, bytes) => {
        const buf = bytes.slice().buffer;
        const f = fileAt(p);
        if (f) await vault.modifyBinary(f, buf);
        else { await ensureFolder(p); await vault.createBinary(p, buf); }
      },
      remove: async (p) => { const f = fileAt(p); if (f) await vault.trash(f, false); },
      rename: async (from, to) => { const f = fileAt(from); if (f) await vault.rename(f, to); },
    };
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.save();
    el.empty();
    el.createEl('p', { text: 'One-way pull: notes are decrypted from a git-remote-gcrypt repository on GitHub into this vault. Phone edits are not pushed; if a synced note was edited here, it is kept as a "(phone edit …)" copy before being replaced.' });

    new Setting(el).setName('GitHub repository').setDesc('owner/name of the gcrypt remote')
      .addText((t) => t.setPlaceholder('owner/wiki').setValue(s.repo).onChange(async (v) => { s.repo = v.trim(); await save(); }));
    new Setting(el).setName('GitHub token').setDesc('Fine-grained token for this repository only, Contents: read-only. Stored in this vault\'s plugin data.')
      .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.token).onChange(async (v) => { s.token = v.trim(); await save(); }); });
    new Setting(el).setName('Branch').setDesc('Encrypted branch to check out')
      .addText((t) => t.setValue(s.branch).onChange(async (v) => { s.branch = v.trim() || 'main'; await save(); }));
    new Setting(el).setName('Vault folder').setDesc('Where to put the notes (empty = vault root)')
      .addText((t) => t.setPlaceholder('/').setValue(s.folder).onChange(async (v) => { s.folder = v.trim(); s.state = null; await save(); }));
    new Setting(el).setName('Excluded paths').setDesc('One per line; a trailing / excludes a folder')
      .addTextArea((t) => t.setValue(s.excludes).onChange(async (v) => { s.excludes = v; await save(); }));
    new Setting(el).setName('Pull on startup')
      .addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => { s.syncOnStartup = v; await save(); }));
    new Setting(el).setName('Pull every N minutes').setDesc('0 = off')
      .addText((t) => t.setValue(String(s.intervalMinutes)).onChange(async (v) => { s.intervalMinutes = Math.max(0, Number(v) || 0); await save(); this.plugin.scheduleInterval(); }));
    new Setting(el).setName('gcrypt remote branch').setDesc('Where gcrypt stores its files on GitHub (normally master)')
      .addText((t) => t.setValue(s.storageBranch).onChange(async (v) => { s.storageBranch = v.trim() || 'master'; await save(); }));

    el.createEl('h3', { text: 'Decryption key' });
    el.createEl('p', { text: s.armoredKey ? `Imported: ${s.keyInfo}` : 'No key imported.' });
    let pasted = '';
    new Setting(el).setName('Import secret key').setDesc('Paste the ASCII-armored secret key (-----BEGIN PGP PRIVATE KEY BLOCK-----). You will be asked for a passphrase to protect it on this device (leave empty to store it unprotected).')
      .addTextArea((t) => { t.inputEl.rows = 4; t.onChange((v) => { pasted = v; }); })
      .addButton((b) => b.setButtonText('Import').setCta().onClick(async () => {
        try {
          let armored = pasted.trim();
          const key = await openpgp.readPrivateKey({ armoredKey: armored });
          if (key.isDecrypted()) {
            const pw = await askPassphrase(this.app, 'Choose a passphrase to protect the key on this device (empty = none):');
            if (pw == null) return;
            if (pw) armored = await lockKey(armored, pw);
          }
          s.armoredKey = armored;
          s.keyInfo = `${key.getFingerprint().toUpperCase()} ${(key.getUserIDs()[0] ?? '')}`;
          this.plugin.key = null;
          await save();
          new Notice('gcrypt sync: key imported');
          this.display();
        } catch (e) { new Notice(`Key import failed: ${e.message ?? e}`, 10000); }
      }));
    if (s.armoredKey) new Setting(el).setName('Remove key').addButton((b) => b.setButtonText('Remove').setWarning().onClick(async () => {
      s.armoredKey = ''; s.keyInfo = ''; this.plugin.key = null; await save(); this.display();
    }));

    el.createEl('h3', { text: 'Status' });
    el.createEl('p', { text: s.lastSync ? `Last pull: ${s.lastSync}` : 'Never pulled.' });
    new Setting(el).addButton((b) => b.setButtonText('Pull now').setCta().onClick(() => this.plugin.sync()))
      .addButton((b) => b.setButtonText('Forget sync state').setTooltip('Next pull treats every local note as unknown').onClick(async () => { s.state = null; await save(); new Notice('sync state cleared'); }));
  }
}
