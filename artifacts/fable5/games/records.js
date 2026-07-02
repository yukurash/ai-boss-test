/**
 * Mini Game Arcade - games/records.js  (schema v2: per-difficulty scores)
 *
 * "Records" screen: shows a high-score table for every game, broken out by
 * difficulty (easy / normal / hard), plus JSON export/import of the whole
 * save. This file never touches localStorage directly — all persistence
 * goes through the shared Arcade API.
 *
 * Data shape (core v2, nested by gameId then difficulty):
 *   { "<gameId>": { "<difficulty>": { "highScore": number, "plays": number } } }
 * Only the (gameId, difficulty) pairs that have been played exist.
 *   - Arcade.getState()      -> the nested map (migrated/normalized)
 *   - Arcade.replaceState(x) -> boolean (validates + persists on success;
 *                               also migrates any legacy flat entries)
 *   - Arcade.DIFFICULTIES    -> ['easy','normal','hard'] (used if present)
 * Export/Import JSON uses this same nested object-map shape.
 *
 * This file is safe to load even if `Arcade` is not defined yet (or at
 * all) - every touch of `Arcade` is guarded with a typeof check, so a
 * missing/out-of-order script tag can never throw at parse time.
 */
(function () {
  'use strict';

  // Games we always want a row for, even with zero plays.
  var KNOWN_GAME_IDS = ['breakout', 'reflex'];
  var GAME_LABELS = {
    breakout: 'Breakout',
    reflex: 'Reflex'
  };

  // Fallback if Arcade.DIFFICULTIES is unavailable at load/render time.
  var FALLBACK_DIFFICULTIES = ['easy', 'normal', 'hard'];

  var STYLE_ID = 'records-screen-styles';
  var EXPORT_FILENAME = 'arcade-save.json';

  // Per-mount state (there is only ever one live instance of this screen).
  var msgEl = null;
  var tableWrapEl = null;
  var importInputEl = null;
  var lastObjectUrl = null;

  // ---- pure helpers (no DOM) -- kept separate so they can be unit tested
  //      from Node without a browser/DOM present. ------------------------

  /** Returns the ordered list of difficulties to show as columns. */
  function getDifficulties() {
    if (typeof Arcade !== 'undefined' && Array.isArray(Arcade.DIFFICULTIES) && Arcade.DIFFICULTIES.length) {
      return Arcade.DIFFICULTIES.slice();
    }
    return FALLBACK_DIFFICULTIES.slice();
  }

  /**
   * Attempts to parse `text` as JSON and hand it to Arcade.replaceState().
   * Never throws. Returns { ok: true } on success, or
   * { ok: false, message } on failure (bad JSON or rejected by
   * Arcade.replaceState's shape validation). On failure, existing saved
   * data is left untouched (replaceState guarantees this).
   */
  function tryImportJSON(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, message: 'JSON の構文が正しくありません。ファイルを確認してください。' };
    }

    if (typeof Arcade === 'undefined' || typeof Arcade.replaceState !== 'function') {
      return { ok: false, message: 'Arcade が利用できないため、インポートできません。' };
    }

    var accepted = Arcade.replaceState(parsed);
    if (!accepted) {
      return {
        ok: false,
        message: 'セーブデータの形式が正しくありません(gameId ごとに難易度別の highScore/plays が数値である必要があります)。'
      };
    }

    return { ok: true };
  }

  /**
   * Builds the ordered list of gameIds to show: known games first (in
   * KNOWN_GAME_IDS order), then any other ids present in `state`
   * (alphabetical), so unknown/未知 gameIds from an imported save are
   * still visible.
   */
  function collectGameIds(state) {
    var ids = KNOWN_GAME_IDS.slice();
    var seen = {};
    ids.forEach(function (id) {
      seen[id] = true;
    });

    Object.keys(state || {})
      .filter(function (id) {
        return !seen[id];
      })
      .sort()
      .forEach(function (id) {
        ids.push(id);
        seen[id] = true;
      });

    return ids;
  }

  /**
   * Reads the (gameId, difficulty) leaf from a nested state map, returning
   * a valid { highScore, plays } record or null. Tolerates missing gameId
   * or difficulty and malformed leaves.
   */
  function getRecord(state, gameId, difficulty) {
    var game = state && state[gameId];
    if (!game || typeof game !== 'object') {
      return null;
    }
    var rec = game[difficulty];
    if (!rec || typeof rec !== 'object' ||
      typeof rec.highScore !== 'number' || typeof rec.plays !== 'number') {
      return null;
    }
    return rec;
  }

  /** Cell display text for a (gameId, difficulty): "highScore (plays)" or "—". */
  function formatCell(state, gameId, difficulty) {
    var rec = getRecord(state, gameId, difficulty);
    if (!rec) {
      return '—';
    }
    return String(rec.highScore) + ' (' + String(rec.plays) + ')';
  }

  function labelFor(gameId) {
    return GAME_LABELS[gameId] || gameId;
  }

  function difficultyLabel(diff) {
    return diff.charAt(0).toUpperCase() + diff.slice(1);
  }

  // ---- DOM helpers --------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.records-screen{display:flex;flex-direction:column;gap:16px;}' +
      '.records-toolbar{display:flex;gap:12px;flex-wrap:wrap;}' +
      '.records-import-label{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;}' +
      '.records-file-input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;}' +
      '.records-msg{min-height:1.4em;font-size:0.9rem;border-radius:8px;padding:0;transition:padding 0.1s ease;}' +
      '.records-msg:empty{padding:0;}' +
      '.records-msg-success{color:#7be08a;padding:8px 12px;background:rgba(123,224,138,0.08);border:1px solid rgba(123,224,138,0.35);border-radius:8px;}' +
      '.records-msg-error{color:var(--danger,#ff6b6b);padding:8px 12px;background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.35);border-radius:8px;}' +
      '.records-hint{color:var(--text-dim,#9096a8);font-size:0.8rem;}' +
      '.records-table-wrap{overflow-x:auto;}' +
      '.records-table{width:100%;border-collapse:collapse;font-size:0.95rem;}' +
      '.records-table th,.records-table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border,#2c3040);}' +
      '.records-table th{color:var(--text-dim,#9096a8);font-weight:600;font-size:0.85rem;}' +
      '.records-table td.records-num,.records-table th.records-num{text-align:right;font-variant-numeric:tabular-nums;}';
    document.head.appendChild(style);
  }

  function showMessage(type, text) {
    if (!msgEl) {
      return;
    }
    msgEl.textContent = text || '';
    msgEl.className = 'records-msg' + (text ? ' records-msg-' + type : '');
  }

  function revokeLastUrl() {
    if (lastObjectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(lastObjectUrl);
    }
    lastObjectUrl = null;
  }

  function renderTable() {
    if (!tableWrapEl) {
      return;
    }

    var state = (typeof Arcade !== 'undefined' && typeof Arcade.getState === 'function')
      ? Arcade.getState()
      : {};

    var ids = collectGameIds(state);
    var difficulties = getDifficulties();

    var table = document.createElement('table');
    table.className = 'records-table';

    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');

    var gameTh = document.createElement('th');
    gameTh.textContent = 'Game';
    headRow.appendChild(gameTh);

    difficulties.forEach(function (diff) {
      var th = document.createElement('th');
      th.className = 'records-num';
      th.textContent = difficultyLabel(diff);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    ids.forEach(function (id) {
      var row = document.createElement('tr');

      var nameCell = document.createElement('td');
      nameCell.textContent = labelFor(id);
      row.appendChild(nameCell);

      difficulties.forEach(function (diff) {
        var cell = document.createElement('td');
        cell.className = 'records-num';
        cell.textContent = formatCell(state, id, diff);
        row.appendChild(cell);
      });

      tbody.appendChild(row);
    });
    table.appendChild(tbody);

    tableWrapEl.innerHTML = '';
    tableWrapEl.appendChild(table);
  }

  function handleExport() {
    if (typeof Arcade === 'undefined' || typeof Arcade.getState !== 'function') {
      showMessage('error', 'Arcade が利用できないため、エクスポートできません。');
      return;
    }

    var state = Arcade.getState();
    var json = JSON.stringify(state, null, 2);
    var blob = new Blob([json], { type: 'application/json' });

    revokeLastUrl();
    var url = URL.createObjectURL(blob);
    lastObjectUrl = url;

    var a = document.createElement('a');
    a.href = url;
    a.download = EXPORT_FILENAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Give the browser a moment to start the download before revoking.
    setTimeout(revokeLastUrl, 1000);

    showMessage('success', 'エクスポートしました (' + EXPORT_FILENAME + ')');
  }

  function handleImportChange(event) {
    var input = event.target;
    var file = input.files && input.files[0];
    if (!file) {
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var text = typeof reader.result === 'string' ? reader.result : '';
      var result = tryImportJSON(text);
      if (result.ok) {
        showMessage('success', 'インポートしました。一覧を更新しました。');
        renderTable();
      } else {
        showMessage('error', result.message);
      }
      input.value = '';
    };
    reader.onerror = function () {
      showMessage('error', 'ファイルの読み込みに失敗しました。');
      input.value = '';
    };
    reader.readAsText(file);
  }

  // ---- screen lifecycle ----------------------------------------------------

  function mount(container) {
    ensureStyles();
    container.innerHTML = '';

    var root = document.createElement('div');
    root.className = 'records-screen';

    var toolbar = document.createElement('div');
    toolbar.className = 'records-toolbar';

    var exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn';
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', handleExport);

    var importLabel = document.createElement('label');
    importLabel.className = 'btn records-import-label';
    importLabel.textContent = 'Import';

    var importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.className = 'records-file-input';
    importInput.addEventListener('change', handleImportChange);
    importLabel.appendChild(importInput);
    importInputEl = importInput;

    toolbar.appendChild(exportBtn);
    toolbar.appendChild(importLabel);

    var message = document.createElement('div');
    message.className = 'records-msg';
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    msgEl = message;

    var hint = document.createElement('div');
    hint.className = 'records-hint';
    hint.textContent = '各セルは ハイスコア (プレイ回数)。未プレイは —。';

    var tableWrap = document.createElement('div');
    tableWrap.className = 'records-table-wrap';
    tableWrapEl = tableWrap;

    root.appendChild(toolbar);
    root.appendChild(message);
    root.appendChild(hint);
    root.appendChild(tableWrap);
    container.appendChild(root);

    // Always reflect the latest saved state on (re)mount, e.g. after the
    // user just played a game and comes back to Records.
    renderTable();
  }

  function unmount() {
    revokeLastUrl();
    msgEl = null;
    tableWrapEl = null;
    importInputEl = null;
  }

  if (typeof Arcade !== 'undefined' && typeof Arcade.registerScreen === 'function') {
    Arcade.registerScreen({
      id: 'records',
      title: 'Records',
      mount: mount,
      unmount: unmount
    });
  }

  // Expose pure helpers for Node-based testing (no DOM required).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      tryImportJSON: tryImportJSON,
      collectGameIds: collectGameIds,
      getRecord: getRecord,
      formatCell: formatCell,
      getDifficulties: getDifficulties
    };
  }
})();
