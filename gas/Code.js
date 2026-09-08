/**
 * NORMALZE_JPN_ADDRESS — Google スプレッドシート用カスタム関数
 *
 * 正規化本体は gas/normalize-japanese-addresses.js（ビルド生成物）で、
 * グローバル `NJA` として読み込まれる。ここではセル入出力とエラー処理だけを行う。
 *
 * 命名規則: 末尾が `_` の関数は Apps Script の非公開関数（セルやメニューから呼べない）。
 */

/* global NJA, SpreadsheetApp, HtmlService, Logger */

/** 第2引数省略時の許容レベル */
var NJA_DEFAULT_LEVEL = 8;
/** ライブラリが返す最大レベル（番地・号） */
var NJA_MAX_LEVEL = 8;
/** 町丁目レベル */
var NJA_TOWN_LEVEL = 3;
/** カスタム関数の上限（30 秒）に対して余裕を持たせた処理時間の目安 */
var NJA_BATCH_BUDGET_MS = 22000;

/**
 * 日本の住所を正規化します（Geolonia normalize-japanese-addresses を使用）。
 *
 * @param {"東京都千代田区千代田１−１"} address 住所の文字列、または 1 列か 1 行のセル範囲（例: A2:A1000）。
 * @param {8} level 省略可。許容する最小の正規化レベル（0, 1, 2, 3, 8）。結果がこのレベルに満たない場合はエラー。省略時は 8。
 * @return 正規化した住所（都道府県 + 市区町村 + 町丁目 + 番地・号 + その他）。
 * @customfunction
 */
function NORMALZE_JPN_ADDRESS(address, level) {
  var required = njaParseLevel_(level);

  if (Array.isArray(address)) {
    return njaNormalizeRange_(address, required);
  }

  var text = njaToText_(address);
  if (text === '') {
    return '';
  }
  var r = njaNormalizeOne_(text, required);
  if (r.error) {
    throw new Error(r.error.message);
  }
  return r.value;
}

// ---------------------------------------------------------------------------
// 引数の解釈
// ---------------------------------------------------------------------------

function njaParseLevel_(level) {
  if (level === undefined || level === null || level === '') {
    return NJA_DEFAULT_LEVEL;
  }
  if (Array.isArray(level)) {
    throw new Error('第2引数（level）には範囲ではなく数値を指定してください');
  }
  var n = typeof level === 'number' ? level : Number(String(level).trim());
  if (!isFinite(n) || Math.floor(n) !== n || n < 0 || n > NJA_MAX_LEVEL) {
    throw new Error(
      '第2引数（level）は 0〜8 の整数で指定してください（意味を持つ値は 0, 1, 2, 3, 8）'
    );
  }
  return n;
}

/**
 * ライブラリに渡す正規化の深さ。
 * 0〜3 は町丁目まで（市区町村ごとに 1 回の通信で済む）、それ以上は番地・号まで試みる。
 */
function njaLibraryLevel_(required) {
  return required <= NJA_TOWN_LEVEL ? NJA_TOWN_LEVEL : NJA_MAX_LEVEL;
}

