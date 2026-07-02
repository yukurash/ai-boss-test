# AI Boss Test — AIチームの「上司」としての Fable 5 と Opus 4.8 を観察する

Claude Fable 5 と Claude Opus 4.8 をそれぞれ PM(上司)にして、同一のサブエージェントチーム(部下は全員 Sonnet 固定)に同一のブラウザゲームを開発させ、**非同期マルチエージェント統率の様式差**を観察する実験のデータ・成果物置き場です。

🎛️ **管制室ダッシュボード(両アームのランをリプレイ観戦できます)** → https://yukurash.github.io/ai-boss-test/

📊 頭対頭の比較と結論 → [results/comparison.md](results/comparison.md)

## 前作との位置づけ

[fable5-vs-opus48-arena](https://github.com/yukurash/fable5-vs-opus48-arena) は「まったく同じプロンプトを1回だけ渡す」1ターンの瞬発力の比較でした。本実験が観るのは成果物の出来ではなく、**PM としての振る舞い**(部下の並行運用、進捗監視、走行中の仕様変更の伝達、誤報告の検知)です。

## 実験の信頼性のための手続き

- 判定基準・介入台本・仕込みの正解は **ラン開始前にハッシュを公開**(プレレジ)。詳細は [RULES.md](RULES.md)
- 各アーム 1 ラン限り。無効ラン(やり直し)の条件は限定列挙済み
- PM への指示書 [PM_BRIEF.md](PM_BRIEF.md) と部下エージェント定義は両アーム完全同一
- これは**能力デモを含む観察記録(n=1)であり、公平な統計的比較ではありません**。部下の出来のばらつき等の交絡は分離できません

## 実行環境の記録

| 項目 | 値 |
|---|---|
| Claude Code バージョン | 2.1.198(両アーム一致) |
| PM モデル | claude-fable-5 / claude-opus-4-8 |
| 部下モデル | sonnet(全部下・両アーム固定。PM トランスクリプトの spawn 入力で確認) |
| 露出ツール(Fable アーム) | Agent, Bash, Edit, Glob, Grep, PowerShell, Read, SendMessage, ToolSearch, Write |
| 露出ツール(Opus アーム) | Agent, Bash, Grep, Read, SendMessage, ToolSearch, Write |

> 実行方式・逸脱・中継プロトコルの詳細は [RULES.md](RULES.md) の「1.5 実行方式」を参照。結論は分岐③(このタスク・n=1 では統率様式に決定的差なし)。

## リポジトリ構成

- `RULES.md` — 事前登録した実験ルール(プレレジ本体)
- `PM_BRIEF.md` — 両アーム共通の PM 指示書(全文公開)
- `tasks/` — 部下タスク仕様書 T1〜T4
- `workspace-template/.claude/agents/` — 部下サブエージェント定義(model: sonnet 固定)
- `interventions/` — 走行中に投下した仕様変更の台本(ラン完了まで封印、ハッシュのみ公開)
- `ANSWERS.md` — 仕込みの正解キー(ラン完了まで封印、ハッシュのみ公開)
- `scripts/` — ラン用ハーネス(ログ退避・介入トリガー監視・サニタイズ・メトリクス計算)
- `data/` — サニタイズ済みのランログ(ダッシュボードが読む JSON。生ログは公開しません)
- `artifacts/` — 各アームのチームが実際に作ったゲーム(遊べます)
- `results/` — メトリクスと有効ラン判定チェックリスト
