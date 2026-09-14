/**
 * ライセンスキーを手動で発行する（返金後の再発行、テスター向け、決済の障害時など）。
 *
 *   npm run license:issue            # 1 つ
 *   npm run license:issue -- 5       # 5 つ
 *   npm run license:issue -- --id ABCDE234   # ID を指定（決済セッションから決定的に作る場合と同じ形）
 *   npm run license:issue -- --verify NJA-XXXXX-XXXXX-XXXXX-XXXXX   # 検証だけ
 *
 * 通常の発行は Cloudflare Worker（worker/license-worker.mjs）が決済完了ページで行う。
 * .license-secret が無いと開発用の鍵で作られ、本番のアドオンでは通らないので警告を出す。
 */
import { issueLicenseKey, verifyLicenseKey } from './license-core.mjs'
import { readLicenseSecret } from './license-secret.mjs'

const args = process.argv.slice(2)
const { secret, isDev } = readLicenseSecret()
if (isDev) {
  console.error('警告: .license-secret が無いため開発用の鍵を使っています。本番では通りません。')
}

const verifyAt = args.indexOf('--verify')
if (verifyAt >= 0) {
  const key = args[verifyAt + 1]
  const ok = verifyLicenseKey(secret, key)
  console.log(`${key}: ${ok ? '有効' : '無効'}`)
  process.exit(ok ? 0 : 1)
}

const idAt = args.indexOf('--id')
if (idAt >= 0) {
  console.log(issueLicenseKey(secret, args[idAt + 1]))
  process.exit(0)
}

const count = Math.max(1, parseInt(args[0] || '1', 10) || 1)
for (let i = 0; i < count; i++) {
  console.log(issueLicenseKey(secret))
}
