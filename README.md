# S3 Image Uploader — Obsidian Plugin

Upload images, video, audio, and PDF files directly from Obsidian to **AWS S3** or any **S3-compatible storage** (Cloudflare R2, MinIO, Backblaze B2, etc.).  
When a note has `localUpload: true` in its YAML frontmatter the file is saved locally using **Obsidian's own attachment settings** instead.

---

## Table of Contents

1. [Features](#features)
2. [Installation](#installation)
3. [Building from Source](#building-from-source)
4. [Plugin Settings](#plugin-settings)
5. [Per-Note Frontmatter Overrides](#per-note-frontmatter-overrides)
6. [Local Upload Mode](#local-upload-mode)
7. [How Uploads Work](#how-uploads-work)
8. [Image Compression](#image-compression)
9. [Ignore Patterns](#ignore-patterns)
10. [Commands](#commands)
11. [Troubleshooting](#troubleshooting)

---

## Features

- **Paste & drag-drop** — intercepts clipboard paste and drag-and-drop events and uploads automatically.
- **S3-compatible** — works with AWS S3, Cloudflare R2, MinIO, Backblaze B2, and any provider with an S3-compatible API.
- **Per-note overrides** — every setting can be overridden on a note-by-note basis via YAML frontmatter.
- **Local upload mode** — set `localUpload: true` in a note's frontmatter to save the file into Obsidian's configured attachment folder instead of uploading to S3.
- **Rename dialog** — optionally show a dialog to rename each file before it is uploaded / saved.
- **Image compression** — reduce image size before uploading.
- **Multi-file support** — handles multiple files pasted or dropped at once.
- **Conflict resolution** — prompts to rename, overwrite, or cancel when a file already exists.
- **Folder variables** — use `${year}`, `${month}`, `${day}`, `${basename}` in folder paths.
- **Video, audio, PDF** support (configurable).

---

## Installation

### From the Obsidian Community Plugin Browser
1. Open Obsidian → **Settings → Community Plugins → Browse**.
2. Search for **S3 Image Uploader**.
3. Click **Install**, then **Enable**.

### Manual Install (pre-built)
1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/jvsteiner/s3-image-uploader/releases).
2. Copy them to `<your-vault>/.obsidian/plugins/s3-image-uploader/`.
3. In Obsidian go to **Settings → Community Plugins** and enable **S3 Image Uploader**.

---

## Building from Source

### Prerequisites
- **Node.js** ≥ 16
- **npm** ≥ 8

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/thesiddikhamim/s3-image-uploader.git
cd s3-image-uploader

# 2. Install dependencies
npm install
# or: make install
```

### Development (watch mode)

```bash
npm run dev
# or: make dev
```

Starts esbuild in watch mode. Every time you save `main.ts`, `main.js` is rebuilt automatically.

### Production Build

```bash
npm run build
# or: make build
```

Runs TypeScript type-checking (`tsc`) and then bundles the code into `main.js`.

### Deploy to Your Vault

After building, copy the output files into your vault's plugin folder:

```bash
cp main.js styles.css manifest.json \
  /path/to/your/vault/.obsidian/plugins/s3-image-uploader/
```

Then reload the plugin in Obsidian (**Settings → Community Plugins → disable → enable**).

### Other Make Targets

| Command | Description |
|---|---|
| `make install` | Install npm dependencies |
| `make dev` | Start watch-mode build |
| `make build` | Production build |
| `make clean` | Remove build artifacts |
| `make version-bump V=patch` | Bump version (`patch`, `minor`, or `major`) |
| `make release` | Build, tag, and publish a GitHub release |

---

## Plugin Settings

Open **Settings → S3 Image Uploader** to configure the plugin.

### S3 / Storage Credentials

| Setting | Description |
|---|---|
| **AWS Access Key ID** | The access key for an IAM user with `s3:PutObject` (and optionally `s3:HeadObject`) permission on the bucket. |
| **AWS Secret Key** | The corresponding secret key. Both fields are masked by default — click the eye icon to reveal. |
| **Region** | AWS region of the bucket (e.g. `us-east-1`). For non-AWS providers this can be any value the provider accepts (e.g. `auto` for Cloudflare R2). |
| **S3 Bucket** | Name of the S3 bucket. |
| **Bucket Folder** | Optional sub-folder inside the bucket. Supports variables: `${year}`, `${month}`, `${day}`, `${basename}` (replaced at upload time). Example: `attachments/${year}/${month}`. Leave blank to upload to the bucket root. |

### Upload Behaviour

| Setting | Default | Description |
|---|---|---|
| **Upload on drag** | On | Also upload files that are dragged and dropped into the editor (in addition to paste). |
| **Upload video files** | Off | Upload video files (mp4, mov, etc.) to S3. |
| **Upload audio files** | Off | Upload audio files (mp3, m4a, etc.) to S3. |
| **Upload PDF files** | Off | Upload PDF files to S3 and embed them via Google Docs Viewer. |
| **Ask to rename file before upload** | On | Show a pop-up dialog before each upload so you can rename the file. The suggested name is auto-sanitized to be URL-safe. If turned off, images get a hash suffix automatically; other files are named by their hash. |
| **Disable auto-upload on file create** | Off | By default the plugin also watches for new image files created in the vault (useful on mobile / when Obsidian itself pastes the file first). Enable this to turn off that behaviour — e.g. if cloud sync or startup causes false positives. |

### Custom Endpoint (S3-Compatible Storage)

| Setting | Description |
|---|---|
| **Use custom endpoint** | Toggle on to use the field below instead of the default AWS endpoint. Required for Cloudflare R2, MinIO, etc. |
| **Custom S3 Endpoint** | Full URL of the S3-compatible endpoint (e.g. `https://<account-id>.r2.cloudflarestorage.com/`). The plugin automatically adds `https://` and a trailing slash if missing. |
| **S3 Path Style URLs** | Force legacy path-style URLs (`endpoint/bucket/key`) instead of the modern host-style (`bucket.endpoint/key`). Required by some self-hosted providers (e.g. MinIO). |

### Custom Image URL (CDN)

| Setting | Description |
|---|---|
| **Use custom image URL** | Toggle on to use a custom base URL when inserting image links into your notes (useful when serving files via a CDN in front of the bucket). |
| **Custom Image URL** | The base URL. The file key is appended directly, so make sure it ends with `/`. Example: `https://cdn.example.com/`. |

### Query String

Append a fixed key=value query string to every inserted URL. Useful for CDN cache-busting or access tokens.

| Setting | Description |
|---|---|
| **Query String Key** | The query parameter name (leave blank to disable). |
| **Query String Value** | The query parameter value. |

### CORS

| Setting | Description |
|---|---|
| **Bypass local CORS check** | Attempt to skip browser CORS pre-flight checks. May work on newer Obsidian versions. Try enabling this if you see CORS errors in the developer console. |

### Image Compression

| Setting | Default | Description |
|---|---|---|
| **Enable Image Compression** | Off | Compress images before uploading. When disabled the three settings below are hidden. |
| **Max Image Size** | 1 MB | Maximum allowed file size after compression. |
| **Image Compression Quality** | 0.7 | Quality factor (0.0 – 1.0). Lower = smaller file, lower quality. |
| **Max Image Width or Height** | 4096 px | Images are scaled down so neither dimension exceeds this value. |

### Ignore Pattern

| Setting | Description |
|---|---|
| **Ignore Pattern** | Glob pattern(s) for note paths where the plugin should do nothing (Obsidian's default behaviour is preserved). Separate multiple patterns with commas. Supports `*`, `**`, `?`. Example: `private/*, **/drafts/**, temp*`. |

---

## Per-Note Frontmatter Overrides

Any note can override global settings by adding keys to its YAML frontmatter (between the `---` delimiters).

```yaml
---
localUpload: true          # Save locally instead of uploading to S3
uploadOnDrag: true         # Override the global drag-and-drop setting
uploadVideo: true          # Allow video uploads for this note
uploadAudio: true          # Allow audio uploads for this note
uploadPdf: true            # Allow PDF uploads for this note
uploadFolder: "my-folder"  # Use a different S3 folder for this note
---
```

Frontmatter values always take priority over the plugin settings panel.

---

## Local Upload Mode

When `localUpload: true` is present in a note's frontmatter, **no data is sent to S3**. Instead:

1. The rename dialog still appears (if **Ask to rename** is enabled).
2. The file is saved via Obsidian's native attachment API — it goes to **whatever folder you have configured in Obsidian's own Settings → Files & Links → Default location for new attachments**.
3. An Obsidian wikilink (`![[filename.png]]`) is inserted at the cursor rather than a remote URL.

This is a per-note setting only — there is no global toggle. Add or remove `localUpload: true` from the note's frontmatter as needed.

---

## How Uploads Work

1. **Paste / drop / file picker** — the plugin intercepts the event and prevents Obsidian's default behaviour.
2. **File type check** — only images are always uploaded; video, audio, and PDF require the respective toggle to be on (globally or in frontmatter).
3. **Rename** — if **Ask to rename** is on, a modal appears with an auto-sanitized suggested name. Press **Enter**, click **Upload**, or click **Keep** to accept.
4. **Conflict check** — the plugin checks whether a file with the same key already exists. If it does, you can **Rename**, **Overwrite**, or **Cancel**.
5. **Compression** — if enabled and the file is an image, it is compressed before upload.
6. **Upload / save** — the file is either uploaded to S3 or saved locally depending on `localUpload`.
7. **Link insertion** — the appropriate markdown is inserted at the cursor:
   - S3 image → `![image](https://…)`
   - S3 video → `<video src="…" controls />`
   - S3 audio → `<audio src="…" controls />`
   - S3 PDF → Google Docs Viewer iframe
   - Local save → `![[filename.png]]`

### Folder Variable Reference

| Variable | Replaced with |
|---|---|
| `${year}` | 4-digit current year, e.g. `2026` |
| `${month}` | 2-digit current month, e.g. `04` |
| `${day}` | 2-digit current day, e.g. `28` |
| `${basename}` | Slug of the current note's filename (spaces → `-`) |

---

## Image Compression

Powered by [`browser-image-compression`](https://www.npmjs.com/package/browser-image-compression). Compression only applies to S3 uploads, not to local saves.

- A notice is shown after compression: *"Image compressed from X to Y"*.
- The three compression sub-settings (size, quality, dimensions) are hidden in the UI when compression is disabled.

---

## Ignore Patterns

Use the **Ignore Pattern** setting to exclude entire folders or notes from plugin processing. The plugin uses [`minimatch`](https://www.npmjs.com/package/minimatch) glob matching.

| Pattern | Matches |
|---|---|
| `private/*` | All notes directly inside `private/` |
| `**/drafts/**` | Any note anywhere inside a `drafts/` folder |
| `temp*` | Notes whose path starts with `temp` |
| `private/*, **/drafts/**` | Either of the above (comma-separated) |

When a note matches the ignore pattern, the plugin returns without doing anything and Obsidian handles the paste/drop normally.

---

## Commands

The plugin adds one command accessible via the Command Palette (`Cmd/Ctrl + P`):

| Command | Description |
|---|---|
| **S3 Image Uploader: Upload image** | Opens a file picker to select an image from your filesystem and upload it (or save locally) at the current cursor position. |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| CORS error in the console | Bucket CORS policy missing | Add a CORS rule on the bucket allowing `PUT` from Obsidian's origin, or enable **Bypass local CORS check**. |
| Files uploaded but URL returns 403 | Bucket / object ACL or policy too restrictive | Make the bucket/objects public-read, or use a signed URL / CDN. |
| Rename dialog keeps appearing in a loop | `localUpload: true` + auto-upload-on-create conflict | This was a known bug — make sure you are on the latest build. |
| Nothing happens on paste | File type not enabled | Enable **Upload video / audio / PDF** for non-image files; check **Ignore Pattern** isn't matching the note. |
| Wrong attachment folder for local saves | Obsidian's attachment setting | Go to **Settings → Files & Links → Default location for new attachments** and set the desired folder there. |
| `S3 client not configured` notice | Missing credentials or region | Fill in all required fields in the plugin settings (Access Key, Secret Key, Region, Bucket). |

---

## Support

If you find this plugin useful, consider buying the original author a coffee:

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-blue.png)](https://www.buymeacoffee.com/thesiddikhamim)
