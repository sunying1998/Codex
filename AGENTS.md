<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Yingke project workflow

- This repository is `sunying1998/Codex`; the user's Windows installation follows `origin/main` through `Update-Yingke.cmd`.
- For coding changes the user asks to synchronize to this installation, run the relevant checks, commit the intended source files and push a fast-forward update to `origin/main` using existing native Git authentication. Never force-push, discard user edits or embed credentials. Report a concrete access blocker if push is denied.
- `.data/`, `.env.local`, `.env`, media, runtime control files, logs and customized installer artifacts are local data. Never commit them. `.env.example` is the non-secret template.
- Report which source files changed, relevant verification and the published commit. A cloud change does not modify the user's Windows files until they run the update entry point.
- Cloud tasks already have isolated checkouts. Use the existing checkout; do not create a Git worktree unless the user explicitly asks.
- `npm run dev` is for development. The Windows managed workflow uses `scripts/manage.mjs` and a production web process plus an IPC-managed Worker. Keep shutdown and task recovery working across Windows and Linux.
- Test Git migration and update behavior with `npm run test:sync`; test real service control and resumed exports with `npm run test:managed` after a production build. Media tests use temporary accounts and data, never the user's working database.