function njaToText_(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

/**
 * 1 件正規化する。戻り値は { value: string } または { error: { code, message } }。
 * 例外は投げない（範囲処理で 1 行の失敗が全体を止めないようにするため）。
 */
function njaNormalizeOne_(text, required) {
  try {
    var result = NJA.normalize(text, { level: njaLibraryLevel_(required) });
    if (result && typeof result.then === 'function') {
      throw new Error('内部エラー: 正規化処理が同期化されていません（ビルドを確認してください）');
    }
    if (result.level < required) {
      return {
        error: {
          code: 'LEVEL',
          message: njaLevelMessage_(result.level, required),
        },
      };
    }
    return { value: njaFormat_(result) };
  } catch (e) {
    return {
      error: {
        code: 'ERROR',
        message: e && e.message ? e.message : String(e),
      },
    };
  }
}

function njaLevelMessage_(got, required) {
  return '正規化レベルが不足しています（結果 ' + got + ' < 指定 ' + required + '）';
}

/**
 * 結果オブジェクトを 1 つの住所文字列にする。
 *   都道府県 + 市区町村 + 町丁目 + 番地・号 + その他
 * 「その他」（正規化できなかった残り）は、番地・号が確定していれば半角スペースで区切り、
 * そうでなければ数字で始まる場合のみ直結する（例: 町丁目 + "8-1 ビル名"）。
 */
function njaFormat_(result) {
  var head = [result.pref, result.city, result.town, result.addr]
    .filter(function (p) {
      return !!p;
    })
    .join('');
  var other = njaToText_(result.other);
  if (!other) {
    return head;
  }
  if (!head) {
    return other;
  }
  if (result.addr) {
    return head + ' ' + other;
  }
  return /^[0-9]/.test(other) ? head + other : head + ' ' + other;
}

/** 範囲入力の行に埋めるエラー表記（Sheets のエラーではなく文字列） */
function njaRowError_(code, message) {
  return '#' + code + ' ' + message;
}

function njaRangeShape_(values) {
  if (values.length === 0) {
    return 'column';
  }
  var isColumn = values.every(function (row) {
    return Array.isArray(row) && row.length === 1;
  });
  if (isColumn) {
    return 'column';
  }
  if (values.length === 1 && Array.isArray(values[0])) {
    return 'row';
  }
  throw new Error('範囲は 1 列または 1 行で指定してください（例: A2:A1000）');
}

/** 範囲入力。入力と同じ形（列なら列、行なら行）で返す */
function njaNormalizeRange_(values, required) {
  var shape = njaRangeShape_(values);
  var inputs =
    shape === 'column'
      ? values.map(function (row) {
          return row[0];
        })
      : values[0];

  var budgetMs = njaBatchBudgetMs_();
  var started = Date.now();
  var memo = {};
  var out = [];

  for (var i = 0; i < inputs.length; i++) {
    var text = njaToText_(inputs[i]);
    if (text === '') {
      out.push('');
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(memo, text)) {
      out.push(memo[text]);
      continue;
    }
    if (Date.now() - started > budgetMs) {
      out.push(
        njaRowError_(
          'TIMEOUT',
          '制限時間内に処理できませんでした。範囲を分割して再実行してください'
        )
      );
      continue;
    }
    var r = njaNormalizeOne_(text, required);
    var cell = r.error ? njaRowError_(r.error.code, r.error.message) : r.value;
    memo[text] = cell;
    out.push(cell);
  }

  if (shape === 'column') {
    return out.map(function (v) {
      return [v];
    });
  }
  return [out];
}

function njaBatchBudgetMs_() {
  // テストからの上書き用
  if (
    typeof NJA_TEST_OPTIONS !== 'undefined' &&
    NJA_TEST_OPTIONS &&
    typeof NJA_TEST_OPTIONS.batchBudgetMs === 'number'
  ) {
    return NJA_TEST_OPTIONS.batchBudgetMs;
  }
  return NJA_BATCH_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// アドオン UI（メニューとサイドバー）
// ---------------------------------------------------------------------------

function onOpen(e) {
  SpreadsheetApp.getUi()
    .createAddonMenu()
    .addItem('使い方', 'njaShowSidebar')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function njaShowSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle(
    '日本の住所正規化関数'
  );
  SpreadsheetApp.getUi().showSidebar(html);
}

// ---------------------------------------------------------------------------
// 動作確認（スクリプトエディタから実行する）
// ---------------------------------------------------------------------------

/** スクリプトエディタで実行し、ログで環境と結果を確認する */
function njaSelfTest() {
  var samples = [
    ['岩手県盛岡市内丸10-1', 8],
    ['大阪府大阪市北区梅田1-1-3', 8],
    ['東京都千代田区千代田１−１', 3],
    ['東京都新宿区西新宿2-8-1 都庁第一本庁舎', 3],
  ];
  Logger.log('library %s / add-on %s', NJA.libraryVersion, NJA.addonVersion);
  for (var i = 0; i < samples.length; i++) {
    var started = Date.now();
    var value;
    try {
      value = NORMALZE_JPN_ADDRESS(samples[i][0], samples[i][1]);
    } catch (e) {
      value = 'ERROR: ' + e.message;
    }
    Logger.log('%s -> %s (%sms)', samples[i][0], value, Date.now() - started);
  }
  Logger.log('network=%s cacheHits=%s', NJA.stats.network, NJA.stats.cacheHits);
}
