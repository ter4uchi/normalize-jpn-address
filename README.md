# normalize-jpn-address

Google スプレッドシート用アドオン。[Geolonia normalize-japanese-addresses](https://github.com/geolonia/normalize-japanese-addresses) をカスタム関数 `NORMALZE_JPN_ADDRESS()` として使えるようにします。

```
=NORMALZE_JPN_ADDRESS("東京都千代田区千代田１−１", 8)
=NORMALZE_JPN_ADDRESS(A2)
=NORMALZE_JPN_ADDRESS(A2:A1000)
```

- 第1引数: 住所文字列、または 1 列か 1 行の範囲。
- 第2引数（省略可、既定 8）: 許容する最小の正規化レベル（0, 1, 2, 3, 8）。結果がこれに満たない住所はエラー。
- 戻り値: 正規化した住所の文字列（都道府県 + 市区町村 + 町丁目 + 番地・号 + その他）。

利用者向けの説明は [docs/index.html](docs/index.html)（GitHub Pages 用）とサイドバー（`templates/Sidebar.html`）にあります。

## 仕組み

Geolonia を再実装せず、ライブラリのソースをそのまま取り込んで Apps Script 互換の I/O を差し込んでいます。

1. **I/O の注入**: ライブラリは `__internals.fetch`（`src/config.ts`）だけを通して住所データを読みます。Node 版エントリ（`main-node.ts`）がそこを差し替えているのと同じ形で、`src/main-gas.ts` が UrlFetchApp + CacheService 実装（`src/gas-fetch.ts`）を差し込みます。配布済み UMD バンドルは `__internals` を公開していないため、ソースからバンドルし直します。
2. **同期化**: Apps Script のカスタム関数は Promise を返せません。ライブラリ内の非同期処理は「fetch を await する」だけで、`Promise.all` や `.then` は使われていないので、ビルド時に Babel で `async`/`await` を機械的に除去して同期関数にしています（`scripts/deasync-plugin.mjs`）。UrlFetchApp は同期なので意味は変わりません。
3. **キャッシュ**: 取得した住所データはスクリプトキャッシュ（全ユーザー共有、最大 6 時間）に保存します。1 値 100KB の制限があるため、gzip + base64 にして 90,000 文字ごとに分割保存します。
4. **バンドル**: esbuild で `es2019` に落として IIFE（グローバル `NJA`）にします。lru-cache のプライベートフィールドなどはここで変換されます。

Apps Script に push されるのは `gas/` の 4 ファイルです。

| ファイル | 内容 |
|---|---|
| `gas/appsscript.json` | マニフェスト（スコープ、`urlFetchWhitelist`） |
| `gas/Code.js` | カスタム関数、メニュー、サイドバー表示 |
| `gas/normalize-japanese-addresses.js` | ビルド生成物（ライブラリ + I/O 層、同期化済み） |
| `gas/Sidebar.html` | ビルド生成物（`templates/Sidebar.html` + `site.config.json`） |

## セットアップ

```sh
npm ci
npm run build      # gas/normalize-japanese-addresses.js, gas/Sidebar.html, docs/, THIRD_PARTY_NOTICES.md を生成
npm test           # ビルドしてテスト
npm run typecheck  # tsc
```

テストは Node の `vm` で「素の V8 コンテキスト」を作り、UrlFetchApp / CacheService / Utilities のモックを与えて `gas/` のファイルをそのまま実行します。`setTimeout` や `fetch` が無い点まで Apps Script と揃えているので、ブラウザ API への依存があればここで落ちます。初回は Geolonia の API に実際にアクセスし、結果を `.cache/http/` に保存します。

## Apps Script へのデプロイ

```sh
npx clasp login
npx clasp create --type standalone --title "日本の住所正規化関数" --rootDir gas
# 既存のスクリプトに紐付ける場合は .clasp.json.example をコピーして scriptId を書く
npm run push       # ビルドしてから clasp push
npx clasp open
```

スクリプトエディタで `njaSelfTest` を実行すると、サンプル住所の結果と通信回数がログに出ます。

アドオンとして試すには、スクリプトエディタの「デプロイ > デプロイをテスト」で「エディタ アドオン」を選び、テスト用スプレッドシートにインストールします。「拡張機能」メニューに「使い方」が出て、セルで `=NORMALZE_JPN_ADDRESS(...)` が使えれば成功です。

## Marketplace 公開

1. `site.config.json` の `TODO_` を埋めて `npm run build` し、`docs/` を GitHub Pages で公開する（設定: Pages → Source: `docs/`）。
2. `LICENSE` の著作権者を書く。
3. Google Cloud プロジェクトを作り、Apps Script プロジェクトに紐付ける（設定 → GCP プロジェクト）。
4. OAuth 同意画面を設定する（アプリ名、サポートメール、ホームページ = `docs/index.html` の URL、プライバシーポリシー = `privacy.html`、利用規約 = `terms.html`、スコープは `gas/appsscript.json` と同じ 3 つ）。
5. Google Workspace Marketplace SDK を有効にし、アプリ構成で「Sheets アドオン」にデプロイ ID（`clasp deploy` で作成）を設定する。
6. ストア掲載情報（名前、説明、アイコン 128px、スクリーンショット、サポート URL = `support.html`）を入力して審査に出す。

`urlFetchWhitelist` に Geolonia のドメインを入れてあるので、住所データの取得先を変えるときは `package.json` の `nja.apiEndpoint` と `gas/appsscript.json` の両方を変えてください（ビルド時に整合性を検査します）。

## サイトとサイドバーの文言

`templates/` が元で、`docs/` と `gas/Sidebar.html` は生成物です。`{{token}}` は `site.config.json` の値と `libVersion` / `addonVersion` / `apiEndpoint` / `apiHost` で置き換えられ、未定義のトークンがあるとビルドが失敗します。

## ライブラリの更新

```sh
npm install --save-exact @geolonia/normalize-japanese-addresses@<version>
npm test
```

`src/main-gas.ts` と `src/gas-fetch.ts` は `node_modules/@geolonia/normalize-japanese-addresses/src/` を直接 import しています。ライブラリ側の `__internals.fetch` の型（`FetchLike`）が変わったら `npm run typecheck` で検出できます。async/await 以外の非同期構文（`Promise.all` など）が追加された場合はテストが落ちるので、そのときは同期化の方法を見直してください。

## 設計上の判断と制限

- **戻り値は住所文字列のみ**。緯度経度やレベルは返しません（結果オブジェクトは `NJA.normalize()` から取れるので、必要なら別関数を足せます）。
- **エラーの扱い**: 単セル入力はスローして `#ERROR!`（`IFERROR` が効く）、範囲入力は行ごとに `#LEVEL …` / `#ERROR …` / `#TIMEOUT …` の文字列（1 行の失敗で全体を止めない）。
- **第2引数はライブラリの正規化深度も兼ねる**: 0〜3 なら町丁目まで（市区町村ごとに 1 回の通信）、それ以上なら番地・号まで（町丁目ごとに Range 取得が 1 回増える）。
- **時間制限**: カスタム関数は 1 回 30 秒。範囲処理は 22 秒を目安に残りの行へ `#TIMEOUT` を入れて部分結果を返します。
- **データの整備状況**: 住居表示地区でも住居表示データが無い町丁目（東京都区部の一部など）はレベル 8 になりません。ライブラリが住居表示側しか見ないためです（`normalize.ts` の TODO 参照）。
- **住所データの提供元**: Geolonia が無償で公開している API を使います。Geolonia は商用稼働では自前ホストを推奨しています（[japanese-addresses-v2 README](https://github.com/geolonia/japanese-addresses-v2#api)）。

## ライセンス

MIT。同梱しているライブラリのライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。住所データはデジタル庁「アドレス・ベース・レジストリ」を元に Geolonia Inc. が整備・配信しているものです。
