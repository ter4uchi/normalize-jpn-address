# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Google Sheets add-on exposing `NORMALIZE_JPN_ADDRESS()` as a custom function (plus `NORMALZE_JPN_ADDRESS()`, the original misspelled name, kept as a compatibility alias; never remove it), and licensed extras `NORMALIZE_JPN_ADDRESS_MAP()` (Google Maps URL) and `NORMALIZE_JPN_ADDRESS_LATLNG()`. It wraps `@geolonia/normalize-japanese-addresses` for Google Apps Script (GAS). Code comments and docs are in Japanese; keep that convention.

Business model (decided 2026-09-12): free = levels 0–3 (the plain library behaviour); paid one-time ¥500 license = levels 4–8 and the `_MAP` / `_LATLNG` functions. The split is deliberate: the user did not want to charge for merely wrapping Geolonia's code, so the paid tier is the costly 番地/号 data plus features built on top of it.

Add-on menu (`onOpen` in `src/Code.ts`): 「選択範囲を正規化」(`njaMenuNormalize`, free; licensed users get 番地/号 depth) and 「選択範囲に地図リンクを付ける」(`njaMenuMapLinks`, licensed) both run `njaMenuRun_`: take the selected single column, write results as *values* into the column(s) to the right (2 cols: address + reached level, or 1 col: rich-text 「地図」link; below level 8 the text is 「地図（概略）」), ask before overwriting, no threshold (level 0), flush every `NJA_MENU_FLUSH_ROWS` rows against the 6-minute limit (`NJA_MENU_BUDGET_MS`, test override `menuBudgetMs`). Custom functions cannot write cells or return links, which is why this exists.

## Commands

```sh
npm ci
npm run build        # scripts/build.mjs → dist/ (Code.js, normalize-japanese-addresses.js, Sidebar.html, appsscript.json), docs/, THIRD_PARTY_NOTICES.md
npm test             # build, then node --test test/*.test.mjs
npm run typecheck    # tsc --noEmit (src/**/*.ts, including Code.ts)
npm run push         # refuses without .license-secret, then build, then clasp push --force (needs .clasp.json at repo root; see .clasp.json.example). --force skips the manifest-overwrite prompt; the local manifest is the source of truth
npm run check:api    # probe the address-data server (default: nja.apiEndpoint; pass another URL as an argument)
npm run license:issue -- [n | --id ID | --verify KEY]   # issue/verify license keys with .license-secret (dev secret if absent)
```

Run a single test file or test name (build first, since tests execute the generated `dist/` files):

```sh
npm run build && node --test test/normalize.test.mjs
npm run build && node --test --test-name-pattern="範囲" test/normalize.test.mjs
```

Tests make real HTTP requests to the Geolonia API on first run and cache responses in `.cache/http/` (gitignored). Delete that directory to force re-fetching.

## Architecture

The core idea: rather than reimplementing Geolonia, bundle the library **from its TypeScript source** (not the published UMD, which hides `__internals`) and inject GAS-compatible I/O, then strip `async`/`await` so the result is a synchronous function that a custom function can call.

Pipeline (`scripts/build.mjs`):

