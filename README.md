<div align="center">

# zeithub.otto

**A desktop AI coding studio that works with whatever model you have —
a 4B model on a laptop CPU, a 35B model on a gaming GPU, or Claude and Codex in the cloud.**

[Download for Windows](https://github.com/zeithub-team/otto/releases/latest) ·
[Build from source](#build-from-source) ·
[How it works](#how-it-works)

</div>

---

Most AI editors are tuned for frontier models. Hand them a small local model and it pastes
code into the chat, forgets to save files, or gets stuck calling the same tool in a loop.

Otto is built the other way around. It keeps small models on a short leash — one action
per turn, a structured reply, only the tools the request needs — and checks their work
in a real browser. Large models run without restrictions, and when a provider hits its
limit Otto quietly moves on to the next one.

## What it does

**Works with any model.** Local models through [Ollama](https://ollama.com), hosted
providers (OpenRouter, Groq, NVIDIA, Cohere, Z.ai, Cloudflare and others), and your
Claude Code or Codex subscription.

**Makes small models useful.** In guided mode the model answers with strict JSON
validated against a schema, one step at a time. A 9B model writes real files instead of
code blocks in the chat.

**Falls back instead of failing.** If a provider is down or out of quota, Otto switches
to the next available one and finally to a local model. You see a short
"switched from A to B" note, not an error.

**Checks what it built.** After a site is written, Otto opens it in a headless browser
at desktop and phone width and sends the model a list of what looks broken —
overlapping blocks, unstyled forms, default blue links, sideways scrolling — so it can
fix its own CSS.

**Builds multi-page sites step by step.** Site map, design idea, stylesheet, header and
footer, then each page. All the creative work comes from the model; Otto only keeps the
steps small enough for a small model to get right.

**Guards your files.** Writes that would leave unbalanced brackets, empty a file, or
drop forms and sections from a page are flagged before they land.

**Lets the model drive the app.** Open the preview, switch theme or language, manage
tasks, change settings, connect over SSH. Anything risky asks you first.

**And the rest.** Project services with live counters, a built-in terminal (or
[Tabby](https://tabby.sh)), a device-frame preview with tabs, attachments (images, PDF,
DOCX, XLSX), a skills library, and an interface in six languages.

## Recommended local models

| Your hardware | Model | Download |
| --- | --- | --- |
| No GPU | `qwen3.5:4b` | 3.4 GB |
| 8–12 GB GPU | `gemma4:12b` or `qwen3.5:9b` | 8.0 / 6.6 GB |
| 16–24 GB GPU | `qwen3.6:35b` or `qwen3-coder:30b` | 22.6 / 18.6 GB |
| Images and screenshots | `qwen3-vl:8b` | 6.1 GB |

All of them install from the **Models** tab. On our coffee-shop test — one landing page,
four follow-up requests, checked in a browser — `gemma4:12b` scores 100/100 in under
two and a half minutes.

## Install

Download `zeithub-otto-setup-<version>.exe` from
[Releases](https://github.com/zeithub-team/otto/releases/latest) and run it. Theme and
language are picked during setup.

The installer isn't code-signed yet, so Windows SmartScreen may warn you:
choose **More info → Run anyway**.

For local models, install [Ollama](https://ollama.com/download). Otto finds it on its own.

## Build from source

Requires Node.js 20+.

```bash
git clone https://github.com/zeithub-team/otto.git
cd otto
npm install
npm run dev
```

`npm run dev` starts the local server and the web UI with hot reload.
`npm run dev:desktop` runs the same UI inside Electron.

| Command | |
| --- | --- |
| `npm run check` | Type check, lint, translation check and tests |
| `npm run build` | Production build of both apps |
| `npm run dist:local -w @otto/desktop` | Windows installer in `apps/desktop/release/v<version>/` |
| `npm run clean` | Remove build output |

Installer details are in [docs/building.md](docs/building.md).

## How it works

```
apps/
  desktop/        Electron shell and the local server (Node, SQLite)
    src/main/       window, preload, Tabby integration
    src/server/     chat loop, tools, providers, preview, tasks, SSH
  web/            the interface (Next.js, React)
```

The server listens on `127.0.0.1` only. The interface talks to it over HTTP and a
WebSocket; the Electron renderer has no direct Node access.

If you want to change how models behave, start here:

- `src/server/ollama.ts` — the chat loop, provider fallback, and the nudges for models
  that describe work instead of doing it
- `src/server/guided.ts` — guided mode: tool groups per request and the JSON schema
- `src/server/sitebuilder.ts`, `visualqa.ts` — step-by-step sites and the browser check
- `src/server/apptools.ts` — the tools a model uses to control Otto itself

## Configuration

Copy `.env.example` to `.env` for development.

| Variable | Default | |
| --- | --- | --- |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama runs |
| `OLLAMA_MODEL` | `qwen3.6:35b` | Model picked on first run |
| `OTTO_PORT` | `8000` | Dev server port |
| `WORKSPACE_ROOT` | `./workspace` | Where relative project paths resolve |
| `OTTO_LOCAL_MODE` | `auto` | `guided` or `native` to force a mode |
| `OTTO_VISUAL_QA` | on | `0` turns the browser check off |

Packaged builds keep their data in `%APPDATA%\zeithub.otto`.

## License

[MIT](LICENSE) © zeithub.team
