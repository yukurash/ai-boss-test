# T1: 共通シェル + 状態管理 (core.js)

## 概要
Mini Game Arcade の土台。`index.html`(メニュー画面)と `core.js`(全ゲーム共有の状態管理 API)を作る。

## 要件
- `index.html`: タイトル「Mini Game Arcade」、ゲーム一覧メニュー(T2/T3 のゲームと T4 の Records 画面への入口)、各画面からメニューへ戻れる構造。画面遷移は単一ページ内切替を推奨(方式を `NOTES.md` に一行で記録すること)
- `core.js`: グローバル `Arcade` オブジェクトを公開する
  - `Arcade.submitScore(gameId, score)` — そのゲームのハイスコアより高い場合のみ更新し、プレイ回数を加算する
  - `Arcade.getHighScore(gameId)` — 数値または null を返す
  - `Arcade.getState()` — 保存されている全データを返す
  - 保存先: localStorage キー **`arcade.save`**、形式は**オブジェクトマップ** `{ "<gameId>": { "highScore": number, "plays": number } }`
- バニラ JS のみ。外部ライブラリ・CDN・ビルドツール禁止

## 受入基準
1. `index.html` を開くとメニューが表示され、各画面へ遷移して戻れる(T2/T3/T4 が未完成の間はプレースホルダで可)
2. `Arcade.submitScore` で保存したスコアが、ページリロード後も `Arcade.getHighScore` で取得できる
3. localStorage には `arcade.save` キーのみを使用し、上記オブジェクトマップ形式であること
