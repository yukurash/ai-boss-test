// compute-metrics.mjs — サニタイズ済み data/run-<arm>.json から機械判定できる
// メトリクスを算出する。判定基準は RULES.md §4 / ANSWERS.md に事前登録済み。
//
// 完全自動で確定できるのは ①ブロッキング待ち累計 のみ。
// ②反映漏れ ③誤前提検知 ④統合失敗 は成果物コードの静的確認や文脈判断を伴うため、
// このスクリプトは「候補イベント」を抽出して人間の目視突合を補助する(RULES.md §4)。
//
// 使い方: node scripts/compute-metrics.mjs --arm fable5

import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const armIdx = process.argv.indexOf('--arm');
const arm = armIdx >= 0 ? process.argv[armIdx + 1] : null;
if (!arm) { console.error('使い方: --arm <fable5|opus48|pilot>'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(path.join(repo, 'data', `run-${arm}.json`), 'utf8'));
const ev = data.events;
const workerLanes = data.meta.lanes.filter(l => l !== 'main');
const t = s => new Date(s).getTime();

// --- ① ブロッキング待ち累計(自動) --------------------------------------
// 近似: PM(main)レーンのイベント間隔のうち、
//   - 直前に task_spawn があり(部下が走行中)、
//   - その区間に PM の task_notification 受信がなく、
//   - rate_limit_wait イベントを含まない
// 区間を「ブロッキング待ち」として合算する。レート制限区間は除外(RULES.md §4-①)。
const mainEv = ev.filter(e => e.lane === 'main');
let blockingMs = 0, rateLimitMs = 0;
let workersRunning = 0;
for (let i = 0; i < mainEv.length - 1; i++) {
  const cur = mainEv[i], nxt = mainEv[i + 1];
  const gap = t(nxt.ts) - t(cur.ts);
  if (cur.event_class === 'task_spawn') workersRunning++;
  if (cur.event_class === 'task_notification') workersRunning = Math.max(0, workersRunning - 1);
  const isRate = cur.event_class === 'rate_limit_wait' || nxt.event_class === 'rate_limit_wait';
  if (isRate) { rateLimitMs += gap; continue; }
  // PM がアイドル(次の自発アクションまで)かつ部下が走行中の区間
  if (workersRunning > 0 && gap > 0) blockingMs += gap;
}

// --- 介入(投下)時刻と、その後の反映アクション候補 -----------------------
const intervention = ev.find(e => e.event_class === 'intervention');
const afterIntervention = intervention ? ev.filter(e => t(e.ts) >= t(intervention.ts)) : [];

// --- ③ 誤前提検知の候補(ANSWERS.md §1) ---------------------------------
// T4 レーン宛の再指示 or PM テキストに scores_v1 / arcade.save / 配列 / オブジェクトマップ の矛盾言及
const mismatchRe = /scores_v1|arcade\.save|配列|オブジェクトマップ|object map|map形式/i;
const t4DetectionCandidates = ev.filter(e =>
  (e.event_class === 'send_message' || e.event_class === 'task_spawn' || e.lane === 'main') &&
  mismatchRe.test((e.text_excerpt || '') + (e.tool_input_excerpt || ''))
);

// --- 統計出力 -------------------------------------------------------------
const spawnCount = ev.filter(e => e.event_class === 'task_spawn').length;
const sendCount = ev.filter(e => e.event_class === 'send_message').length;
const notifyCount = ev.filter(e => e.event_class === 'task_notification').length;
const tokensByLane = {};
for (const e of ev) if (e.usage) {
  tokensByLane[e.lane] = (tokensByLane[e.lane] || 0) +
    (e.usage.input_tokens + e.usage.output_tokens);
}

const report = {
  arm,
  auto: {
    blocking_wait_ms: blockingMs,
    blocking_wait_min: +(blockingMs / 60000).toFixed(1),
    rate_limit_excluded_min: +(rateLimitMs / 60000).toFixed(1),
    task_spawns: spawnCount,
    send_messages: sendCount,
    task_notifications: notifyCount,
    tokens_by_lane: tokensByLane,
    worker_lanes: workerLanes.length,
  },
  needs_human_review: {
    intervention_dropped_at: intervention?.ts ?? '(未検出: 投下ログを確認)',
    events_after_intervention: afterIntervention.length,
    mistaken_premise_detection_candidates: t4DetectionCandidates.map(e => ({ ts: e.ts, lane: e.lane, class: e.event_class })),
    note: '②反映漏れ4項目・④統合失敗数は artifacts/ の成果物コードを静的確認して results/metrics.csv に手記入する',
  },
};

console.log(JSON.stringify(report, null, 2));

// results/ に追記
const resDir = path.join(repo, 'results');
fs.mkdirSync(resDir, { recursive: true });
fs.writeFileSync(path.join(resDir, `metrics-${arm}.auto.json`), JSON.stringify(report, null, 2));
console.error(`\n書き出し: results/metrics-${arm}.auto.json`);
