# pi-extensions

Personal [pi](https://pi.dev) extension package. Bundles two extensions and is
shared across machines as a pi git package (each machine `pi install`s it; `pi
update --extensions` reconciles to the latest `main`).

## Extensions

| File | What it provides |
|------|------------------|
| `extensions/pi-brain.ts` | `kb_*` tools — talk to the local pi-brain knowledge base service |
| `extensions/web-fetch.ts` | `web_fetch` tool + `/web-fetch` command — fetch URLs as readable text |

## Install (per machine)

```bash
pi install ssh://git@github.com/crustyrustacean/pi-extensions.git@main
```

This adds the package to `~/.pi/agent/settings.json` and clones it to
`~/.pi/agent/git/github.com/crustyrustacean/pi-extensions`. Restart pi (or
`/reload`) to load. Update on every machine with:

```bash
pi update --extensions
```

## Runtime dependency

### pi-brain

Expects the pi-brain service at `http://localhost:8080` (hardcoded in
`pi-brain.ts`). Start it separately; it is not part of this package.

## Structure

Convention directory layout — pi auto-discovers `extensions/*.ts`. The
`package.json` `pi.extensions` manifest points at the same dir for explicitness.
