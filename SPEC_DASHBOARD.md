# 管制室ダッシュボード 仕様書(ワンショットビルド用)

`ai-boss-test` の実験ログを再生・比較する**完全静的な単一ページ**を作る。GitHub Pages のリポジトリ直下に置く前提。

## 厳守事項
- 出力は **`index.html` 1ファイル**(CSS/JS はインライン、または同ディレクトリの `dashboard.js`/`dashboard.css` まで可)。**外部CDN・npm・ビルドツール禁止**。バニラJSのみ。
- データは同ディレクトリの `data/*.json` を `fetch('./data/run-fable5.json')` 等で読む。ファイルが無くても落ちない(その旨表示)。
- `.nojekyll` はリポジトリに既にある。
- 見た目は落ち着いた「管制室」風でよいが、装飾より**情報が読めること**優先。ダーク基調可。

## 読み込むデータ(このスキーマは確定・変更不可)
`data/run-fable5.json` / `data/run-opus48.json` / `data/planning-meeting.json`。各ファイル形式:
```
{
  "meta": { "run", "arm", "cc_version", "started_at", "ended_at", "tools_exposed":[], "lanes":[] },
  "events": [
    { "ts":ISO8601, "lane":"main|<agentId>", "role":"pm|worker|orchestrator",
      "event_class":"task_spawn|task_notification|send_message|intervention|rate_limit_wait|integration_commit|assistant|user",
      "model"?, "tool_name"?, "tool_input_excerpt"?, "text_excerpt"?,
      "usage"?:{ "input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens" } }
  ]
}
```
- `lane:"main"` = PM(上司)レーン。それ以外の lane 値(agentId)= 部下レーン。
- 時刻は ISO8601(ミリ秒)。相対時刻 = ts − meta.started_at。

## 画面(必須)
1. **アーム切替タブ**: Fable 5 / Opus 4.8 / (任意で)Making of(planning-meeting.json)。切替でタイムラインとサマリが差し替わる。
2. **サマリカード**: そのアームの cc_version、開始〜終了の総経過、task_spawns 数、send_messages 数、レーン別トークン合計、tools_exposed 一覧。
3. **レーン別タイムライン(主役)**: 横軸=相対時刻。縦にレーンを積む(main を最上段、部下を下)。各レーンで:
   - 部下レーンは task_spawn(開始)〜そのレーンの最終イベント(完了)を**バー**で描く(並行なら重なり、直列なら段違いになるのが一目で分かること)。
   - main レーンは各イベントを点/小マーカーで。event_class で色分け(spawn/send_message/intervention/commit を目立たせる)。
   - **介入(intervention)は縦線**で全レーン横断表示(投下時刻)。
   - マーカー hover で ts・event_class・tool_name・text_excerpt/tool_input_excerpt を表示。
4. **レーン別トークン推移**: 累積トークンの折れ線(レーンごと)。
5. **イベントフィード + 再生**: 再生/一時停止、倍速(x10/x60)。時刻カーソルを動かすと、その時点までのイベントを時系列リストで表示。
6. **(任意)ヒートマップ**: レーン×時間ビンの活動量(記事サムネ候補)。

## 注記の表示(誠実さのため必須)
ページ内に注記ボックスを置き、以下を明記:
- これは n=1 の観察記録で公平な統計比較ではないこと。
- 部下は両アーム Sonnet 固定、PM のモデルのみ変えたこと。
- 部下完了は観察者が中継したため、PM レーンの「待ち」区間には中継遅延が混じり、待ち時間はモデル差の指標にならないこと。
- 詳細は RULES.md / results/comparison.md へのリンク。

## 完成条件
- `file://` で index.html を開き、両アームのタイムラインが描画・切替・再生でき、コンソールエラーが出ないこと。
- 可能なら headless Chrome で描画確認し、結果を報告。GUI 不可なら代替確認を正直に。
