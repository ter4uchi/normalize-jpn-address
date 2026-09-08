/**
 * Babel plugin: async / await を機械的に取り除く。
 *
 * 前提: バンドル内で await される値はすべて同期的に得られる
 * （唯一の I/O である UrlFetchApp が同期のため）。
 * この前提の下では `async function f() { return await g() }` を
 * `function f() { return g() }` に書き換えても意味は変わらない。
 *
 * Apps Script のカスタム関数は Promise を返せないため、この変換で
 * `normalize()` を同期関数にしている。
 */
export default function deasyncPlugin() {
  return {
    name: 'nja-deasync',
    visitor: {
      // FunctionDeclaration / FunctionExpression / ArrowFunctionExpression /
      // ObjectMethod / ClassMethod / ClassPrivateMethod をまとめて処理
      Function(path) {
        if (path.node.async) {
          path.node.async = false
        }
      },
      AwaitExpression(path) {
        path.replaceWith(path.node.argument)
      },
      ForOfStatement(path) {
        if (path.node.await) {
          path.node.await = false
        }
      },
    },
  }
}

/**
 * 変換後の検証用: async 関数と await 式の残数を数える。
 * @param {import('@babel/core').Node} ast
 * @param {typeof import('@babel/core').traverse} traverse
 */
export function countAsyncConstructs(ast, traverse) {
  let asyncFunctions = 0
  let awaits = 0
  traverse(ast, {
    Function(path) {
      if (path.node.async) asyncFunctions += 1
    },
    AwaitExpression() {
      awaits += 1
    },
    ForOfStatement(path) {
      if (path.node.await) awaits += 1
    },
  })
  return { asyncFunctions, awaits }
}
