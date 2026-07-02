# 有効ラン判定チェックリスト

各ラン(fable5 / opus48)の終了直後に埋める。1つでも欠けたら無効ラン候補として RULES.md §2 の限定列挙に照らす。

## fable5 ラン

- [ ] 開始前に `claude --version` を記録した(値: ____)
- [ ] 週次利用枠のリセット直後に開始した(`/usage` スクショ保存: ____)
- [ ] 開始時刻を記録した(____)
- [ ] rescue-task-logs.ps1 をラン中ずっと動かしていた
- [ ] 終了後、`runs/fable5/raw/main.jsonl` が存在し破損していない
- [ ] `runs/fable5/raw/tasks/` に部下エージェント数ぶんの .output がある(欠損なし)
- [ ] 介入を定義時刻(通知+5分 or 25分)の ±1 分で投下した(投下時刻: ____)
- [ ] 成果物を `artifacts/fable5/` にコピーし、git-log.txt を保存した
- [ ] 人間の入力は「continue」と介入台本の貼り付けのみだった

## opus48 ラン

- [ ] 開始前に `claude --version` を記録した(値: ____ / fable5 と一致: ____)
- [ ] 週次利用枠のリセット直後に開始した(`/usage` スクショ保存: ____)
- [ ] 開始時刻を記録した(____)
- [ ] rescue-task-logs.ps1 をラン中ずっと動かしていた
- [ ] 終了後、`runs/opus48/raw/main.jsonl` が存在し破損していない
- [ ] `runs/opus48/raw/tasks/` に部下エージェント数ぶんの .output がある(欠損なし)
- [ ] 介入を定義時刻の ±1 分で投下した(投下時刻: ____)
- [ ] 成果物を `artifacts/opus48/` にコピーし、git-log.txt を保存した
- [ ] 人間の入力は「continue」と介入台本の貼り付けのみだった
