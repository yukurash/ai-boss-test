// sanitize.mjs — 生ログ(メイン jsonl + tasks/*.output)を許可リスト方式で
// ダッシュボード用の安全な JSON に変換する。
//
// 方針(RULES.md §5): 通すフィールドを列挙し、それ以外は全て落とす。
// 通過後にもう一段、絶対パス・メール・トークン様文字列を正規表現でマスクする(二重化)。
//
// 使い方:
//   node scripts/sanitize.mjs --arm fable5
//   node scripts/sanitize.mjs --planning     (企画会議ログ → data/planning-meeting.json)
//
// 出力: data/run-<arm>.json (または data/planning-meeting.json)
//   { meta:{...}, events:[ {ts, lane, role, event_class, model?, tool_name?, tool_input_excerpt?, text_excerpt?, usage?} ] }

import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const isPlanning = args.includes('--planning');
const armIdx = args.indexOf('--arm');
const arm = armIdx >= 0 ? args[armIdx + 1] : null;
if (!isPlanning && !arm) {
  console.error('使い方: --arm <fable5|opus48|pilot|smoke>  または  --planning');
  process.exit(1);
}

const runName = isPlanning ? 'planning' : arm;
const rawDir = path.join(repo, 'runs', runName, 'raw');
const mainPath = path.join(rawDir, 'main.jsonl');
const tasksDir = path.join(rawDir, 'tasks');

// --- マスク(通過後の二重防御) ------------------------------------------
const MASKS = [
  [/[A-Za-z]:\\Users\\[^\s"'\\]+/g, '<path>'],   // Windows 絶対パス
  [/\/(?:home|Users)\/[^\s"']+/g, '<path>'],      // Unix 絶対パス
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],       // メール
  [/\b(?:sk|pat|ghp|gho|xox[bpas])[-_][A-Za-z0-9_-]{10,}\b/g, '<token>'], // トークン様
  [/\bBearer\s+[A-Za-z0-9._-]{10,}/g, 'Bearer <token>'],
];
function mask(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const [re, rep] of MASKS) out = out.replace(re, rep);
  return out;
}
function excerpt(s, n) {
  if (typeof s !== 'string') return undefined;
  const m = mask(s);
  return m.length > n ? m.slice(0, n) + '…' : m;
}

// --- workspace 相対パス化(tool_input のコマンド/パス) --------------------
function relativizePaths(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/[A-Za-z]:\\Users\\[^\s"']*?workspace\\?/gi, './')
          .replace(/[A-Za-z]:\\Users\\[^\s"'\\]+/g, '<path>');
}

// --- usage は許可した4種のみ ---------------------------------------------
function pickUsage(u) {
  if (!u) return undefined;
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

// --- イベント分類 ---------------------------------------------------------
function classify(rec, toolName, text) {
  if (toolName === 'Agent') return 'task_spawn';
  if (toolName === 'SendMessage') return 'send_message';
  if (typeof text === 'string' && /task-notification/.test(text)) return 'task_notification';
  if (typeof text === 'string' && /【仕様変更】/.test(text)) return 'intervention';
  if (typeof text === 'string' && /rate limit|429|usage limit|利用上限/i.test(text)) return 'rate_limit_wait';
  if (toolName === 'Bash' && typeof text === 'string' && /git commit/.test(text)) return 'integration_commit';
  return rec.type === 'assistant' ? 'assistant' : 'user';
}

// --- 1レコード → 0..n イベント -------------------------------------------
function recordToEvents(rec, lane, role) {
  const ts = rec.timestamp;
  const model = rec.message?.model;
  const usage = pickUsage(rec.message?.usage);
  const events = [];
  const content = rec.message?.content;

  if (typeof content === 'string') {
    events.push({ ts, lane, role, event_class: classify(rec, null, content),
                  model, text_excerpt: excerpt(content, 800), usage });
    return events;
  }
  if (!Array.isArray(content)) return events;

  for (const c of content) {
    if (c.type === 'text') {
      events.push({ ts, lane, role, event_class: classify(rec, null, c.text),
                    model, text_excerpt: excerpt(c.text, 800), usage });
    } else if (c.type === 'tool_use') {
      const inputStr = JSON.stringify(c.input ?? {});
      events.push({ ts, lane, role, event_class: classify(rec, c.name, inputStr),
                    model, tool_name: c.name,
                    tool_input_excerpt: excerpt(relativizePaths(inputStr), 500), usage });
    } else if (c.type === 'tool_result') {
      const t = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
      events.push({ ts, lane, role, event_class: classify(rec, null, t),
                    text_excerpt: excerpt(t, 800) });
    }
    // thinking / image などは落とす(許可リスト外)
  }
  return events;
}

// --- 読み込み -------------------------------------------------------------
function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l, i) => { try { return JSON.parse(l); } catch { console.warn(`skip line ${i} in ${path.basename(p)}`); return null; } })
    .filter(Boolean);
}

const events = [];
const toolsExposed = new Set();
let ccVersion = null;

// メインセッション = PM レーン
const mainRecs = readJsonl(mainPath);
for (const rec of mainRecs) {
  if (rec.version) ccVersion = rec.version;
  if (Array.isArray(rec.message?.content)) {
    for (const c of rec.message.content) if (c.type === 'tool_use') toolsExposed.add(c.name);
  }
  const role = isPlanning ? 'orchestrator' : 'pm';
  events.push(...recordToEvents(rec, 'main', role));
}

// サブエージェント = 各 tasks/<agentId>.output を1レーン
if (fs.existsSync(tasksDir)) {
  for (const f of fs.readdirSync(tasksDir).filter(f => f.endsWith('.output'))) {
    const lane = f.replace(/\.output$/, '');
    const recs = readJsonl(path.join(tasksDir, f));
    for (const rec of recs) events.push(...recordToEvents(rec, lane, 'worker'));
  }
}

events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

const out = {
  meta: {
    run: runName,
    arm: isPlanning ? null : arm,
    cc_version: ccVersion,
    started_at: events[0]?.ts ?? null,
    ended_at: events[events.length - 1]?.ts ?? null,
    tools_exposed: [...toolsExposed].sort(),
    lanes: [...new Set(events.map(e => e.lane))],
  },
  events,
};

const dataDir = path.join(repo, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const outPath = path.join(dataDir, isPlanning ? 'planning-meeting.json' : `run-${arm}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`書き出し: ${path.relative(repo, outPath)}`);
console.log(`  events: ${events.length} / lanes: ${out.meta.lanes.length} / cc: ${ccVersion}`);
console.log(`  tools_exposed: ${out.meta.tools_exposed.join(', ')}`);
