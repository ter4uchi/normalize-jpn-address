/**
 * 住所データ配信サーバーの動作確認。
 *
 *   npm run check:api                 # package.json の nja.apiEndpoint（自前配信）
 *   npm run check:api -- <endpoint>   # 任意の取得先（…/api/ja まで）
 *
 * アドオンが実際に出す 3 種類のリクエストを投げて、ステータス、サイズ、Range 対応、
 * Cache-Control、gzip の有無を表示する。R2 + Cache Rule の設定後や、Geolonia の
 * 公開 API との比較に使う。失敗があれば終了コード 1。
 */
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
const endpoint = (process.argv[2] || pkg.nja.apiEndpoint).replace(/\/+$/, '')

/** 実際にライブラリが組み立てる URL（cacheRegexes.ts）と同じ形 */
const checks = [
  { name: '都道府県・市区町村一覧', path: '.json' },
  { name: '町丁目一覧', path: '/' + encodeURI('岩手県/盛岡市') + '.json' },
  {
    name: '住居表示（Range 先頭 1KB）',
    path: '/' + encodeURI('岩手県/盛岡市-住居表示') + '.txt',
    range: 'bytes=0-1023',
  },
]

const pick = (headers, names) =>
  Object.fromEntries(
    names.map((n) => [n, headers.get(n)]).filter(([, v]) => v !== null),
  )

let failed = false
console.log(`endpoint: ${endpoint}`)
for (const c of checks) {
  const url = endpoint + c.path
  const headers = { 'accept-encoding': 'gzip' }
  if (c.range) headers.range = c.range
  const started = Date.now()
  let res
  try {
    res = await fetch(url, { headers, redirect: 'manual' })
  } catch (e) {
    failed = true
    console.log(`\n[NG] ${c.name}\n  ${url}\n  ${e.message}`)
    continue
  }
  const body = Buffer.from(await res.arrayBuffer())
  const ms = Date.now() - started
  const info = pick(res.headers, [
    'content-length',
    'content-type',
    'content-encoding',
    'accept-ranges',
    'content-range',
    'cache-control',
    'cf-cache-status',
    'server',
  ])
  const expected = c.range ? 206 : 200
  let ok = res.status === expected
  let note = ''
  if (c.range && res.status === 200) {
    // アドオン側で切り出すので動作はするが、毎回ファイル全体（数 MB）を転送してしまう
    note = 'Range が無視されています（動作はするが転送量が増える）'
    ok = false
  }
  if (ok && !c.range) {
    try {
      JSON.parse(body.toString('utf8'))
    } catch {
      ok = false
      note = 'JSON として読めません'
    }
  }
  if (!ok) failed = true
  console.log(
    `\n[${ok ? 'OK' : 'NG'}] ${c.name} ${res.status} ${body.length} bytes ${ms}ms${note ? ' - ' + note : ''}\n  ${url}`,
  )
  for (const [k, v] of Object.entries(info)) console.log(`  ${k}: ${v}`)
}
process.exit(failed ? 1 : 0)