1. **Config check**: `package.json` `nja.apiEndpoint` (self-hosted Cloudflare R2 mirror, the default) and `nja.upstreamEndpoint` (Geolonia's public API, the fallback) must both be covered by `urlFetchWhitelist` in `src/appsscript.json`. Changing either requires editing both files.
2. **esbuild**: `src/main-gas.ts` → IIFE with global `NJA`, target es2019 (GAS V8 lacks private class fields, `?.`, `??=`). Injects `__NJA_LIB_VERSION__`, `__NJA_ADDON_VERSION__`, `__NJA_API_ENDPOINT__`, `__NJA_UPSTREAM_ENDPOINT__` via `define`.
3. **Babel deasync** (`scripts/deasync-plugin.mjs`): mechanically removes every `async` keyword and `await` expression. Build fails if any remain. This is only sound because the sole I/O (`UrlFetchApp.fetch`) is synchronous and the library uses only `await fetch(...)`, never `Promise.all` / `.then`.
4. **Code.ts transpile**: `src/Code.ts` → `dist/Code.js` via `ts.transpileModule` (type stripping only, comments kept so `@customfunction` JSDoc survives). Build fails if the output contains `import`/`export`, because Apps Script only exposes top-level functions of plain scripts. Type checking of Code.ts happens in `npm run typecheck`, not in the build.
5. **Templates**: `templates/Sidebar.html` and `templates/site/*.html` are rendered with `{{token}}` from `site.config.json` plus `libVersion`, `addonVersion`, `apiEndpoint`, `apiHost`. Unknown tokens fail the build.
6. **License notices**: generated from esbuild's metafile.

`dist/` is deleted and recreated on every build; `src/appsscript.json` is copied in unchanged.

Layers:

- `src/gas-fetch.ts`: `FetchLike` implementation using `UrlFetchApp` + `CacheService` (script cache, 6h TTL). Values >20k chars are gzip+base64; anything over 90k chars is split into chunks with an `M<count>` header record. Cache failures are swallowed (best effort). Handles servers that ignore `Range` by slicing bytes locally.
- `src/main-gas.ts`: imports library source directly from `node_modules/@geolonia/normalize-japanese-addresses/src/`, sets `currentConfig.japaneseAddressesApi` and `__internals.fetch = gasFetch`, exports `normalize`, `stats`, versions, and the endpoints. The endpoint is resolved at load: Script Property `NJA_API_ENDPOINT` (https only, trailing slash stripped) overrides the build-time default, so the operator can fail over to Geolonia without a redeploy. Also exports the `NjaGlobal` type: the shape of global `NJA` *after* deasync (`normalize` returns `NormalizeResult`, not a Promise). Keep it in sync with the `export const`s.
- Address data hosting: `scripts/r2-sync.sh` (rclone → R2) and `scripts/check-api.mjs` (`npm run check:api`, probes the three request shapes the add-on makes, expects 206 for Range). See README「住所データの配信」.
- Licensing: keys are self-validating (`NJA-` + base32 of 8-char id + 12-char truncated HMAC-SHA256), verified offline. Three implementations must stay identical: `src/license.ts` (GAS, `Utilities.computeHmacSha256Signature`), `scripts/license-core.mjs` (Node, used by tests and `issue-license.mjs`), `worker/license-worker.mjs` (Web Crypto, Stripe success page). The secret comes from `.license-secret` (gitignored) via `scripts/license-secret.mjs`; without it, build/test use a dev secret and `npm run push` refuses. `src/Code.ts` reads the key from UserProperties then DocumentProperties, memoizes per execution, and throws (also for range input) when a paid feature is requested without one. Sidebar calls `njaGetLicenseStatus` / `njaSetLicenseKey` / `njaClearLicenseKey` via `google.script.run`.
- `src/Code.ts`: TypeScript **script** (no `import`/`export`; uses `declare const NJA: import('./main-gas').NjaGlobal` for typing). Cell I/O, argument validation, range handling, error formatting, add-on menu/sidebar, and `njaSelfTest` for the script editor. Functions ending in `_` are GAS-private. Top-level `const`s are fine: Apps Script files share one global scope, as do the scripts in the `vm` test context.

What gets pushed to Apps Script is exactly the four files in `dist/`, all generated and gitignored. `docs/` and `THIRD_PARTY_NOTICES.md` are also generated but committed.

## Rules that follow from the design

- In `src/*.ts`, write I/O with `async`/`await` only. Never use `Promise.resolve()`, `.then()`, `Promise.all`, or `for await` in a way that can't be reduced by dropping the keywords. The build will succeed but the runtime result would be a Promise; `Code.js` detects this and throws "同期化されていません".
- Do not edit anything in `dist/`, `docs/*.html`, or `THIRD_PARTY_NOTICES.md` by hand. Edit `src/`, `templates/`, or `site.config.json` and rebuild.
- `src/Code.ts` is only type-stripped, never bundled: no `import`/`export`, no npm dependencies, no helpers that would need a runtime. It must load in the bare `vm` test context (no `setTimeout`, `fetch`, `URL`, `TextDecoder`, `process`, etc.). Keep it free of Node/browser globals; the test asserts these are absent. Note `tsconfig.json` has `lib: DOM`, so the type checker will *not* catch use of browser globals there; the test does.
- Error semantics are deliberate: single-cell input throws (Sheets shows `#ERROR!`, `IFERROR` works); range input returns per-row strings `#LEVEL …`, `#ERROR …`, `#TIMEOUT …` so one bad row doesn't fail the batch. Range processing stops at `NJA_BATCH_BUDGET_MS` (22s) against the 30s custom-function limit.
- The `level` argument doubles as the library's normalization depth: 0–3 stops at town level (one request per city), 4–8 requests 番地/号 data (extra Range fetch per town) and is then compared as a threshold.

## Test harness

`test/gas-env.mjs` creates a bare `vm` context seeded only with mocked GAS services (`test/gas-mocks.mjs`), asserts host globals are absent, then evaluates the built bundle and `Code.js` in it. One `createGasEnv()` ≈ one custom-function execution; pass a shared `cacheStore` Map to simulate cross-execution CacheService behaviour. By default the env seeds Script Property `NJA_API_ENDPOINT` with `TEST_API_ENDPOINT` (env var `NJA_TEST_API_ENDPOINT`, else Geolonia's `nja.upstreamEndpoint`) so tests pass even while the self-hosted mirror is down or not yet built; pass `scriptProperties: null` to test the build-time default. Envs are unlicensed by default; pass `licensed: true` (seeds `VALID_LICENSE_KEY` in UserProperties) for any test that uses level ≥ 4 or the `_MAP` / `_LATLNG` functions. The `SpreadsheetApp` mock holds one in-memory sheet: pass `spreadsheet: { values, selection, alertResponse }` and inspect `env.sheet` (`cells`, `rich`, `alerts`, `menuItems`) to test the menu actions. Mocks reproduce real GAS quirks (signed byte arrays, 250-char key / 100KB value cache limits). `test/sync-http.mjs` gives the mock `UrlFetchApp` a synchronous HTTP GET by spawning a child Node process. Set `NJA_TEST_OPTIONS.batchBudgetMs` via `testOptions` to exercise timeout paths.

## Updating the Geolonia library

```sh
npm install --save-exact @geolonia/normalize-japanese-addresses@<version>
npm run typecheck && npm test
```

The version is pinned exactly and asserted in the tests (`libraryVersion`). `src/` imports the library's internal `src/config` and `src/normalize`; if `FetchLike` changes, typecheck catches it. If the library introduces non-`await` async constructs, tests fail and the deasync approach needs revisiting.
