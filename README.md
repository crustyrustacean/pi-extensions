# pi-extensions

Personal [pi](https://pi.dev) extension package. Bundles three extensions and is
shared across machines as a pi git package (each machine `pi install`s it; `pi
update --extensions` reconciles to the latest `main`).

## Extensions

| File | What it provides |
|------|------------------|
| `extensions/codeberg.ts` | `codeberg_create_repo`, `codeberg_list_repos` — Codeberg (Forgejo) API tools |
| `extensions/pi-brain.ts` | `kb_*` tools — talk to the local pi-brain knowledge base service |
| `extensions/web-fetch.ts` | `web_fetch` tool + `/web-fetch` command — fetch URLs as readable text |

## Install (per machine)

```bash
pi install ssh://git@codeberg.org/crustyrustacean/pi-extensions@main
```

This adds the package to `~/.pi/agent/settings.json` and clones it to
`~/.pi/agent/git/codeberg.org/crustyrustacean/pi-extensions`. Restart pi (or
`/reload`) to load. Update on every machine with:

```bash
pi update --extensions
```

## Secrets stay machine-local

Extension code is synced via git, but tokens are **not** — each machine
provides its own.

### Codeberg token

Generate a token at <https://codeberg.org/user/settings/applications> with
scopes:

- `write:user` — required to create repos (Forgejo gates `POST /user/repos`
  here, not under `write:repository`)
- `read:repository`, `write:repository` — list / mutate existing repos

Then drop it in a `chmod 600` file (default path the extension reads):

```bash
mkdir -p ~/.config/codeberg
$EDITOR ~/.config/codeberg/token
chmod 600 ~/.config/codeberg/token
```

Override locations via env if needed: `CODEBERG_TOKEN` (value),
`CODEBERG_TOKEN_FILE` (path), `CODEBERG_API` (base URL, for self-hosted
Forgejo).

### pi-brain

Expects the pi-brain service at `http://localhost:8000` (hardcoded in
`pi-brain.ts`). Start it separately; it is not part of this package.

## Structure

Convention directory layout — pi auto-discovers `extensions/*.ts`. The
`package.json` `pi.extensions` manifest points at the same dir for explicitness.
