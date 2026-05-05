# Pochimo

Pochimo is an experimental pet diary app that turns periodic browser-camera captures into a simple daily summary for pet owners.

The first prototype, `diary/`, was built around one question:

> Can an old smartphone become a lightweight pet camera that summarizes what happened while the owner was away?

This repository is intentionally small and prototype-oriented. It is useful as a reference implementation for browser camera capture, pet activity logging, AI-assisted report generation, and a minimal authenticated Hono/Bun app.

## Features

- Browser-based camera capture from a phone or PC
- Periodic JPEG frame storage
- Motion score and camera metadata logging
- Pet profile and household-aware authentication
- Daily event timeline
- AI-assisted pet diary/report generation
- Optional AI chat over captured activity context
- Optional email delivery through Resend
- Local-first runtime data under `diary/data/` (`gitignored`)

## What this is not

Pochimo is not a veterinary diagnosis tool, a medical device, or a replacement for professional animal care.

The AI output is intended for lightweight observation and owner reflection only. If a pet appears sick, injured, distressed, or in an emergency condition, contact a veterinarian immediately.

## Repository structure

```text
.
├── diary/                 # Main Pochimo Diary app
│   ├── public/            # Browser UI
│   ├── src/               # Services and app logic
│   ├── docs/              # Product notes / MVP spec
│   ├── scripts/           # Utility scripts
│   ├── server.ts          # Hono server entrypoint
│   └── data/              # Runtime data; ignored by git
├── package.json           # Workspace scripts
└── README.md
```

## Requirements

- Node.js 20+
- Bun 1.1+
- npm
- Optional: Ollama or Ollama Cloud-compatible API for AI generation
- Optional: Resend API key for email delivery

## Quick start

```bash
git clone https://github.com/kandotrun/pochimo.git
cd pochimo
npm install
cp diary/.env.example diary/.env
npm run dev
```

Open:

```text
http://localhost:8787
```

For camera access on mobile browsers, HTTPS is usually required. Use a local HTTPS tunnel, Tailscale Serve, Cloudflare Tunnel, or another trusted HTTPS endpoint during testing.

## Environment variables

Create `diary/.env` from `diary/.env.example`.

Common variables:

```env
PORT=8787
DATA_DIR=./data
SETUP_TOKEN=change-this-before-public-use

PUBLIC_MARKETING_ORIGIN=http://localhost:8787
PUBLIC_APP_ORIGIN=http://localhost:8787

OLLAMA_API_KEY=
OLLAMA_CLOUD_URL=https://ollama.com/v1
OLLAMA_CLOUD_VISION_MODEL=gemma4:31b
OLLAMA_CLOUD_MODEL=deepseek-v4-pro
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_VISION_MODEL=moondream

RESEND_API_KEY=
MAIL_FROM="Pochimo <noreply@example.com>"
MAIL_REPLY_TO=
```

Never commit real API keys, production `.env` files, SQLite databases, captured frames, or generated reports.

## Scripts

From the repository root:

```bash
npm run dev          # Start the diary app in watch mode
npm run start        # Start the diary app
npm run typecheck    # TypeScript check
npm run test         # Run tests
npm run check        # Biome + typecheck + tests
npm run format       # Format code
npm run report       # Generate a diary report from stored events
```

You can also run commands inside `diary/` directly.

## Data and privacy

Runtime data is stored under `diary/data/` by default and is ignored by git.

That directory may contain:

- Captured pet images
- Event logs
- Generated reports
- Authentication SQLite database
- Session tokens and user account data

Treat `diary/data/` as private user data. Do not publish it, attach it to issues, or use it in demos without explicit consent from everyone involved.

## Security notes

This is prototype software. Before exposing it to the public internet:

- Set a strong `SETUP_TOKEN`
- Use HTTPS
- Rotate any API keys used during development
- Keep `.env` and `diary/data/` out of git
- Review CORS/origin settings for your deployment
- Put the app behind appropriate rate limits and monitoring
- Avoid using real household camera data in public demos

If you find a vulnerability, please avoid posting sensitive exploit details publicly. Open a GitHub issue with a high-level description or contact the maintainer privately if contact information is available.

## Development status

Pochimo is an MVP/prototype, not a polished commercial product. Expect rough edges, incomplete UX, and product assumptions that may change.

The code is published mainly for learning, experimentation, and reuse by people exploring pet-tech, browser camera workflows, and AI-generated activity summaries.

## License

MIT License. See [LICENSE](./LICENSE).
