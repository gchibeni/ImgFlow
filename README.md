# ImgFlow

A desktop application for downloading and organizing images from spreadsheet data. ImgFlow reads CSV/TSV files or Google Sheets, detects image URL columns automatically, and downloads images with flexible renaming and folder organization options.

## Features

- **Spreadsheet support** — Upload CSV/TSV files or connect directly to Google Sheets via OAuth
- **Auto URL detection** — Automatically identifies columns containing image URLs
- **Flexible organization** — Group images into subfolders based on any spreadsheet column
- **Smart renaming** — Rename images using spreadsheet data with automatic `_Img1`, `_Img2`, ... suffixes for duplicates
- **Respectful downloading** — Per-domain (4) and global (10) concurrency limits
- **Download control** — Real-time progress tracking with cancellation support
- **Extension detection** — Determines file type from `Content-Type` headers when not present in the URL

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, GSAP |
| Backend | Rust, Tauri 2 |
| HTTP | reqwest, tokio |
| Parsing | PapaParse (CSV/TSV), Google Sheets API v4 |

## Prerequisites

- [Node.js](https://nodejs.org/) LTS
- [Rust](https://www.rust-lang.org/tools/install) (1.77.2+)
- For Google Sheets: a `credentials.json` file with OAuth 2.0 credentials placed at `src-tauri/`

## Development

```bash
# Install dependencies
npm install

# Start the app in development mode (hot-reload)
npm run tauri dev
```

## Build

```bash
# Build for the current platform
npm run tauri build
```

Installers and binaries are output to `src-tauri/target/release/bundle/`.

### Other scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite dev server only |
| `npm run build` | Type-check and bundle the frontend |
| `npm run lint` | Run ESLint |
| `npm run preview` | Preview the production frontend build |

## Releases

Releases are automated via GitHub Actions on version tags (`v*`). The workflow builds for macOS (Apple Silicon), Linux, and Windows and creates a draft GitHub release with all platform assets attached.

To trigger a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Google Sheets Setup

1. Create a Google Cloud project and enable the **Google Sheets API**.
2. Create an **OAuth 2.0 Client ID** (Desktop app type) and download `credentials.json`.
3. Place `credentials.json` in `src-tauri/` before building.

On first use, ImgFlow will open a browser window for authorization. The resulting token is stored locally and refreshed automatically.

## License

[MIT](LICENSE)
