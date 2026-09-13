/**
 * ビルド:
 *   1. esbuild で src/main-gas.ts をライブラリのソースごと IIFE（グローバル NJA）にまとめる
 *   2. Babel で async/await を取り除き、同期関数にする（scripts/deasync-plugin.mjs）
 *   3. dist/ を作り直し、dist/normalize-japanese-addresses.js に書き出す
 *   4. src/Code.ts の型注釈を取り除いて dist/Code.js に、src/appsscript.json を dist/ にコピーする
 *   5. templates/ の {{token}} を site.config.json で埋めて dist/Sidebar.html と docs/ を生成する
 *   6. バンドルに含まれたパッケージのライセンスを THIRD_PARTY_NOTICES.md にまとめる
 *
 * clasp push の rootDir は dist/（.clasp.json）。dist/ は毎回作り直すので、手で置いた
 * ファイルは消える。push されるのは dist/ の 4 ファイルだけ。
 */
import { build } from 'esbuild'
import babel from '@babel/core'
import ts from 'typescript'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  copyFileSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import deasyncPlugin, { countAsyncConstructs } from './deasync-plugin.mjs'
import { readLicenseSecret } from './license-secret.mjs'

const { transformAsync, parseSync, traverse } = babel

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => join(root, p)
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

const pkg = readJson(rel('package.json'))
const site = readJson(rel('site.config.json'))
const manifest = readJson(rel('src/appsscript.json'))
const libDir = rel('node_modules/@geolonia/normalize-japanese-addresses')
const libPkg = readJson(join(libDir, 'package.json'))

/** 既定の住所データ取得先（自前配信） */
const API_ENDPOINT = pkg.nja.apiEndpoint
/** Geolonia の公開 API。Script Properties での切り替え先として whitelist にも入れておく */
const UPSTREAM_ENDPOINT = pkg.nja.upstreamEndpoint
const GLOBAL_NAME = pkg.nja.globalName
/** ライセンスキーの署名鍵（.license-secret。無ければ開発用） */
const LICENSE = readLicenseSecret()
if (LICENSE.isDev) {
  console.warn(
    '警告: .license-secret が無いので開発用の秘密鍵でビルドします（このビルドは公開しないこと）',
  )
}
if (typeof site.purchaseUrl !== 'string' || !site.purchaseUrl.startsWith('https://')) {
  throw new Error('site.config.json の purchaseUrl は https の URL にしてください')
}
/** clasp push の rootDir。毎回作り直す */
const OUT_DIR = rel('dist')
const OUT_BUNDLE = join(OUT_DIR, 'normalize-japanese-addresses.js')
const OUT_CODE = join(OUT_DIR, 'Code.js')

// ---------------------------------------------------------------------------
// 0. 設定の整合性チェック
// ---------------------------------------------------------------------------
for (const [name, endpoint] of [
  ['nja.apiEndpoint', API_ENDPOINT],
  ['nja.upstreamEndpoint', UPSTREAM_ENDPOINT],
]) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
    throw new Error(`package.json の ${name} が https の URL ではありません`)
  }
  const origin = new URL(endpoint).origin + '/'
  const whitelisted = (manifest.urlFetchWhitelist || []).some((prefix) =>
    origin.startsWith(prefix),
  )
  if (!whitelisted) {
    throw new Error(
      `src/appsscript.json の urlFetchWhitelist に ${origin}（${name}）が含まれていません`,
    )
  }
}

// ---------------------------------------------------------------------------
// 1. esbuild
// ---------------------------------------------------------------------------
const esbuildResult = await build({
  entryPoints: [rel('src/main-gas.ts')],
  bundle: true,
  write: false,
  metafile: true,
  format: 'iife',
  globalName: GLOBAL_NAME,
  platform: 'browser',
  // Apps Script の V8 で確実に動く構文に落とす（private class field, ?., ??= など）
  target: ['es2019'],
  charset: 'utf8',
  minify: false,
  treeShaking: true,
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    __NJA_LIB_VERSION__: JSON.stringify(libPkg.version),
    __NJA_ADDON_VERSION__: JSON.stringify(pkg.version),
    __NJA_API_ENDPOINT__: JSON.stringify(API_ENDPOINT),
    __NJA_UPSTREAM_ENDPOINT__: JSON.stringify(UPSTREAM_ENDPOINT),
    __NJA_LICENSE_SECRET__: JSON.stringify(LICENSE.secret),
    __NJA_LICENSE_SECRET_IS_DEV__: JSON.stringify(LICENSE.isDev),
    __NJA_PURCHASE_URL__: JSON.stringify(site.purchaseUrl),
  },
})
const bundled = esbuildResult.outputFiles[0].text

