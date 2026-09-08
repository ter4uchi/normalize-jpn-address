/**
 * テスト用の同期 HTTP GET。
 * UrlFetchApp は同期 API なので、モックも同期でなければならない。
 * Node には同期 fetch が無いため、子プロセスで fetch して結果を受け取る。
 * 取得結果は .cache/http/ にディスクキャッシュする（初回のみネットワークが必要）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CACHE_DIR = fileURLToPath(new URL('../.cache/http/', import.meta.url))

const CHILD_SCRIPT = `
const fs = require('node:fs');
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
fetch(req.url, { headers: req.headers, redirect: 'follow' })
  .then(async (r) => {
    const body = Buffer.from(await r.arrayBuffer());
    process.stdout.write(JSON.stringify({
      status: r.status,
      headers: Object.fromEntries(r.headers),
      body: body.toString('base64'),
    }));
  })
  .catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
`

/**
 * @param {string} url
 * @param {Record<string,string>} headers
 * @returns {{ status: number, headers: Record<string,string>, body: Buffer }}
 */
export function syncHttpGet(url, headers = {}) {
  const key = createHash('md5')
    .update(url + '\n' + JSON.stringify(headers))
    .digest('hex')
  const file = `${CACHE_DIR}${key}.json`
  let record
  if (existsSync(file)) {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } else {
    const res = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
      input: JSON.stringify({ url, headers }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (res.status !== 0) {
      throw new Error(`HTTP GET failed for ${url}: ${res.stderr}`)
    }
    record = JSON.parse(res.stdout)
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify(record))
  }
  return {
    status: record.status,
    headers: record.headers,
    body: Buffer.from(record.body, 'base64'),
  }
}
