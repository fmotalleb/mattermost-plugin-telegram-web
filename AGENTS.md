# AGENTS.md

Mattermost webapp plugin (`com.telegramweb.ui`) that overlays a Telegram-Web-style UI on the host app. Two deliverables: a webpack bundle (`webapp/dist/main.js`, CSS inlined) and a small Go server binary (`server/dist/plugin-linux-{amd64,arm64}`). Installable tarball layout is built by `make release`.

## Commands (all from repo root)

- `make test` — the canonical check: `tsc --noEmit` + smoke tests + bundle tests + `go vet`/build. Run this before considering any change done. CI runs exactly this.
- `make bundle` — production webpack build only (no Go toolchain needed).
- `make server` — cross-compiles both linux binaries with `CGO_ENABLED=0`.
- `make release` — bundle + server + `release/<id>-<version>.tar.gz`.
- `make version VERSION=1.2.3` — stamps the version into `plugin.json`, `webapp/package.json` and the lockfile (via `scripts/version.js`). Releases are cut by pushing a `v*` tag; CI does the stamping. Do not hand-edit versions in those three files.
- Webapp-only equivalents live in `webapp/package.json` (`npm run build`, `check-types`, `test:smoke`, `test:bundle`, `preview`), but prefer the Makefile targets so prerequisites (e.g. `test-bundle` depends on a fresh `bundle`) are respected.

Minimum toolchains: Node 24+, Go 1.26 (see `server/go.mod`). There is no linter or formatter config — CI runs only type check, tests, and packaging.

## Architecture facts that are easy to get wrong

- **React is never bundled.** `react`, `react-dom`, `redux`, `react-redux`, etc. are webpack `externals` resolved from host globals (`window.React`, …). Do not add them as runtime dependencies or change `webapp/webpack.config.js` externals without understanding this.
- **JSX runtime is intentionally `classic`** (`babel.config.js`) so output calls `React.createElement`, compatible across Mattermost's React 16–19. Do not switch to the automatic runtime.
- **No `mattermost-redux` dependency.** The data layer is `webapp/src/mm/` (store bridge, selectors, REST `api.ts`, socket, post cache). It reads the Redux store the host passes to `initialize(registry, store)` and calls the REST API with session cookie + CSRF. New data access belongs there.
- Entry point: `webapp/src/index.tsx` registers via `window.registerPlugin(PLUGIN_ID, …)`. UI lives in `webapp/src/ui/`; all styling is one file, `webapp/src/styles.css`, scoped under `.tgw-root` and inlined into the bundle by style-loader.
- Per-user settings are a Mattermost user preference under key `com.telegramweb.ui--settings` (`src/mm/settings.ts`), not plugin KV. Server-side defaults come from `plugin.json → settings_schema` via client config.
- Go server (`server/`) only implements Telegram-style view counts: table `tg_webui_user_view_tracking`, HTTP API under `/plugins/com.telegramweb.ui/api/v1/views` (POST record, GET stats). Only linux-amd64/arm64 ship.
- `tsconfig.json` has `strict: false` and `noImplicitAny: false` — match the existing loose style; do not "fix" it as part of unrelated changes.

## Testing

- Not Jest. Plain Node scripts under `webapp/test/` run in jsdom against a simulated store and stubbed `fetch` (`webapp/test/harness.js` — extend it when new host globals or API endpoints are needed).
- `test/smoke.js` mounts `src/` directly (fast feedback on render/selectors/handlers). `test/bundle.js` loads the built `dist/main.js` behind a fake plugin host and checks artifact-only properties (self-registration, externals/CSS inlining, WS events, `tgw:disable`, `uninitialize`). Run both; the bundle suite fails without a current `make bundle`.
- `test/browser.js` (`npm run test:browser`) runs the built bundle in headless Chrome (CDP, needs `google-chrome` or `CHROME_PATH`) with a hostile host that grabs focus on route changes. Use it for anything jsdom cannot see: focus behavior and real layout (composer height, `scrollHeight`). Not part of `make test` because CI may lack a browser.
- `npm run preview` regenerates `docs/ui-preview*.html` from the real components — regenerate if you change UI structure or the stylesheet in a user-visible way.