// ---------------------------------------------------------------------------
// 2. async/await の除去と検証
// ---------------------------------------------------------------------------
const before = countAsyncConstructs(
  parseSync(bundled, { sourceType: 'script', babelrc: false, configFile: false }),
  traverse,
)
const transformed = await transformAsync(bundled, {
  plugins: [deasyncPlugin],
  babelrc: false,
  configFile: false,
  sourceType: 'script',
  compact: false,
  comments: true,
})
const after = countAsyncConstructs(
  parseSync(transformed.code, {
    sourceType: 'script',
    babelrc: false,
    configFile: false,
  }),
  traverse,
)
if (after.asyncFunctions !== 0 || after.awaits !== 0) {
  throw new Error(
    `async/await が残っています: ${JSON.stringify(after)}`,
  )
}
for (const forbidden of ['import(', 'require(', 'process.env']) {
  // esbuild の helper が require を残すのは外部化したときだけ。念のため検出する
  if (transformed.code.includes(`${forbidden}`) && forbidden === 'import(') {
    throw new Error(`バンドルに ${forbidden} が含まれています`)
  }
}

// ---------------------------------------------------------------------------
// 3. 書き出し
// ---------------------------------------------------------------------------
const bundledPackages = collectBundledPackages(esbuildResult.metafile)
const header = `/*
 * normalize-japanese-addresses for Google Apps Script
 * このファイルは scripts/build.mjs が生成します。直接編集しないでください。
 *
 * 元ライブラリ: @geolonia/normalize-japanese-addresses v${libPkg.version}
 *   (MIT License, Copyright 2020 Geolonia Inc.)
 *   https://github.com/geolonia/normalize-japanese-addresses
 * 変更点: fetch を UrlFetchApp + CacheService に差し替え、async/await を除去。
 * 同梱パッケージ: ${bundledPackages.map((p) => `${p.name}@${p.version} (${p.license})`).join(', ')}
 * 詳細は THIRD_PARTY_NOTICES.md を参照。
 */
`
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_BUNDLE, header + transformed.code + '\n')

// ---------------------------------------------------------------------------
// 4. Code.ts → Code.js（型注釈の除去のみ。型検査は `npm run typecheck`）とマニフェスト
// ---------------------------------------------------------------------------
{
  const source = readFileSync(rel('src/Code.ts'), 'utf8')
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: 'Code.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2019,
      module: ts.ModuleKind.ESNext,
      removeComments: false, // @customfunction などの JSDoc を残す
      newLine: ts.NewLineKind.LineFeed,
    },
  })
  if (diagnostics && diagnostics.length > 0) {
    const messages = diagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    )
    throw new Error(`src/Code.ts の変換に失敗しました:\n${messages.join('\n')}`)
  }
  // Apps Script はトップレベル関数をそのまま公開する。モジュール構文が混ざると
  // カスタム関数として認識されなくなるので、import/export は禁止する。
  if (/^\s*(import|export)\b/m.test(outputText)) {
    throw new Error(
      'src/Code.ts に import/export があります。Code.ts はスクリプトとして書いてください',
    )
  }
  writeFileSync(OUT_CODE, outputText)
  copyFileSync(rel('src/appsscript.json'), join(OUT_DIR, 'appsscript.json'))
}

