/**
 * ビルド:
 *   1. esbuild で src/main-gas.ts をライブラリのソースごと IIFE（グローバル NJA）にまとめる
 *   2. Babel で async/await を取り除き、同期関数にする（scripts/deasync-plugin.mjs）
 *   3. gas/normalize-japanese-addresses.js に書き出す
 *   4. templates/ の {{token}} を site.config.json で埋めて gas/Sidebar.html と docs/ を生成する
 *   5. バンドルに含まれたパッケージのライセンスを THIRD_PARTY_NOTICES.md にまとめる
 */
import { build } from 'esbuild'
import babel from '@babel/core'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import deasyncPlugin, { countAsyncConstructs } from './deasync-plugin.mjs'

const { transformAsync, parseSync, traverse } = babel

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => join(root, p)
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

const pkg = readJson(rel('package.json'))
const site = readJson(rel('site.config.json'))
const manifest = readJson(rel('gas/appsscript.json'))
const libDir = rel('node_modules/@geolonia/normalize-japanese-addresses')
const libPkg = readJson(join(libDir, 'package.json'))

const API_ENDPOINT = pkg.nja.apiEndpoint
const GLOBAL_NAME = pkg.nja.globalName
const OUT_BUNDLE = rel('gas/normalize-japanese-addresses.js')

// ---------------------------------------------------------------------------
// 0. 設定の整合性チェック
// ---------------------------------------------------------------------------
{
  const origin = new URL(API_ENDPOINT).origin + '/'
  const whitelisted = (manifest.urlFetchWhitelist || []).some((prefix) =>
    origin.startsWith(prefix),
  )
  if (!whitelisted) {
    throw new Error(
      `gas/appsscript.json の urlFetchWhitelist に ${origin} が含まれていません`,
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
mkdirSync(dirname(OUT_BUNDLE), { recursive: true })
writeFileSync(OUT_BUNDLE, header + transformed.code + '\n')

// ---------------------------------------------------------------------------
// 4. テンプレート
// ---------------------------------------------------------------------------
const tokens = {
  ...site,
  libVersion: libPkg.version,
  addonVersion: pkg.version,
  apiEndpoint: API_ENDPOINT,
  apiHost: new URL(API_ENDPOINT).host,
}
renderTemplate(rel('templates/Sidebar.html'), rel('gas/Sidebar.html'), tokens)
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
// 5. サードパーティ表記
// ---------------------------------------------------------------------------
writeThirdPartyNotices(bundledPackages)

// ---------------------------------------------------------------------------
console.log(
  [
    `bundle: gas/normalize-japanese-addresses.js (${kb(statSync(OUT_BUNDLE).size)} KB)`,
    `async removed: ${before.asyncFunctions} functions, ${before.awaits} awaits`,
    `library: @geolonia/normalize-japanese-addresses@${libPkg.version}`,
    `endpoint: ${API_ENDPOINT}`,
    `templates: gas/Sidebar.html, docs/`,
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
