/**
 * ライセンスキーを手動で発行する（テスター向け、決済の障害時、購入者が別の Google アカウントへ移ったときなど）。
 * キーは Google アカウントの sub から導出するので、相手の sub が要る。
 * サイドバーの「ユーザー ID」に表示される数字を教えてもらう。
 *
 *   npm run license:issue -- --sub 123456789012345678901              # 発行
 *   npm run license:issue -- --sub 1234… --verify NJA-XXXXX-XXXXX-XXXXX-XXXXX   # 検証だけ
 *
 * 通常の発行は決済完了ページ（functions/license/thanks.js、Cloudflare Pages Functions）が行う。
 * .license-secret が無いと開発用の鍵で作られ、本番のアドオンでは通らないので警告を出す。
 */
import { isGoogleSub, issueLicenseKey, verifyLicenseKey } from './license-core.mjs'
import { readLicenseSecret } from './license-secret.mjs'

const args = process.argv.slice(2)
const { secret, isDev } = readLicenseSecret()
if (isDev) {
  console.error('警告: .license-secret が無いため開発用の鍵を使っています。本番では通りません。')
}

const subAt = args.indexOf('--sub')
const sub = subAt >= 0 ? args[subAt + 1] : undefined
if (!isGoogleSub(sub)) {
  console.error('使い方: npm run license:issue -- --sub <Google アカウントの sub（数字）> [--verify <キー>]')
  process.exit(2)
}

const verifyAt = args.indexOf('--verify')
if (verifyAt >= 0) {
  const key = args[verifyAt + 1]
  const ok = verifyLicenseKey(secret, sub, key)
  console.log(`${key}: ${ok ? '有効（sub ' + sub + ' 用）' : '無効'}`)
  process.exit(ok ? 0 : 1)
}

console.log(issueLicenseKey(secret, sub))