// ---------------------------------------------------------------------------
// 5. テンプレート
// ---------------------------------------------------------------------------
const tokens = {
  ...site,
  libVersion: libPkg.version,
  addonVersion: pkg.version,
  apiEndpoint: API_ENDPOINT,
  apiHost: new URL(API_ENDPOINT).host,
  upstreamEndpoint: UPSTREAM_ENDPOINT,
  upstreamHost: new URL(UPSTREAM_ENDPOINT).host,
}
renderTemplate(rel('templates/Sidebar.html'), join(OUT_DIR, 'Sidebar.html'), tokens)
mkdirSync(rel('docs'), { recursive: true })
for (const file of readdirSync(rel('templates/site'))) {
  const src = rel(`templates/site/${file}`)
  const dst = rel(`docs/${file}`)
  if (file.endsWith('.html')) {
    renderTemplate(src, dst, tokens)
  } else {
    writeFileSync(dst, readFileSync(src))
  }
}

// ---------------------------------------------------------------------------
// 6. サードパーティ表記
// ---------------------------------------------------------------------------
writeThirdPartyNotices(bundledPackages)

// ---------------------------------------------------------------------------
console.log(
  [
    `bundle: dist/normalize-japanese-addresses.js (${kb(statSync(OUT_BUNDLE).size)} KB)`,
    `async removed: ${before.asyncFunctions} functions, ${before.awaits} awaits`,
    `code: dist/Code.js (from src/Code.ts)`,
    `library: @geolonia/normalize-japanese-addresses@${libPkg.version}`,
    `endpoint: ${API_ENDPOINT}`,
    `license secret: ${LICENSE.isDev ? 'DEV (not for release)' : '.license-secret'}`,
    `templates: dist/Sidebar.html, docs/`,
    `push root: dist/ (${readdirSync(OUT_DIR).sort().join(', ')})`,
  ].join('\n'),
)

// ---------------------------------------------------------------------------
function kb(n) {
  return Math.round(n / 1024)
}

function renderTemplate(src, dst, values) {
  const text = readFileSync(src, 'utf8')
  const missing = new Set()
  const out = text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name) => {
    if (!(name in values)) {
      missing.add(name)
      return m
    }
    return String(values[name])
  })
  if (missing.size > 0) {
    throw new Error(
      `${basename(src)}: 未定義のトークン {{${[...missing].join('}}, {{')}}}`,
    )
  }
  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, out)
}

function collectBundledPackages(metafile) {
  // 入力パスから「最後の node_modules/<pkg>」を取る（依存の中にネストされたパッケージも拾う）
  const dirs = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    const m = input.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//)
    if (m && !dirs.has(m[1])) dirs.set(m[1], m[2])
  }
  return [...dirs.entries()]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([dirRel, name]) => {
      const dir = rel(dirRel)
      const p = readJson(join(dir, 'package.json'))
      const licenseFile = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f))
      return {
        name,
        version: p.version,
        license: p.license || 'UNKNOWN',
        homepage: p.homepage || p.repository?.url || '',
        licenseText: licenseFile
          ? readFileSync(join(dir, licenseFile), 'utf8').trim()
          : '(license file not included in the package)',
      }
    })
}

function writeThirdPartyNotices(packages) {
  const lines = [
    '# Third-party notices',
    '',
    'このファイルは scripts/build.mjs が生成します。',
    '',
    '## データ',
    '',
    '- 住所データ: [Geolonia 住所データ v2 (japanese-addresses-v2)](https://github.com/geolonia/japanese-addresses-v2)。',
    '  デジタル庁「[アドレス・ベース・レジストリ](https://www.digital.go.jp/policies/base_registry_address)」を元に Geolonia Inc. が加工・配信しているものです。',
    `- 取得先: ${API_ENDPOINT}`,
    '',
    '## バンドルに含まれるパッケージ',
    '',
  ]
  for (const p of packages) {
    lines.push(`### ${p.name}@${p.version}`, '', `License: ${p.license}  `)
    if (p.homepage) lines.push(`Homepage: ${p.homepage}`)
    lines.push('', '```', p.licenseText, '```', '')
  }
  writeFileSync(rel('THIRD_PARTY_NOTICES.md'), lines.join('\n'))
}
