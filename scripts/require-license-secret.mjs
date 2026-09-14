/**
 * npm run push の前段。開発用の秘密鍵で署名したビルドを Apps Script に push しないための検査。
 * .license-secret を作るには:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > .license-secret
 */
import { readLicenseSecret, SECRET_PATH } from './license-secret.mjs'

const { isDev } = readLicenseSecret()
if (isDev) {
  console.error(
    `.license-secret がありません（${SECRET_PATH}）。\n` +
      '本番の秘密鍵を作ってから push してください:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" > .license-secret\n' +
      '同じ値を Cloudflare Worker の NJA_LICENSE_SECRET にも設定します。',
  )
  process.exit(1)
}
