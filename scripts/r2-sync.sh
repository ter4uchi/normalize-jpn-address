#!/usr/bin/env bash
# 生成した住所データ API を Cloudflare R2 に同期する。
#
#   scripts/r2-sync.sh <japanese-addresses-v2 の api ディレクトリ> [rclone リモート:バケット]
#   例: scripts/r2-sync.sh ../japanese-addresses-v2/api r2:normalize-jpn-address
#
# 前提:
#   - rclone がインストール済みで、R2 用のリモート（既定名 r2）が設定済みであること。
#     rclone config で type=s3, provider=Cloudflare, endpoint=https://<account id>.r2.cloudflarestorage.com,
#     access_key_id / secret_access_key に R2 API トークンを入れる。
#   - <api ディレクトリ> の直下に ja.json と ja/ があること（japanese-addresses-v2 の npm run run:all の出力）。
#
# バケット内は api/ja.json, api/ja/... という配置になり、独自ドメインを付けると
# https://<ドメイン>/api/ja.json で読める（package.json の nja.apiEndpoint = https://<ドメイン>/api/ja）。
#
# Cache-Control は Geolonia の公開 API と同じ 1 日にする。R2 はオブジェクトのメタデータとして保持し、
# 独自ドメイン経由の応答ヘッダーに載せる。エッジキャッシュは Cloudflare 側の Cache Rule で設定する。
set -euo pipefail

SRC="${1:?api ディレクトリを指定してください}"
DEST="${2:-r2:normalize-jpn-address}"

if [[ ! -f "$SRC/ja.json" || ! -d "$SRC/ja" ]]; then
  echo "エラー: $SRC に ja.json と ja/ がありません" >&2
  exit 1
fi

echo "同期: $SRC -> $DEST/api"
rclone sync "$SRC" "$DEST/api" \
  --include 'ja.json' \
  --include 'ja/**' \
  --header-upload 'Cache-Control: public, max-age=86400' \
  --s3-no-check-bucket \
  --checksum \
  --transfers 16 \
  --checkers 32 \
  --fast-list \
  --progress \
  --stats-one-line

echo "完了。動作確認: npm run check:api"
