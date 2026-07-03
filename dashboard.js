/* 管制室ダッシュボード — vanilla JS, no dependencies.
 * Loads data/*.json via fetch on http(s); on file:// falls back to data/embedded.js
 * (same JSON wrapped in a script tag) because browsers block fetch on file: origins.
 */
'use strict';

(function () {
  // ---------------------------------------------------------------- constants
  const ARMS = [
    { id: 'fable5', label: 'Fable 5', file: 'run-fable5.json' },
    { id: 'opus48', label: 'Opus 4.8', file: 'run-opus48.json' },
  ];

  // lane categorical slots (validated for the dark surface; fixed order, never cycled)
  const LANE_COLORS = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#d55181', '#d95926'];
  const LANE_OVERFLOW = '#79828e'; // lanes past slot 6 fold into gray + label

  // event-class encoding: emphasized classes get color + big marker, chatter is muted
  const CLASS_STYLE = {
    task_spawn:         { color: '#3987e5', label: 'task_spawn',       big: true },
    send_message:       { color: '#199e70', label: 'send_message',     big: true },
    intervention:       { color: '#d03b3b', label: 'intervention',     big: true },
    integration_commit: { color: '#0ca30c', label: 'integration_commit', big: true },
    task_notification:  { color: '#9085e9', label: 'task_notification', big: true },
    rate_limit_wait:    { color: '#c98500', label: 'rate_limit_wait',  big: true },
    assistant:          { color: '#5b6470', label: 'assistant',        big: false },
    user:               { color: '#5b6470', label: 'user',             big: false },
  };
  const CLASS_FALLBACK = { color: '#5b6470', label: '?', big: false };

  const SURFACE = '#14181d';
  const HEAT_RAMP = ['#1a222c', '#16345a', '#1c5296', '#2a78d6', '#5598e7', '#9ec5f4'];

  // ---------------------------------------------------------------- state
  const cache = {};           // armId -> prepared data or {error}
  let current = null;         // prepared data of the active arm
  let play = { t: 0, playing: false, speed: 60, raf: 0, last: 0 };
  let feedIdx = -1;
  let seekTimeline = null;    // fn(t) updating the timeline playhead
  const $ = (sel) => document.querySelector(sel);

  // ---------------------------------------------------------------- utils
  function el(tag, attrs, parent) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }
  function svgEl(tag, attrs, parent) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (v) => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }
  function fmtClock(ms) {
    const d = new Date(ms);
    const p = (v) => String(v).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function fmtInt(v) { return v.toLocaleString('en-US'); }
  function fmtTok(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'k';
    return String(v);
  }
  function debounce(fn, ms) {
    let id = 0;
    return function () { clearTimeout(id); id = setTimeout(fn, ms); };
  }

  // ---------------------------------------------------------------- data loading
  let embedPromise = null;
  function loadEmbedded() {
    if (window.__ARENA_DATA__) return Promise.resolve(window.__ARENA_DATA__);
    if (!embedPromise) {
      embedPromise = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = './data/embedded.js';
        s.onload = () => resolve(window.__ARENA_DATA__ || null);
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      });
    }
    return embedPromise;
  }
  async function loadRaw(file) {
    if (location.protocol !== 'file:') {
      try {
        const r = await fetch('./data/' + file);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) {
        const emb = await loadEmbedded();
        if (emb && emb[file]) return emb[file];
        throw e;
      }
    }
    // file:// — browsers block fetch here; go straight to the embedded fallback
    const emb = await loadEmbedded();
    if (emb && emb[file]) return emb[file];
    throw new Error('file:// では fetch が使えず、data/embedded.js も見つかりませんでした');
  }

  // ---------------------------------------------------------------- data prep
  function prepare(raw, armLabel) {
    const meta = raw.meta || {};
    const events = (raw.events || []).slice();
    const t0 = Date.parse(meta.started_at || (events[0] && events[0].ts) || 0);
    for (const e of events) e._rel = (Date.parse(e.ts) - t0) / 1000;
    events.sort((a, b) => a._rel - b._rel);
    const lastRel = events.length ? events[events.length - 1]._rel : 0;
    const duration = Math.max(
      meta.ended_at ? (Date.parse(meta.ended_at) - t0) / 1000 : 0, lastRel, 1);

    // lane order: meta.lanes first (main leading), then any lane only seen in events
    const laneIds = [];
    const seen = new Set();
    const push = (id) => { if (id != null && !seen.has(id)) { seen.add(id); laneIds.push(id); } };
    push('main');
    (meta.lanes || []).forEach(push);
    events.forEach((e) => push(e.lane));

    const lanes = laneIds.map((id, i) => ({
      id, index: i,
      color: id === 'main' ? LANE_COLORS[0]
        : (i <= 5 ? LANE_COLORS[i % LANE_COLORS.length] : LANE_OVERFLOW),
      events: [], first: Infinity, last: 0,
      tok: { inp: 0, out: 0, cr: 0, cc: 0 }, usagePts: [],
      role: null, spawnRel: null, desc: null,
    }));
    const laneById = {};
    lanes.forEach((l) => { laneById[l.id] = l; });

    let spawns = [], sends = 0, interventions = [];
    for (const e of events) {
      const l = laneById[e.lane];
      if (!l) continue;
      l.events.push(e);
      if (e._rel < l.first) l.first = e._rel;
      if (e._rel > l.last) l.last = e._rel;
      if (!l.role && e.role) l.role = e.role;
      if (e.usage) {
        l.tok.inp += e.usage.input_tokens || 0;
        l.tok.out += e.usage.output_tokens || 0;
        l.tok.cr += e.usage.cache_read_input_tokens || 0;
        l.tok.cc += e.usage.cache_creation_input_tokens || 0;
        l.usagePts.push({ rel: e._rel, cum: l.tok.inp + l.tok.out });
      }
      if (e.event_class === 'task_spawn') spawns.push(e);
      if (e.event_class === 'send_message') sends++;
      if (e.event_class === 'intervention') interventions.push(e);
    }

    // spawn -> worker-lane matching: each worker lane takes the closest preceding
    // unassigned task_spawn (handles respawns: the leftover spawn stays unmatched).
    const workers = lanes.filter((l) => l.id !== 'main' && l.events.length)
      .sort((a, b) => a.first - b.first);
    const free = spawns.slice();
    for (const w of workers) {
      let best = null;
      for (const s of free) if (s._rel <= w.first + 0.5 && (!best || s._rel > best._rel)) best = s;
      if (best) {
        free.splice(free.indexOf(best), 1);
        w.spawnRel = best._rel;
        const m = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(best.tool_input_excerpt || '');
        if (m) { try { w.desc = JSON.parse('"' + m[1] + '"'); } catch (_) { w.desc = m[1]; } }
      }
    }

    let totalTok = 0;
    lanes.forEach((l) => { totalTok += l.tok.inp + l.tok.out; });

    return {
      armLabel, meta, events, t0, duration, lanes, laneById,
      spawnCount: spawns.length, sendCount: sends, interventions, totalTok,
    };
  }

  // ---------------------------------------------------------------- tooltip
  const tipEl = $('#tooltip');
  function showTip(rows, x, y) {
    tipEl.textContent = '';
    for (const r of rows) {
      if (r.type === 'title') el('div', { class: 'tt-title', text: r.text }, tipEl);
      else if (r.type === 'kv') {
        const d = el('div', { class: 'tt-row' }, tipEl);
        if (r.color) el('span', { class: 'tt-key', style: 'background:' + r.color }, d);
        el('span', { class: 'tt-val', text: r.value }, d);
        el('span', { text: r.label }, d);
      } else if (r.type === 'excerpt') el('div', { class: 'tt-ex', text: r.text }, tipEl);
    }
    tipEl.hidden = false;
    const rect = tipEl.getBoundingClientRect();
    let px = x + 14, py = y + 14;
    if (px + rect.width > innerWidth - 8) px = Math.max(8, x - rect.width - 14);
    if (py + rect.height > innerHeight - 8) py = Math.max(8, y - rect.height - 14);
    tipEl.style.left = px + 'px';
    tipEl.style.top = py + 'px';
  }
  function hideTip() { tipEl.hidden = true; }

  function laneLabel(l) {
    if (l.id === 'main') return l.role === 'orchestrator' ? '司令 (main)' : 'PM (main)';
    return l.desc || ('agent ' + l.id.slice(0, 8));
  }
  function laneShort(l) {
    const s = laneLabel(l);
    return s.length > 24 ? s.slice(0, 23) + '…' : s;
  }
  function eventTipRows(e, d) {
    const cs = CLASS_STYLE[e.event_class] || CLASS_FALLBACK;
    const rows = [
      { type: 'title', text: e.event_class + (e.tool_name ? ' · ' + e.tool_name : '') },
      { type: 'kv', color: cs.color, value: 'T+' + fmtDur(e._rel), label: fmtClock(d.t0 + e._rel * 1000) + ' / ' + laneShort(d.laneById[e.lane] || { id: e.lane }) },
    ];
    if (e.model) rows.push({ type: 'kv', value: e.model, label: 'model' });
    if (e.usage) rows.push({
      type: 'kv',
      value: fmtInt((e.usage.input_tokens || 0) + (e.usage.output_tokens || 0)),
      label: `tok (in ${fmtInt(e.usage.input_tokens || 0)} / out ${fmtInt(e.usage.output_tokens || 0)})`,
    });
    const ex = e.text_excerpt || e.tool_input_excerpt;
    if (ex) rows.push({ type: 'excerpt', text: ex.length > 420 ? ex.slice(0, 420) + '…' : ex });
    return rows;
  }
  function attachTip(node, rowsFn) {
    node.addEventListener('pointerenter', (ev) => showTip(rowsFn(), ev.clientX, ev.clientY));
    node.addEventListener('pointermove', (ev) => showTip(rowsFn(), ev.clientX, ev.clientY));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => {
      const r = node.getBoundingClientRect();
      showTip(rowsFn(), r.left + r.width / 2, r.top);
    });
    node.addEventListener('blur', hideTip);
  }

  // ---------------------------------------------------------------- summary
  function renderSummary(d) {
    const m = d.meta;
    $('#meta-line').textContent =
      `run: ${m.run || '—'} · cc_version: ${m.cc_version || '—'} · ` +
      `${m.started_at || '?'} → ${m.ended_at || '?'}`;

    const row = $('#kpi-row');
    row.textContent = '';
    const kpis = [
      { label: '総経過', value: fmtDur(d.duration), sub: '開始 → 終了' },
      { label: 'イベント数', value: fmtInt(d.events.length), sub: `${d.lanes.filter((l) => l.events.length).length} レーン` },
      { label: 'task_spawns', value: String(d.spawnCount), sub: '部下の起動' },
      { label: 'send_messages', value: String(d.sendCount), sub: 'PM → 部下の指示' },
      { label: '介入', value: String(d.interventions.length), sub: '外部からの仕様変更' },
      { label: '総トークン', value: fmtTok(d.totalTok), sub: 'input+output 全レーン' },
    ];
    for (const k of kpis) {
      const t = el('div', { class: 'kpi' }, row);
      el('div', { class: 'k-label', text: k.label }, t);
      el('div', { class: 'k-value', text: k.value }, t);
      el('div', { class: 'k-sub', text: k.sub }, t);
    }

    const table = $('#lane-table');
    table.textContent = '';
    const thead = el('thead', null, table);
    const hr = el('tr', null, thead);
    for (const h of ['レーン', 'events', 'input', 'output', 'in+out', 'cache read']) el('th', { text: h }, hr);
    const tbody = el('tbody', null, table);
    for (const l of d.lanes) {
      if (!l.events.length) continue;
      const tr = el('tr', null, tbody);
      const td0 = el('td', null, tr);
      el('span', { class: 'lane-key', style: 'background:' + l.color }, td0);
      td0.appendChild(document.createTextNode(laneShort(l)));
      el('td', { text: fmtInt(l.events.length) }, tr);
      el('td', { text: fmtInt(l.tok.inp) }, tr);
      el('td', { text: fmtInt(l.tok.out) }, tr);
      el('td', { text: fmtInt(l.tok.inp + l.tok.out) }, tr);
      el('td', { text: fmtInt(l.tok.cr) }, tr);
    }

    const chips = $('#tools-chips');
    chips.textContent = '';
    for (const t of (m.tools_exposed || [])) el('span', { class: 'chip', text: t }, chips);
    if (!(m.tools_exposed || []).length) chips.textContent = '—';

    $('#foot-src').textContent =
      `run=${m.run || '?'} · events=${d.events.length} · 完全静的 / バニラJS · AI上司耐性試験`;
  }

  // ---------------------------------------------------------------- timeline
  function renderTimeline(d) {
    const wrap = $('#timeline-wrap');
    wrap.textContent = '';
    const lanes = d.lanes.filter((l) => l.events.length);
    const ML = 178, MR = 18, MT = 10, ROW = 46, AXIS = 30;
    const width = Math.max(720, wrap.clientWidth || 900);
    const plotW = width - ML - MR;
    const height = MT + lanes.length * ROW + AXIS;
    const x = (t) => ML + (t / d.duration) * plotW;

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'レーン別タイムライン' }, wrap);

    // time grid
    const step = pickStep(d.duration, plotW);
    for (let t = 0; t <= d.duration + 0.001; t += step) {
      svgEl('line', { class: 'gridline', x1: x(t), x2: x(t), y1: MT, y2: MT + lanes.length * ROW }, svg);
      svgEl('text', { x: x(t), y: MT + lanes.length * ROW + 16, 'text-anchor': 'middle', text: fmtDur(t) }, svg);
    }
    svgEl('line', { class: 'axisline', x1: ML, x2: width - MR, y1: MT + lanes.length * ROW, y2: MT + lanes.length * ROW }, svg);

    // lane rows
    lanes.forEach((l, i) => {
      const yTop = MT + i * ROW, yc = yTop + ROW / 2;
      if (i > 0) svgEl('line', { class: 'gridline', x1: 8, x2: width - MR, y1: yTop, y2: yTop, opacity: 0.6 }, svg);
      svgEl('text', { class: 'lane-label', x: 8, y: yc - 2, text: laneShort(l) }, svg);
      svgEl('text', { class: 'lane-sub', x: 8, y: yc + 12, text: l.id === 'main' ? (l.role || 'main') : l.id.slice(0, 12) }, svg);

      if (l.id !== 'main') {
        const start = l.spawnRel != null ? l.spawnRel : l.first;
        const bx = x(start), bw = Math.max(3, x(l.last) - bx);
        const bar = svgEl('rect', {
          x: bx, y: yc - 8, width: bw, height: 16, rx: 4,
          fill: '#2b3542',
        }, svg);
        // spawn connector from the main row down to the bar start
        if (l.spawnRel != null) {
          svgEl('line', {
            x1: x(l.spawnRel), x2: x(l.spawnRel),
            y1: MT + ROW / 2, y2: yc - 8,
            stroke: CLASS_STYLE.task_spawn.color, 'stroke-width': 1, opacity: 0.45,
          }, svg);
        }
        const lRef = l;
        attachTip(bar, () => [
          { type: 'title', text: laneLabel(lRef) },
          { type: 'kv', color: lRef.color, value: fmtDur(lRef.last - (lRef.spawnRel != null ? lRef.spawnRel : lRef.first)), label: `稼働 T+${fmtDur(lRef.spawnRel != null ? lRef.spawnRel : lRef.first)} → T+${fmtDur(lRef.last)}` },
          { type: 'kv', value: fmtInt(lRef.events.length), label: 'events' },
          { type: 'kv', value: fmtInt(lRef.tok.inp + lRef.tok.out), label: 'tokens (in+out)' },
        ]);
      }
    });

    // event markers (chatter = small muted ticks, emphasized classes = ringed dots)
    const laneRow = {};
    lanes.forEach((l, i) => { laneRow[l.id] = MT + i * ROW + ROW / 2; });
    const markerLayer = svgEl('g', null, svg);
    for (const e of d.events) {
      const yc = laneRow[e.lane];
      if (yc == null) continue;
      const cs = CLASS_STYLE[e.event_class] || CLASS_FALLBACK;
      const cx = x(e._rel);
      let vis;
      if (cs.big) {
        vis = svgEl('circle', { cx, cy: yc, r: 5, fill: cs.color, stroke: SURFACE, 'stroke-width': 2 }, markerLayer);
      } else {
        vis = svgEl('circle', { cx, cy: yc, r: 2, fill: cs.color, opacity: 0.75 }, markerLayer);
      }
      const hit = svgEl('circle', {
        cx, cy: yc, r: cs.big ? 12 : 8, fill: 'transparent', class: 'marker-hit',
      }, markerLayer);
      if (cs.big) { hit.setAttribute('tabindex', '0'); hit.setAttribute('role', 'img'); hit.setAttribute('aria-label', `${e.event_class} T+${fmtDur(e._rel)}`); }
      const ev = e;
      attachTip(hit, () => eventTipRows(ev, d));
      hit.addEventListener('pointerenter', () => vis.setAttribute('stroke', '#e8eaed'));
      hit.addEventListener('pointerleave', () => vis.setAttribute('stroke', cs.big ? SURFACE : 'none'));
    }

    // interventions: full-height vertical line
    for (const iv of d.interventions) {
      const ix = x(iv._rel);
      svgEl('line', { x1: ix, x2: ix, y1: MT - 2, y2: MT + lanes.length * ROW, stroke: CLASS_STYLE.intervention.color, 'stroke-width': 2, opacity: 0.9 }, svg);
      svgEl('text', { x: ix + 5, y: MT + 9, fill: CLASS_STYLE.intervention.color, text: '介入 T+' + fmtDur(iv._rel), 'font-weight': '600' }, svg);
    }

    // playhead: future-dimming overlay + cursor line
    const dim = svgEl('rect', { x: x(d.duration), y: MT, width: 0, height: lanes.length * ROW, fill: SURFACE, opacity: 0.55, 'pointer-events': 'none' }, svg);
    const cursor = svgEl('line', { x1: x(d.duration), x2: x(d.duration), y1: MT - 4, y2: MT + lanes.length * ROW + 4, stroke: '#e8eaed', 'stroke-width': 1, 'pointer-events': 'none', opacity: 0.9 }, svg);

    seekTimeline = (t) => {
      const cx = x(Math.min(t, d.duration));
      cursor.setAttribute('x1', cx);
      cursor.setAttribute('x2', cx);
      dim.setAttribute('x', cx);
      dim.setAttribute('width', Math.max(0, x(d.duration) - cx));
    };

    // click-to-seek on the background
    svg.style.cursor = 'crosshair';
    svg.addEventListener('click', (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      if (px < ML - 4) return;
      const t = Math.max(0, Math.min(d.duration, ((px - ML) / plotW) * d.duration));
      pausePlayback();
      seekTo(t);
    });

    // legend
    const lg = $('#tl-legend');
    lg.textContent = '';
    addLegendItem(lg, '#2b3542', '部下の稼働バー', 'bar');
    for (const k of ['task_spawn', 'send_message', 'task_notification', 'integration_commit', 'rate_limit_wait', 'intervention']) {
      addLegendItem(lg, CLASS_STYLE[k].color, CLASS_STYLE[k].label);
    }
    addLegendItem(lg, CLASS_STYLE.assistant.color, 'assistant/user(小点)');
  }

  function addLegendItem(parent, color, label, shape) {
    const li = el('span', { class: 'li' }, parent);
    el('span', { class: 'sw' + (shape ? ' ' + shape : ''), style: 'background:' + color }, li);
    el('span', { text: label }, li);
  }

  function pickStep(duration, plotW) {
    const steps = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
    const target = Math.max(4, Math.min(12, Math.floor(plotW / 90)));
    for (const s of steps) if (duration / s <= target) return s;
    return steps[steps.length - 1];
  }

  // ---------------------------------------------------------------- token chart
  function renderTokens(d) {
    const wrap = $('#tokens-wrap');
    wrap.textContent = '';
    const lanes = d.lanes.filter((l) => l.usagePts.length);
    const ML = 56, MR = 18, MT = 12, MB = 30;
    const width = Math.max(720, wrap.clientWidth || 900);
    const height = 260;
    const plotW = width - ML - MR, plotH = height - MT - MB;
    let maxTok = 1;
    lanes.forEach((l) => { const p = l.usagePts[l.usagePts.length - 1]; if (p.cum > maxTok) maxTok = p.cum; });
    const x = (t) => ML + (t / d.duration) * plotW;
    const y = (v) => MT + plotH - (v / maxTok) * plotH;

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'レーン別累積トークン' }, wrap);

    // y grid: clean rounded ticks
    const yStep = niceStep(maxTok / 4);
    for (let v = 0; v <= maxTok + 0.001; v += yStep) {
      svgEl('line', { class: 'gridline', x1: ML, x2: width - MR, y1: y(v), y2: y(v) }, svg);
      svgEl('text', { x: ML - 8, y: y(v) + 4, 'text-anchor': 'end', text: fmtTok(v) }, svg);
    }
    const step = pickStep(d.duration, plotW);
    for (let t = 0; t <= d.duration + 0.001; t += step) {
      svgEl('text', { x: x(t), y: height - 8, 'text-anchor': 'middle', text: fmtDur(t) }, svg);
    }
    svgEl('line', { class: 'axisline', x1: ML, x2: width - MR, y1: MT + plotH, y2: MT + plotH }, svg);

    // lines (step-after: cumulative counters hold between usage events)
    for (const l of lanes) {
      let dd = `M ${x(0)} ${y(0)}`;
      let prev = 0;
      for (const p of l.usagePts) {
        dd += ` L ${x(p.rel)} ${y(prev)} L ${x(p.rel)} ${y(p.cum)}`;
        prev = p.cum;
      }
      dd += ` L ${x(l.last)} ${y(prev)}`;
      svgEl('path', { d: dd, fill: 'none', stroke: l.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      const lp = l.usagePts[l.usagePts.length - 1];
      svgEl('circle', { cx: x(lp.rel), cy: y(lp.cum), r: 4, fill: l.color, stroke: SURFACE, 'stroke-width': 2 }, svg);
    }

    // crosshair + all-series tooltip
    const cross = svgEl('line', { x1: 0, x2: 0, y1: MT, y2: MT + plotH, stroke: '#e8eaed', 'stroke-width': 1, opacity: 0, 'pointer-events': 'none' }, svg);
    const hitRect = svgEl('rect', { x: ML, y: MT, width: plotW, height: plotH, fill: 'transparent' }, svg);
    hitRect.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const t = Math.max(0, Math.min(d.duration, ((ev.clientX - rect.left - ML) / plotW) * d.duration));
      cross.setAttribute('x1', x(t));
      cross.setAttribute('x2', x(t));
      cross.setAttribute('opacity', 0.5);
      const rows = [{ type: 'title', text: 'T+' + fmtDur(t) }];
      for (const l of lanes) {
        rows.push({ type: 'kv', color: l.color, value: fmtInt(cumAt(l.usagePts, t)), label: laneShort(l) });
      }
      showTip(rows, ev.clientX, ev.clientY);
    });
    hitRect.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); hideTip(); });

    const lg = $('#tk-legend');
    lg.textContent = '';
    for (const l of lanes) addLegendItem(lg, l.color, laneShort(l), 'line');
  }
  function cumAt(pts, t) {
    let v = 0;
    for (const p of pts) { if (p.rel > t) break; v = p.cum; }
    return v;
  }
  function niceStep(raw) {
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
    return 10 * pow;
  }

  // ---------------------------------------------------------------- heatmap
  function renderHeatmap(d) {
    const wrap = $('#heatmap-wrap');
    wrap.textContent = '';
    const lanes = d.lanes.filter((l) => l.events.length);
    const ML = 178, MR = 18, MT = 6, ROW = 26, AXIS = 26;
    const width = Math.max(720, wrap.clientWidth || 900);
    const plotW = width - ML - MR;
    const BINS = Math.max(24, Math.min(72, Math.floor(plotW / 16)));
    const height = MT + lanes.length * ROW + AXIS;
    const binSec = d.duration / BINS;

    const counts = lanes.map(() => new Array(BINS).fill(0));
    let maxC = 1;
    for (const e of d.events) {
      const li = lanes.findIndex((l) => l.id === e.lane);
      if (li < 0) continue;
      const b = Math.min(BINS - 1, Math.floor(e._rel / binSec));
      counts[li][b]++;
      if (counts[li][b] > maxC) maxC = counts[li][b];
    }

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '活動ヒートマップ' }, wrap);
    const cellW = plotW / BINS;
    lanes.forEach((l, i) => {
      svgEl('text', { class: 'lane-label', x: 8, y: MT + i * ROW + ROW / 2 + 4, text: laneShort(l) }, svg);
      for (let b = 0; b < BINS; b++) {
        const c = counts[i][b];
        const idx = c === 0 ? 0 : Math.max(1, Math.round((c / maxC) * (HEAT_RAMP.length - 1)));
        const rect = svgEl('rect', {
          x: ML + b * cellW + 1, y: MT + i * ROW + 2,
          width: Math.max(1, cellW - 2), height: ROW - 4, rx: 2,
          fill: HEAT_RAMP[idx],
        }, svg);
        if (c > 0) {
          const lRef = l, bRef = b, cRef = c;
          attachTip(rect, () => [
            { type: 'title', text: laneShort(lRef) },
            { type: 'kv', color: HEAT_RAMP[idx], value: fmtInt(cRef), label: `events · T+${fmtDur(bRef * binSec)}–${fmtDur((bRef + 1) * binSec)}` },
          ]);
        }
      }
    });
    const stepT = pickStep(d.duration, plotW);
    for (let t = 0; t <= d.duration + 0.001; t += stepT) {
      svgEl('text', { x: ML + (t / d.duration) * plotW, y: MT + lanes.length * ROW + 16, 'text-anchor': 'middle', text: fmtDur(t) }, svg);
    }

    const lg = $('#hm-legend');
    lg.textContent = '';
    addLegendItem(lg, HEAT_RAMP[0], '0', 'bar');
    addLegendItem(lg, HEAT_RAMP[2], '少', 'bar');
    addLegendItem(lg, HEAT_RAMP[HEAT_RAMP.length - 1], `多(最大 ${maxC})`, 'bar');
  }

  // ---------------------------------------------------------------- feed + playback
  function renderFeedReset() {
    $('#feed').textContent = '';
    feedIdx = 0;
  }
  function feedRow(e, d) {
    const cs = CLASS_STYLE[e.event_class] || CLASS_FALLBACK;
    const l = d.laneById[e.lane];
    const row = el('div', { class: 'feedrow' + (cs.big ? ' hot' : '') });
    if (cs.big) row.style.borderLeftColor = cs.color;
    el('span', { class: 't', text: 'T+' + fmtDur(e._rel) }, row);
    const laneSpan = el('span', { class: 'lane' }, row);
    el('span', { class: 'dot', style: 'background:' + ((l && l.color) || LANE_OVERFLOW) }, laneSpan);
    laneSpan.appendChild(document.createTextNode(l ? laneShort(l) : e.lane));
    el('span', { class: 'cls', text: e.event_class + (e.tool_name ? ' · ' + e.tool_name : '') }, row);
    const ex = e.text_excerpt || e.tool_input_excerpt || '';
    el('span', { class: 'ex', text: ex.slice(0, 160) }, row);
    return row;
  }
  function updateFeed(t) {
    const d = current;
    if (!d) return;
    const evs = d.events;
    // count events with _rel <= t (binary search)
    let lo = 0, hi = evs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (evs[mid]._rel <= t) lo = mid + 1; else hi = mid; }
    const idx = lo;
    const feed = $('#feed');
    if (idx === feedIdx) return;
    if (idx < feedIdx) { feed.textContent = ''; feedIdx = 0; }
    const frag = document.createDocumentFragment();
    for (let i = feedIdx; i < idx; i++) frag.appendChild(feedRow(evs[i], d));
    feed.appendChild(frag);
    feedIdx = idx;
    feed.scrollTop = feed.scrollHeight;
    $('#feed-count').textContent = `${idx} / ${evs.length} events`;
  }

  function seekTo(t) {
    const d = current;
    if (!d) return;
    play.t = Math.max(0, Math.min(d.duration, t));
    $('#scrub').value = String((play.t / d.duration) * 100);
    $('#clock').textContent = `T+${fmtDur(play.t)} / ${fmtDur(d.duration)}`;
    if (seekTimeline) seekTimeline(play.t);
    updateFeed(play.t);
  }
  function pausePlayback() {
    play.playing = false;
    cancelAnimationFrame(play.raf);
    $('#btn-play').textContent = '▶ 再生';
  }
  function startPlayback() {
    const d = current;
    if (!d) return;
    if (play.t >= d.duration - 0.01) seekTo(0);
    play.playing = true;
    play.last = performance.now();
    $('#btn-play').textContent = '⏸ 一時停止';
    const tick = (now) => {
      if (!play.playing) return;
      const dt = (now - play.last) / 1000;
      play.last = now;
      const t = play.t + dt * play.speed;
      if (t >= d.duration) { seekTo(d.duration); pausePlayback(); return; }
      seekTo(t);
      play.raf = requestAnimationFrame(tick);
    };
    play.raf = requestAnimationFrame(tick);
  }

  function bindControls() {
    $('#btn-play').addEventListener('click', () => {
      if (play.playing) pausePlayback(); else startPlayback();
    });
    document.querySelectorAll('.btn.speed').forEach((b) => {
      b.addEventListener('click', () => {
        play.speed = Number(b.dataset.speed);
        document.querySelectorAll('.btn.speed').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      });
    });
    document.querySelector('.btn.speed[data-speed="60"]').setAttribute('aria-pressed', 'true');
    $('#scrub').addEventListener('input', (ev) => {
      const d = current;
      if (!d) return;
      pausePlayback();
      seekTo((Number(ev.target.value) / 100) * d.duration);
    });
  }

  // ---------------------------------------------------------------- arm switching
  function setNotice(msg) {
    const n = $('#notice');
    if (!msg) { n.hidden = true; n.textContent = ''; return; }
    n.hidden = false;
    n.textContent = '';
    el('strong', { text: 'データを読み込めませんでした: ' }, n);
    n.appendChild(document.createTextNode(msg + ' — data/*.json の配置を確認してください。' +
      '(file:// で開いている場合、ブラウザの制約で fetch が使えないため data/embedded.js が必要です)'));
  }
  function showCards(show) {
    for (const id of ['summary', 'timeline-card', 'playback-card', 'tokens-card', 'heatmap-card']) {
      $('#' + id).hidden = !show;
    }
  }

  async function selectArm(armId, keepCursor) {
    const arm = ARMS.find((a) => a.id === armId) || ARMS[0];
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.arm === arm.id)));
    pausePlayback();
    hideTip();

    if (!cache[arm.id]) {
      try {
        cache[arm.id] = prepare(await loadRaw(arm.file), arm.label);
      } catch (e) {
        cache[arm.id] = { error: (e && e.message) || String(e) };
      }
    }
    const d = cache[arm.id];
    if (d.error) {
      current = null;
      showCards(false);
      setNotice(`${arm.label} (data/${arm.file}): ${d.error}`);
      return;
    }
    setNotice(null);
    showCards(true);
    const prevT = keepCursor && current === d ? play.t : null;
    current = d;
    renderSummary(d);
    renderTimeline(d);
    renderTokens(d);
    renderHeatmap(d);
    renderFeedReset();
    seekTo(prevT != null ? prevT : d.duration);
    try { history.replaceState(null, '', '#' + arm.id); } catch (_) { /* file:// may disallow */ }
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    document.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => selectArm(b.dataset.arm));
    });
    bindControls();
    window.addEventListener('resize', debounce(() => {
      if (!current) return;
      const t = play.t;
      renderTimeline(current);
      renderTokens(current);
      renderHeatmap(current);
      seekTo(t);
    }, 180));
    const initial = (location.hash || '').replace('#', '');
    selectArm(ARMS.some((a) => a.id === initial) ? initial : 'fable5');
  }
  boot();
})();
