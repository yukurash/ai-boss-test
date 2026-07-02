/**
 * records.js — Records 画面 + セーブのインポート/エクスポート (T4, v2 難易度対応)
 *
 * 公開グローバル: window.Records = { onEnter(container), onExit() }
 *
 * データは window.Arcade の公開 API 経由でのみ扱う（localStorage 直接操作はしない）:
 *   - Arcade.GAMES                            : [{id, name}, ...] 一覧表示に使うメタ配列
 *   - Arcade.DIFFICULTIES                     : ['easy','normal','hard'] 難易度一覧（ハードコードせず回す）
 *   - Arcade.getHighScore(gameId, difficulty) : number | null
 *   - Arcade.getPlays(gameId, difficulty)     : number
 *   - Arcade.exportData()                     : 整形済み JSON 文字列（難易度別スコア含む）
 *   - Arcade.importData(json)                 : { ok: true } | { ok: false, error: string }（例外を投げない）
 */
(function (root) {
  'use strict';

  var COLORS = {
    border: '#2a3040',
    dim: '#8a93a6',
    accent: '#5fd0ff',
    error: '#ff6b6b'
  };

  function el(tag, opts) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.style) {
      for (var prop in opts.style) {
        if (Object.prototype.hasOwnProperty.call(opts.style, prop)) {
          node.style[prop] = opts.style[prop];
        }
      }
    }
    if (opts.attrs) {
      for (var attr in opts.attrs) {
        if (Object.prototype.hasOwnProperty.call(opts.attrs, attr)) {
          node.setAttribute(attr, opts.attrs[attr]);
        }
      }
    }
    return node;
  }

  function cellStyle() {
    return {
      textAlign: 'left',
      padding: '8px 12px',
      borderBottom: '1px solid ' + COLORS.border
    };
  }

  function titleCase(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // 難易度セルの表示: ハイスコア（未登録は「-」）と、その下にプレイ回数。
  function difficultyCellContent(high, plays) {
    var wrap = document.createElement('span');
    var scoreLine = el('span', {
      text: high === null || high === undefined ? '-' : String(high),
      style: { display: 'block' }
    });
    var playsLine = el('span', {
      text: 'plays: ' + String(plays),
      style: { display: 'block', fontSize: '0.8em', color: COLORS.dim }
    });
    wrap.appendChild(scoreLine);
    wrap.appendChild(playsLine);
    return wrap;
  }

  // ゲーム(行) × 難易度(列) のマトリクス表。難易度列は Arcade.DIFFICULTIES を回して生成。
  function buildTable() {
    var table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', margin: '16px 0' }
    });

    var difficulties = (root.Arcade && root.Arcade.DIFFICULTIES) || [];

    var thead = el('thead');
    var headRow = el('tr');
    headRow.appendChild(el('th', { text: 'Game', style: cellStyle() }));
    difficulties.forEach(function (d) {
      headRow.appendChild(el('th', { text: titleCase(d), style: cellStyle() }));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    var games = (root.Arcade && root.Arcade.GAMES) || [];
    games.forEach(function (game) {
      var row = el('tr');
      row.appendChild(el('td', { text: game.name, style: cellStyle() }));
      difficulties.forEach(function (d) {
        var high = root.Arcade.getHighScore(game.id, d);
        var plays = root.Arcade.getPlays(game.id, d);
        var td = el('td', { style: cellStyle() });
        td.appendChild(difficultyCellContent(high, plays));
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);

    return table;
  }

  function setMessage(container, text, isError) {
    var msg = container.querySelector('[data-records-message]');
    if (!msg) return;
    msg.textContent = text || '';
    msg.style.color = isError ? COLORS.error : COLORS.accent;
  }

  function triggerDownload(filename, content) {
    var blob = new Blob([content], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { attrs: { href: url, download: filename } });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // revoke after a tick so the click has time to start the download
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 0);
  }

  function handleExport() {
    var json = root.Arcade.exportData();
    triggerDownload('arcade-save.json', json);
  }

  function handleImportFile(container, file, fileInput) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var result = root.Arcade.importData(String(reader.result));
      if (result && result.ok) {
        render(container);
        setMessage(container, 'インポートに成功しました。', false);
      } else {
        var reason = (result && result.error) || 'インポートに失敗しました。';
        setMessage(container, reason, true);
        fileInput.value = '';
      }
    };
    reader.onerror = function () {
      setMessage(container, 'ファイルの読み込みに失敗しました。', true);
      fileInput.value = '';
    };
    reader.readAsText(file);
  }

  function render(container) {
    container.innerHTML = '';

    container.appendChild(el('h2', { text: 'Records' }));
    container.appendChild(buildTable());

    var actions = el('div', {
      style: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginTop: '16px' }
    });

    var exportBtn = el('button', { text: 'Export', attrs: { type: 'button' } });
    exportBtn.addEventListener('click', handleExport);
    actions.appendChild(exportBtn);

    var importLabel = el('label', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '8px' }
    });
    importLabel.appendChild(el('span', { text: 'Import:' }));
    var importInput = el('input', { attrs: { type: 'file', accept: 'application/json,.json' } });
    importInput.addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      handleImportFile(container, file, importInput);
    });
    importLabel.appendChild(importInput);
    actions.appendChild(importLabel);

    container.appendChild(actions);

    container.appendChild(el('div', {
      attrs: { 'data-records-message': 'true' },
      style: { marginTop: '8px', minHeight: '1.2em', color: COLORS.dim }
    }));

    var backWrap = el('div', { style: { marginTop: '24px' } });
    var backBtn = el('button', { text: 'メニューに戻る', attrs: { type: 'button' } });
    backBtn.addEventListener('click', function () {
      root.Arcade.showScreen('menu');
    });
    backWrap.appendChild(backBtn);
    container.appendChild(backWrap);
  }

  var Records = {
    onEnter: function (container) {
      if (!container) return;
      render(container);
    },
    onExit: function () {
      // 特別な後始末は不要
    }
  };

  root.Records = Records;
})(typeof window !== 'undefined' ? window : globalThis);
