# S3 Image Uploader - Project Context

This is an Obsidian plugin that allows users to upload images and other media (audio, video, PDF) to an AWS S3 bucket or S3-compatible storage. It serves as an alternative to third-party services like Imgur, giving users full control over their data.

## Project Overview

- **Type:** Obsidian Plugin
- **Tech Stack:** TypeScript, Node.js, AWS SDK for JavaScript (v3), esbuild.
- **Main Logic:** Located in `main.ts`. It handles paste and drag-and-drop events in Obsidian editors, uploads files to S3, and replaces local paths with S3 URLs.
- **Key Features:**
    - S3 and S3-compatible storage support.
    - Image compression (via `browser-image-compression`).
    - Local file system fallback (copying to a local folder instead of uploading).
    - Customizable via YAML frontmatter (per-note settings).
    - Support for media files (video, audio, PDF).

## Building and Running

The project uses `npm` for dependency management and `esbuild` for bundling. A `Makefile` is also provided for convenience.

### Key Commands

- **Install Dependencies:**
  ```bash
  npm install
  # or
  make install
  ```

- **Development Build (Watch Mode):**
  ```bash
  npm run dev
  # or
  make dev
  ```
  This command starts `esbuild` in watch mode, automatically rebuilding `main.js` when `main.ts` changes.

- **Production Build:**
  ```bash
  npm run build
  # or
  make build
  ```
  This command performs type checking (`tsc`) and then bundles the code for production.

- **Clean Build Artifacts:**
  ```bash
  make clean
  ```

- **Version Bumping:**
  ```bash
  make version-bump V=patch # Options: patch, minor, major
  ```

- **Release:**
  ```bash
  make release
  ```
  Builds the project, tags it in git, and uses the GitHub CLI (`gh`) to create a release and upload assets (`main.js`, `styles.css`, `manifest.json`).

## Development Conventions

- **Code Style:** TypeScript with standard Obsidian plugin patterns.
- **ESLint:** Configuration is in `.eslintrc`, ignored files in `.eslintignore`.
- **Formatting:** `.editorconfig` is present for consistent indentation (tabs) and line endings.
- **Obsidian API:** The plugin heavily uses the `obsidian` module for editor interactions and settings.
- **Versioning:**
    - `manifest.json`: Current plugin version and minimum Obsidian version.
    - `package.json`: NPM package version.
    - `versions.json`: Compatibility map for Obsidian.
    - Use `version-bump.mjs` or `make version-bump` to keep all version files in sync.

## Key Files

- `main.ts`: The entry point and core logic of the plugin.
- `manifest.json`: Obsidian plugin metadata.
- `esbuild.config.mjs`: Bundling configuration.
- `Makefile`: Task automation for development and releases.
- `styles.css`: Custom styles for the plugin settings or UI components.
- `declare.d.ts`: Type declarations for external modules.
