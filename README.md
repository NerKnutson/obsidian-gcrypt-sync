# gcrypt sync (Obsidian plugin)

Pulls a [git-remote-gcrypt](https://spwhitton.name/tech/code/git-remote-gcrypt/) repository hosted on GitHub
into an Obsidian vault and decrypts it on the device, which makes it usable on a phone.
It is one-way: notes edited on the phone are **not** pushed. Pushing is planned as stage 3.

How it works: GitHub REST API (`git/trees/<storage branch>`, `git/blobs/<sha>`) → gcrypt manifest
(OpenPGP public-key encrypted and signed; the signature is checked) → packs (symmetric OpenPGP,
SHA-256 checked) → built-in git pack reader → files written through the Obsidian Vault API.
Encrypted packs are cached in the plugin folder, so a pull with no remote changes makes 2 API calls.

Conflict rule: if a synced note was changed on the phone since the last pull, it is renamed to
`Name (phone edit YYYYMMDDHHMM).md` before the remote version is written. If a note was deleted on the
remote but edited on the phone, it is left alone. Excluded by default: `.obsidian/`, `.trash/`, `.gitignore`.

## Build

    npm install && node build.mjs     # -> dist/main.js, dist/manifest.json

## Test (Node, no Obsidian needed)

    # local gcrypt remote with the same layout as GitHub:
    git init --bare /tmp/r.git && git push gcrypt::/tmp/r.git main
    gpg --export-secret-keys --armor <FPR> | node test/run.mjs /tmp/r.git /tmp/vault /tmp/state.json   # core
    gpg --export-secret-keys --armor <FPR> | node test/plugin.cjs /tmp/r.git /tmp/vault2               # bundled plugin, mock Obsidian + fake GitHub API

## Phone setup

1. Copy `dist/main.js` and `dist/manifest.json` into `<vault>/.obsidian/plugins/gcrypt-sync/` on the phone
   (or install through BRAT from a GitHub release with those two files). Then turn on
   Settings → Community plugins → gcrypt sync.
2. Create a GitHub fine-grained token for the phone: only the wiki repository, **Contents: Read-only**.
3. In the plugin settings: repository `owner/wiki`, the token, branch `main`.
4. Import the secret key: paste the armored secret key and choose a passphrase to protect it on the phone.
   You are asked for the passphrase once per app session.
5. Run **Pull now** (also: the ribbon lock icon, the command "Pull encrypted notes now", pull on startup).

Plugin data (`data.json`) holds the token and the passphrase-protected key, and the vault holds the
decrypted notes, so don't put this vault in iCloud or another cloud sync.
