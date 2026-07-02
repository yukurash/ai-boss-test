/**
 * reflex.js — T3: 反射神経ゲーム(難易度対応 v2)
 *
 * 公開グローバル: window.Reflex = { onEnter(container), onExit() }
 *   - onEnter(container): #screen-reflex 要素を受け取り、まず難易度選択画面を
 *     表示する。難易度を選ぶとその難易度でゲームを開始する。
 *     再入場のたびに完全に初期化し直す(難易度選択画面から)。
 *   - onExit(): 離脱時に呼ばれる。進行中の setTimeout / イベントリスナを
 *     必ずすべて解除する。
 *
 * ルール:
 *   - 5 ラウンド制。各ラウンドは開始からランダムな遅延の後に合図(色変化)が出る。
 *   - 合図が出た瞬間にクリックまたはスペースキーで反応する。
 *   - 合図前に反応するとフライング(そのラウンド 0 点, "FALSE START" 表示)。
 *   - 5 ラウンド終了で各ラウンドの反応時間・平均・最終スコア・難易度を表示する。
 *   - 終了時に Arcade.submitScore('reflex', score, difficulty) を呼ぶ。
 *   - リトライ(同じ難易度)・難易度選択に戻る・メニュー復帰ができる。
 *
 * 難易度(合図までのランダム遅延幅を変える):
 *   ゲーム性の核は「いつ合図が来るか読めない緊張感」。遅延幅を変えることで
 *   予測しにくさ = 難易度を調整する。採用値(PM 指定の例をそのまま採用):
 *     - easy:   1.0〜2.5 秒 … 幅 1.5 秒と狭く、待ち時間も短めで予測しやすい。
 *     - normal: 1.0〜4.0 秒 … 標準。幅 3.0 秒。
 *     - hard:   0.8〜5.0 秒 … 幅 4.2 秒と広く、最短が短く最長が長いので
 *                             タイミングが最も読みにくい。
 *   遅延幅のみを難易度で変え、スコア算出式(反応速度基準)は難易度非依存とする。
 *   これはスコアが難易度別バケットに分けて保存される(core.js v2)ため、
 *   同一難易度内での「速さ」を公平に比較できるようにする意図。
 *
 * このファイルはグローバルを Reflex 以外に一切追加しない。
 */
(function (root) {
  'use strict';

  var TOTAL_ROUNDS = 5;

  // 難易度ごとの合図遅延範囲(ミリ秒)。上のコメント参照。
  var DIFFICULTY_DELAYS = {
    easy: { min: 1000, max: 2500 },
    normal: { min: 1000, max: 4000 },
    hard: { min: 800, max: 5000 }
  };

  // core.js v2 の一覧に合わせるが、未ロード時のフォールバックも用意する。
  function getDifficulties() {
    if (root.Arcade && Array.isArray(root.Arcade.DIFFICULTIES)) {
      return root.Arcade.DIFFICULTIES;
    }
    return ['easy', 'normal', 'hard'];
  }
  function getDefaultDifficulty() {
    if (root.Arcade && typeof root.Arcade.DEFAULT_DIFFICULTY === 'string') {
      return root.Arcade.DEFAULT_DIFFICULTY;
    }
    return 'normal';
  }

  // ラウンドの内部フェーズ
  var PHASE_IDLE = 'idle';       // 合図待ち(色変化前)
  var PHASE_SIGNAL = 'signal';   // 合図が出て反応待ち
  var PHASE_RESULT = 'result';   // 結果表示中(自動遷移)

  // ---- モジュール内の可変状態 ---------------------------------------
  var state = null;

  function resetState(container) {
    return {
      container: container,
      difficulty: getDefaultDifficulty(),
      round: 0,
      results: [], // 各ラウンドの反応時間(ms)。フライングは null。
      phase: PHASE_IDLE,
      timeoutId: null,
      resultTimeoutId: null,
      signalStartTime: 0,
      els: {},
      listeners: [] // { target, type, fn } のリスト。teardown で一括解除。
    };
  }

  function clearTimers(s) {
    if (s.timeoutId !== null) {
      root.clearTimeout(s.timeoutId);
      s.timeoutId = null;
    }
    if (s.resultTimeoutId !== null) {
      root.clearTimeout(s.resultTimeoutId);
      s.resultTimeoutId = null;
    }
  }

  function addListener(s, target, type, fn) {
    target.addEventListener(type, fn);
    s.listeners.push({ target: target, type: type, fn: fn });
  }

  function removeAllListeners(s) {
    for (var i = 0; i < s.listeners.length; i++) {
      var l = s.listeners[i];
      l.target.removeEventListener(l.type, l.fn);
    }
    s.listeners = [];
  }

  // ---- スコア算出 ------------------------------------------------------
  //
  //   score = round( clamp(1000 - (avgMs - 150) * (1000 / (900 - 150)), 0, 1000) )
  //
  // 設計根拠:
  //   - 人間の視覚反応の理論的下限はおよそ 150ms 程度。これ以下は現実的に
  //     到達不能なので 150ms を満点(1000点)基準とする。
  //   - 900ms 以上は「ほぼ反応できていない」に近い遅さとみなし 0 点。
  //   - 150〜900ms を線形にスコア 1000〜0 へ写像。わずかな上達も素直に反映。
  //   - フライング(反応時間なし)は平均計算から除外。全ラウンドがフライング
  //     の場合は平均が定義できないため 0 点(荒稼ぎ防止)。
  //   - 難易度非依存(スコアは難易度別バケットに分けて保存されるため)。
  //   - 端数は四捨五入。
  function computeScore(results) {
    var valid = onlyNumbers(results);
    if (valid.length === 0) return 0;
    var avgMs = sum(valid) / valid.length;
    var FLOOR_MS = 150;
    var CEIL_MS = 900;
    var raw = 1000 - (avgMs - FLOOR_MS) * (1000 / (CEIL_MS - FLOOR_MS));
    return Math.round(Math.max(0, Math.min(1000, raw)));
  }

  function average(results) {
    var valid = onlyNumbers(results);
    if (valid.length === 0) return null;
    return sum(valid) / valid.length;
  }

  function onlyNumbers(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (typeof arr[i] === 'number') out.push(arr[i]);
    }
    return out;
  }

  function sum(arr) {
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += arr[i];
    return t;
  }

  // ---- 難易度選択画面 --------------------------------------------------

  function showDifficultySelect(s) {
    clearTimers(s);
    removeAllListeners(s); // 前の画面のリスナを解除
    s.phase = PHASE_IDLE;

    var container = s.container;
    container.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.style.maxWidth = '480px';

    var heading = document.createElement('h2');
    heading.textContent = 'Reflex';
    wrap.appendChild(heading);

    var prompt = document.createElement('p');
    prompt.textContent = 'Select difficulty:';
    wrap.appendChild(prompt);

    var diffs = getDifficulties();
    var def = getDefaultDifficulty();

    var btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.flexDirection = 'column';
    btnRow.style.gap = '10px';
    btnRow.style.maxWidth = '320px';

    for (var i = 0; i < diffs.length; i++) {
      (function (diff) {
        var range = DIFFICULTY_DELAYS[diff] || DIFFICULTY_DELAYS[def];
        var high = null;
        if (root.Arcade && typeof root.Arcade.getHighScore === 'function') {
          high = root.Arcade.getHighScore('reflex', diff);
        }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'reflex-diff-btn';
        btn.setAttribute('data-difficulty', diff);
        var label = capitalize(diff);
        var rangeText = (range.min / 1000).toFixed(1) + '–' + (range.max / 1000).toFixed(1) + 's delay';
        var highText = (typeof high === 'number') ? ' | High: ' + high : '';
        btn.textContent = label + '  (' + rangeText + highText + ')';
        if (diff === def) btn.textContent += '  ★';
        btn.style.textAlign = 'left';
        addListener(s, btn, 'click', function () {
          s.difficulty = diff;
          buildGameUI(s);
          startGame(s);
        });
        btnRow.appendChild(btn);
      })(diffs[i]);
    }

    wrap.appendChild(btnRow);

    var menuRow = document.createElement('div');
    menuRow.style.marginTop = '16px';
    var menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'reflex-menu-btn';
    menuBtn.textContent = 'Back to Menu';
    addListener(s, menuBtn, 'click', function () {
      if (root.Arcade && typeof root.Arcade.showScreen === 'function') {
        root.Arcade.showScreen('menu');
      }
    });
    menuRow.appendChild(menuBtn);
    wrap.appendChild(menuRow);

    container.appendChild(wrap);
  }

  // ---- ゲーム UI 構築 --------------------------------------------------

  function buildGameUI(s) {
    clearTimers(s);
    removeAllListeners(s); // 難易度選択画面のリスナを解除
    s.phase = PHASE_IDLE;

    var container = s.container;
    container.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.style.maxWidth = '480px';

    var heading = document.createElement('h2');
    heading.textContent = 'Reflex — ' + capitalize(s.difficulty);
    wrap.appendChild(heading);

    var status = document.createElement('p');
    status.className = 'reflex-status';
    wrap.appendChild(status);

    var pad = document.createElement('div');
    pad.className = 'reflex-pad';
    pad.tabIndex = 0;
    pad.style.width = '100%';
    pad.style.height = '220px';
    pad.style.display = 'flex';
    pad.style.alignItems = 'center';
    pad.style.justifyContent = 'center';
    pad.style.fontSize = '1.1rem';
    pad.style.textAlign = 'center';
    pad.style.userSelect = 'none';
    pad.style.borderRadius = '8px';
    pad.style.border = '1px solid #3a4257';
    pad.style.background = '#232a3a';
    pad.style.cursor = 'pointer';
    wrap.appendChild(pad);

    var roundInfo = document.createElement('p');
    roundInfo.className = 'reflex-round-info';
    wrap.appendChild(roundInfo);

    var resultsList = document.createElement('ul');
    resultsList.className = 'reflex-results';
    wrap.appendChild(resultsList);

    var summary = document.createElement('div');
    summary.className = 'reflex-summary';
    summary.style.display = 'none';
    wrap.appendChild(summary);

    var controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '12px';
    controls.style.marginTop = '16px';
    controls.style.flexWrap = 'wrap';

    var retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'reflex-retry-btn';
    retryBtn.textContent = 'Retry (same difficulty)';

    var changeDiffBtn = document.createElement('button');
    changeDiffBtn.type = 'button';
    changeDiffBtn.className = 'reflex-change-diff-btn';
    changeDiffBtn.textContent = 'Change Difficulty';

    var menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'reflex-menu-btn';
    menuBtn.textContent = 'Back to Menu';

    controls.appendChild(retryBtn);
    controls.appendChild(changeDiffBtn);
    controls.appendChild(menuBtn);
    wrap.appendChild(controls);

    container.appendChild(wrap);

    s.els = {
      status: status,
      pad: pad,
      roundInfo: roundInfo,
      resultsList: resultsList,
      summary: summary,
      retryBtn: retryBtn,
      changeDiffBtn: changeDiffBtn,
      menuBtn: menuBtn
    };

    // イベント登録(すべて s.listeners 経由 → teardown で確実に解除)
    addListener(s, pad, 'click', function () { onInput(s); });
    addListener(s, root, 'keydown', function (evt) {
      if (evt.code !== 'Space' && evt.key !== ' ') return;
      evt.preventDefault();
      onInput(s);
    });
    addListener(s, retryBtn, 'click', function () { startGame(s); });
    addListener(s, changeDiffBtn, 'click', function () { showDifficultySelect(s); });
    addListener(s, menuBtn, 'click', function () {
      if (root.Arcade && typeof root.Arcade.showScreen === 'function') {
        root.Arcade.showScreen('menu');
      }
    });
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // ---- ラウンド進行 ----------------------------------------------------

  function startGame(s) {
    s.round = 0;
    s.results = [];
    s.els.resultsList.innerHTML = '';
    s.els.summary.style.display = 'none';
    s.els.summary.innerHTML = '';
    startRound(s);
  }

  function startRound(s) {
    clearTimers(s);
    s.phase = PHASE_IDLE;
    setPadIdle(s);

    s.els.roundInfo.textContent = 'Round ' + (s.round + 1) + ' / ' + TOTAL_ROUNDS;
    s.els.status.textContent = 'Wait for the color to change...';

    var range = DIFFICULTY_DELAYS[s.difficulty] || DIFFICULTY_DELAYS[getDefaultDifficulty()];
    var delay = range.min + Math.random() * (range.max - range.min);
    s.timeoutId = root.setTimeout(function () {
      s.timeoutId = null;
      showSignal(s);
    }, delay);
  }

  function setPadIdle(s) {
    s.els.pad.style.background = '#232a3a';
    s.els.pad.textContent = 'Wait...';
  }

  function showSignal(s) {
    s.phase = PHASE_SIGNAL;
    s.signalStartTime = Date.now();
    s.els.pad.style.background = '#3ddc84';
    s.els.pad.textContent = 'CLICK / SPACE NOW!';
    s.els.status.textContent = 'React now!';
  }

  function onInput(s) {
    if (s.phase === PHASE_IDLE) {
      handleFalseStart(s);
    } else if (s.phase === PHASE_SIGNAL) {
      handleReaction(s);
    }
  }

  function recordRoundResult(s, reactionMs) {
    s.results.push(reactionMs);
    var li = document.createElement('li');
    if (reactionMs === null) {
      li.textContent = 'Round ' + (s.round + 1) + ': FALSE START (0 pts)';
    } else {
      li.textContent = 'Round ' + (s.round + 1) + ': ' + reactionMs + ' ms';
    }
    s.els.resultsList.appendChild(li);
  }

  function handleFalseStart(s) {
    if (s.phase !== PHASE_IDLE) return;
    clearTimers(s);
    s.phase = PHASE_RESULT;
    s.els.pad.style.background = '#e05263';
    s.els.pad.textContent = 'FALSE START!';
    s.els.status.textContent = 'Too early! This round scores 0.';
    recordRoundResult(s, null);
    advanceAfterDelay(s);
  }

  function handleReaction(s) {
    if (s.phase !== PHASE_SIGNAL) return;
    var reactionMs = Date.now() - s.signalStartTime;
    s.phase = PHASE_RESULT;
    s.els.pad.style.background = '#5fd0ff';
    s.els.pad.textContent = reactionMs + ' ms';
    s.els.status.textContent = 'Recorded: ' + reactionMs + ' ms';
    recordRoundResult(s, reactionMs);
    advanceAfterDelay(s);
  }

  function advanceAfterDelay(s) {
    s.resultTimeoutId = root.setTimeout(function () {
      s.resultTimeoutId = null;
      s.round += 1;
      if (s.round >= TOTAL_ROUNDS) {
        finishGame(s);
      } else {
        startRound(s);
      }
    }, 900);
  }

  function finishGame(s) {
    s.phase = PHASE_RESULT;
    setPadIdle(s);
    s.els.pad.textContent = 'Done!';
    s.els.roundInfo.textContent = 'Finished ' + TOTAL_ROUNDS + ' rounds';
    s.els.status.textContent = '';

    var avgMs = average(s.results);
    var score = computeScore(s.results);

    var highScore = null;
    if (root.Arcade && typeof root.Arcade.submitScore === 'function') {
      root.Arcade.submitScore('reflex', score, s.difficulty);
    }
    if (root.Arcade && typeof root.Arcade.getHighScore === 'function') {
      highScore = root.Arcade.getHighScore('reflex', s.difficulty);
    }

    var summary = s.els.summary;
    summary.style.display = 'block';
    summary.innerHTML = '';

    var diffLine = document.createElement('p');
    diffLine.textContent = 'Difficulty: ' + capitalize(s.difficulty);
    summary.appendChild(diffLine);

    var avgLine = document.createElement('p');
    avgLine.textContent = avgMs === null
      ? 'Average reaction time: N/A (all false starts)'
      : 'Average reaction time: ' + Math.round(avgMs) + ' ms';
    summary.appendChild(avgLine);

    var scoreLine = document.createElement('p');
    scoreLine.textContent = 'Final score: ' + score;
    summary.appendChild(scoreLine);

    if (highScore !== null) {
      var highLine = document.createElement('p');
      highLine.textContent = 'High score (' + capitalize(s.difficulty) + '): ' + highScore;
      summary.appendChild(highLine);
    }
  }

  // ---- ライフサイクル --------------------------------------------------

  function onEnter(container) {
    if (state) teardown(state);
    state = resetState(container);
    showDifficultySelect(state); // まず難易度選択から
  }

  function teardown(s) {
    clearTimers(s);
    removeAllListeners(s);
  }

  function onExit() {
    if (state) {
      teardown(state);
      state = null;
    }
  }

  root.Reflex = {
    onEnter: onEnter,
    onExit: onExit,
    // Node 単体テスト用に純粋なスコア算出ロジックを公開。
    _computeScoreForTest: computeScore,
    _difficultyDelaysForTest: DIFFICULTY_DELAYS
  };
})(typeof window !== 'undefined' ? window : globalThis);
