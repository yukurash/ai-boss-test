/**
 * Mini Game Arcade - games/reflex.js
 *
 * "Reflex" - a 5-round reaction-time mini game.
 *
 * Difficulty (added per core v2): 'easy' | 'normal' | 'hard', default
 * 'normal'. Chosen on the intro screen before starting. Difficulty only
 * changes the *random delay range* before the signal (see DELAY_RANGES) -
 * it does NOT scale the score, so the "shorter reaction -> higher score"
 * guarantee holds identically within every difficulty. Scores are saved
 * per-difficulty via Arcade.submitScore('reflex', score, difficulty).
 *
 * Flow per round:
 *   1. Round starts -> reaction area shows a neutral "wait" color.
 *   2. After a random delay (range depends on difficulty), the reaction
 *      area flips to a bright "go" color (the signal). This is the visual
 *      cue described in the task spec ("画面の色が明確に変化").
 *   3. The player reacts with a click on the reaction area, or by pressing
 *      the Space key anywhere on the page.
 *      - Reacting *before* the signal (while still waiting) is a "flying
 *        start" (フライング): that round scores 0 and no reaction time is
 *        recorded for it.
 *      - Reacting *after* the signal records reactionMs = time since the
 *        signal appeared.
 *   4. After 5 rounds, the per-round reaction times, their average and the
 *      final score are shown, and Arcade.submitScore('reflex', score) is
 *      called exactly once.
 *
 * ---------------------------------------------------------------------
 * Score formula (see computeRoundScore / summarizeRounds below):
 *
 *   ROUND_MAX_SCORE = 1000
 *   perRoundScore   = flying ? 0 : clamp(ROUND_MAX_SCORE - reactionMs, 0, ROUND_MAX_SCORE)
 *   finalScore      = sum(perRoundScore for each of the 5 rounds)   // 0..5000
 *
 * Rationale:
 *   - The score is computed independently for each round from that round's
 *     raw reaction time in milliseconds, then summed. A 1ms faster reaction
 *     is always worth exactly 1 more point (up to the 1000 point cap per
 *     round), so "shorter average reaction time -> higher score" holds by
 *     construction: shrinking any reaction time can only raise (never
 *     lower) the total.
 *   - The cap at 0 means reactions slower than 1000ms (or missing/None)
 *     are simply worth nothing for that round, instead of going negative -
 *     a very slow round shouldn't be able to drag the total below what a
 *     flying start would give.
 *   - A flying start is deliberately scored as 0, *not* as "reactionMs of
 *     0" (which would otherwise look like an impossibly great reaction and
 *     be worth the full 1000 points). This is important because flying
 *     rounds are excluded from the displayed average reaction time (there
 *     is no real reaction time to show) - if they also scored 0 points but
 *     were silently excluded from the *score* calculation too, mashing the
 *     button early would be a free way to skip a "bad" round without
 *     penalty. Making flying explicitly worth 0 in the sum ensures
 *     jumping the gun is always the worst outcome for a round, worse than
 *     even a slow-but-real reaction, which is what discourages guessing.
 *   - The displayed "average" is purely informational (average of the
 *     *valid* - i.e. non-flying - reaction times) so players can read their
 *     raw reflexes independently of the flying penalty baked into the
 *     score.
 * ---------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var ROUND_COUNT = 5;
  var ROUND_MAX_SCORE = 1000;

  var FALLBACK_DIFFICULTIES = ['easy', 'normal', 'hard'];
  var FALLBACK_DEFAULT_DIFFICULTY = 'normal';

  // Random delay range (ms) before the signal, per difficulty.
  //   - easy:   narrow & predictable window -> easy to anticipate.
  //   - normal: the original 1-4s window.
  //   - hard:   wide window with a shorter floor -> harder to time.
  // The score formula is identical across difficulties (see header): only
  // this delay window changes, so "faster reaction -> higher score" is
  // preserved within each difficulty.
  var DELAY_RANGES = {
    easy: { min: 2000, max: 3000 },
    normal: { min: 1000, max: 4000 },
    hard: { min: 800, max: 4500 }
  };

  // ---- pure logic (no DOM access - safe to unit test under Node) --------

  function getDifficulties() {
    if (global && global.Arcade && Array.isArray(global.Arcade.DIFFICULTIES) &&
        global.Arcade.DIFFICULTIES.length > 0) {
      return global.Arcade.DIFFICULTIES;
    }
    return FALLBACK_DIFFICULTIES;
  }

  function getDefaultDifficulty() {
    if (global && global.Arcade && typeof global.Arcade.DEFAULT_DIFFICULTY === 'string') {
      return global.Arcade.DEFAULT_DIFFICULTY;
    }
    return FALLBACK_DEFAULT_DIFFICULTY;
  }

  function delayRangeFor(difficulty) {
    return DELAY_RANGES[difficulty] || DELAY_RANGES.normal;
  }

  function computeRoundScore(reactionMs, flying) {
    if (flying) {
      return 0;
    }
    if (typeof reactionMs !== 'number' || !isFinite(reactionMs)) {
      return 0;
    }
    var raw = ROUND_MAX_SCORE - reactionMs;
    if (raw < 0) {
      raw = 0;
    }
    if (raw > ROUND_MAX_SCORE) {
      raw = ROUND_MAX_SCORE;
    }
    return Math.round(raw);
  }

  function summarizeRounds(rounds) {
    var perRoundScores = rounds.map(function (r) {
      return computeRoundScore(r.reactionMs, r.flying);
    });
    var totalScore = perRoundScores.reduce(function (sum, s) {
      return sum + s;
    }, 0);
    var validTimes = rounds
      .filter(function (r) {
        return !r.flying && typeof r.reactionMs === 'number' && isFinite(r.reactionMs);
      })
      .map(function (r) {
        return r.reactionMs;
      });
    var averageMs =
      validTimes.length > 0
        ? validTimes.reduce(function (sum, t) {
            return sum + t;
          }, 0) / validTimes.length
        : null;
    return {
      perRoundScores: perRoundScores,
      totalScore: totalScore,
      averageMs: averageMs
    };
  }

  function randomDelayMs(difficulty) {
    var range = delayRangeFor(difficulty);
    return range.min + Math.random() * (range.max - range.min);
  }

  function now() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  // ---- DOM-dependent screen (only touched from mount()/unmount()) -------

  // Per-mount session state. Reset at the top of mount() so re-mounting
  // (leave to menu, come back) always starts a clean game.
  var mounted = false;
  var containerEl = null;
  var state = null; // 'intro' | 'countdown' | 'signal' | 'round-result' | 'final'
  var rounds = [];
  var currentRoundIndex = 0;
  var signalTimeoutId = null;
  var signalStartTime = 0;
  var scoreSubmitted = false;
  var selectedDifficulty = FALLBACK_DEFAULT_DIFFICULTY;

  function clearSignalTimeout() {
    if (signalTimeoutId !== null) {
      clearTimeout(signalTimeoutId);
      signalTimeoutId = null;
    }
  }

  function resetGame() {
    clearSignalTimeout();
    rounds = [];
    currentRoundIndex = 0;
    scoreSubmitted = false;
    state = 'intro';
  }

  function beginRound() {
    clearSignalTimeout();
    state = 'countdown';
    render();
    var delay = randomDelayMs(selectedDifficulty);
    signalTimeoutId = setTimeout(function () {
      signalTimeoutId = null;
      signalStartTime = now();
      state = 'signal';
      render();
    }, delay);
  }

  function recordRound(reactionMs, flying) {
    rounds.push({ reactionMs: reactionMs, flying: flying });
    currentRoundIndex += 1;
    state = 'round-result';
    render();
  }

  // Fires on a click on the reaction area, or a Space key press, while a
  // round is actually in progress ('countdown' = before signal, 'signal' =
  // after signal). Anything outside those two states is ignored, which is
  // what stops accidental double-presses / mashing from being counted
  // twice: as soon as the first valid press is handled, `state` flips away
  // from 'countdown'/'signal' synchronously, so a second press arriving a
  // moment later (extra click, key auto-repeat, etc.) simply falls through
  // this guard and does nothing.
  function handleReactionInput() {
    if (!mounted) {
      return;
    }
    if (state === 'countdown') {
      // Pressed before the signal appeared: flying start.
      clearSignalTimeout();
      recordRound(null, true);
    } else if (state === 'signal') {
      var reactionMs = now() - signalStartTime;
      recordRound(reactionMs, false);
    }
    // 'intro' / 'round-result' / 'final': ignore, nothing to react to yet.
  }

  function handleKeydown(e) {
    if (!mounted) {
      return;
    }
    var isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
    if (!isSpace) {
      return;
    }
    if (e.repeat) {
      // Ignore OS key-auto-repeat while Space is held down.
      return;
    }
    if (state === 'countdown' || state === 'signal') {
      // Only swallow the key while it is meaningful as game input, so
      // Space still behaves normally (e.g. activating a focused button)
      // on the intro/result/final screens.
      e.preventDefault();
      handleReactionInput();
    }
  }

  function fmtMs(ms) {
    return Math.round(ms) + ' ms';
  }

  function makeButton(label, variant, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.fontFamily = 'inherit';
    btn.style.fontSize = '1rem';
    btn.style.borderRadius = '10px';
    btn.style.border = '1px solid var(--border, #2c3040)';
    btn.style.padding = '12px 20px';
    btn.style.cursor = 'pointer';
    btn.style.marginTop = '12px';
    btn.style.marginRight = '8px';
    if (variant === 'primary') {
      btn.style.background = 'var(--accent, #5b8cff)';
      btn.style.color = '#0b0d14';
      btn.style.fontWeight = '600';
      btn.style.border = 'none';
    } else {
      btn.style.background = 'var(--bg-panel, #1a1d29)';
      btn.style.color = 'var(--text, #e7e9f0)';
    }
    btn.addEventListener('click', onClick);
    return btn;
  }

  function render() {
    if (!containerEl) {
      return;
    }
    containerEl.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.flex = '1';

    if (state === 'intro') {
      renderIntro(wrap);
    } else if (state === 'countdown' || state === 'signal') {
      renderPlaying(wrap);
    } else if (state === 'round-result') {
      renderRoundResult(wrap);
    } else if (state === 'final') {
      renderFinal(wrap);
    }

    containerEl.appendChild(wrap);
  }

  function renderIntro(wrap) {
    var title = document.createElement('h3');
    title.textContent = '反射神経ゲーム';
    title.style.margin = '0 0 8px';
    wrap.appendChild(title);

    var desc = document.createElement('p');
    desc.style.color = 'var(--text-dim, #9096a8)';
    desc.textContent =
      '全 ' + ROUND_COUNT + ' ラウンド。合図(色が変わる)が出たら、すぐにエリアをクリックするか ' +
      'スペースキーを押してください。合図の前に押すとフライングで 0 点になります。';
    wrap.appendChild(desc);

    // ---- difficulty selector -------------------------------------------
    var diffLabel = document.createElement('p');
    diffLabel.textContent = '難易度';
    diffLabel.style.margin = '8px 0 4px';
    diffLabel.style.fontWeight = '600';
    wrap.appendChild(diffLabel);

    var diffRow = document.createElement('div');
    diffRow.style.display = 'flex';
    diffRow.style.gap = '8px';
    diffRow.style.flexWrap = 'wrap';

    var diffNames = { easy: 'かんたん', normal: 'ふつう', hard: 'むずかしい' };

    getDifficulties().forEach(function (diff) {
      var range = delayRangeFor(diff);
      var label = (diffNames[diff] || diff) +
        '（' + (range.min / 1000).toFixed(1) + '〜' + (range.max / 1000).toFixed(1) + '秒）';
      var isSelected = diff === selectedDifficulty;
      var btn = makeButton(label, isSelected ? 'primary' : 'secondary', function () {
        selectedDifficulty = diff;
        render();
      });
      btn.style.marginTop = '0';
      diffRow.appendChild(btn);
    });
    wrap.appendChild(diffRow);

    var startBtn = makeButton('スタート', 'primary', function () {
      resetGame();
      currentRoundIndex = 0;
      beginRound();
    });
    startBtn.style.marginTop = '20px';
    startBtn.style.alignSelf = 'flex-start';
    wrap.appendChild(startBtn);
  }

  function difficultyLabel(diff) {
    var names = { easy: 'かんたん', normal: 'ふつう', hard: 'むずかしい' };
    return names[diff] || diff;
  }

  function renderPlaying(wrap) {
    var info = document.createElement('p');
    info.style.color = 'var(--text-dim, #9096a8)';
    info.textContent = 'ラウンド ' + (currentRoundIndex + 1) + ' / ' + ROUND_COUNT +
      '（難易度: ' + difficultyLabel(selectedDifficulty) + '）';
    wrap.appendChild(info);

    var area = document.createElement('div');
    area.style.flex = '1';
    area.style.minHeight = '220px';
    area.style.borderRadius = '12px';
    area.style.display = 'flex';
    area.style.alignItems = 'center';
    area.style.justifyContent = 'center';
    area.style.textAlign = 'center';
    area.style.fontSize = '1.4rem';
    area.style.fontWeight = '700';
    area.style.userSelect = 'none';
    area.style.cursor = 'pointer';
    area.style.transition = 'background-color 0.08s ease';

    if (state === 'countdown') {
      area.style.background = '#2c3040';
      area.style.color = 'var(--text-dim, #9096a8)';
      area.textContent = 'まってください…';
    } else {
      area.style.background = '#33d17a';
      area.style.color = '#08240f';
      area.textContent = '今だ！ クリック / Space';
    }

    area.addEventListener('click', handleReactionInput);
    wrap.appendChild(area);

    var hint = document.createElement('p');
    hint.style.color = 'var(--text-dim, #9096a8)';
    hint.style.fontSize = '0.85rem';
    hint.textContent = '色が変わる前に押すとフライングです。';
    wrap.appendChild(hint);
  }

  function renderRoundResult(wrap) {
    var last = rounds[rounds.length - 1];

    var info = document.createElement('p');
    info.style.color = 'var(--text-dim, #9096a8)';
    info.textContent = 'ラウンド ' + currentRoundIndex + ' / ' + ROUND_COUNT + ' 終了';
    wrap.appendChild(info);

    var result = document.createElement('div');
    result.style.borderRadius = '12px';
    result.style.padding = '24px';
    result.style.textAlign = 'center';
    result.style.fontSize = '1.3rem';
    result.style.fontWeight = '700';

    if (last.flying) {
      result.style.background = 'rgba(255, 107, 107, 0.15)';
      result.style.color = 'var(--danger, #ff6b6b)';
      result.textContent = 'フライング！ 早すぎました (0点)';
    } else {
      result.style.background = 'rgba(91, 140, 255, 0.15)';
      result.style.color = 'var(--accent, #5b8cff)';
      result.textContent = '反応時間: ' + fmtMs(last.reactionMs);
    }
    wrap.appendChild(result);

    var isLast = currentRoundIndex >= ROUND_COUNT;
    wrap.appendChild(
      makeButton(isLast ? '結果を見る ▶' : '次のラウンドへ ▶', 'primary', function () {
        if (isLast) {
          state = 'final';
          render();
          submitFinalScoreIfNeeded();
        } else {
          beginRound();
        }
      })
    );
  }

  function renderFinal(wrap) {
    var summary = summarizeRounds(rounds);

    var title = document.createElement('h3');
    title.textContent = '結果';
    title.style.margin = '0 0 8px';
    wrap.appendChild(title);

    var diffP = document.createElement('p');
    diffP.style.color = 'var(--text-dim, #9096a8)';
    diffP.style.margin = '0 0 8px';
    diffP.textContent = '難易度: ' + difficultyLabel(selectedDifficulty);
    wrap.appendChild(diffP);

    var table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.marginBottom = '12px';

    var headRow = document.createElement('tr');
    ['ラウンド', '反応時間', 'ラウンド得点'].forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      th.style.textAlign = 'left';
      th.style.borderBottom = '1px solid var(--border, #2c3040)';
      th.style.padding = '6px 4px';
      th.style.color = 'var(--text-dim, #9096a8)';
      headRow.appendChild(th);
    });
    table.appendChild(headRow);

    rounds.forEach(function (r, idx) {
      var row = document.createElement('tr');

      var tdRound = document.createElement('td');
      tdRound.textContent = String(idx + 1);
      tdRound.style.padding = '6px 4px';
      tdRound.style.borderBottom = '1px solid var(--border, #2c3040)';
      row.appendChild(tdRound);

      var tdTime = document.createElement('td');
      tdTime.textContent = r.flying ? 'フライング' : fmtMs(r.reactionMs);
      tdTime.style.padding = '6px 4px';
      tdTime.style.borderBottom = '1px solid var(--border, #2c3040)';
      if (r.flying) {
        tdTime.style.color = 'var(--danger, #ff6b6b)';
      }
      row.appendChild(tdTime);

      var tdScore = document.createElement('td');
      tdScore.textContent = String(summary.perRoundScores[idx]);
      tdScore.style.padding = '6px 4px';
      tdScore.style.borderBottom = '1px solid var(--border, #2c3040)';
      row.appendChild(tdScore);

      table.appendChild(row);
    });

    wrap.appendChild(table);

    var avgP = document.createElement('p');
    avgP.textContent =
      '平均反応時間: ' + (summary.averageMs === null ? '記録なし(全ラウンドがフライング)' : fmtMs(summary.averageMs));
    wrap.appendChild(avgP);

    var scoreP = document.createElement('p');
    scoreP.style.fontSize = '1.3rem';
    scoreP.style.fontWeight = '700';
    scoreP.style.color = 'var(--accent, #5b8cff)';
    scoreP.textContent = '最終スコア: ' + summary.totalScore;
    wrap.appendChild(scoreP);

    if (highScoreInfo) {
      var hsP = document.createElement('p');
      hsP.style.color = 'var(--text-dim, #9096a8)';
      hsP.style.fontSize = '0.9rem';
      hsP.textContent = 'ハイスコア: ' + highScoreInfo.highScore + '（プレイ回数: ' + highScoreInfo.plays + '）';
      wrap.appendChild(hsP);
    }

    var btnRow = document.createElement('div');
    // Retry keeps the SAME difficulty (selectedDifficulty is untouched by
    // resetGame), per the spec.
    btnRow.appendChild(
      makeButton('もう一度プレイ（同じ難易度）', 'primary', function () {
        resetGame();
        beginRound();
      })
    );
    // Back to the difficulty-selection (intro) screen to change difficulty.
    btnRow.appendChild(
      makeButton('難易度を選び直す', 'secondary', function () {
        resetGame(); // state -> 'intro'; keeps selectedDifficulty as the current pick
        render();
      })
    );
    btnRow.appendChild(
      makeButton('メニューへ戻る', 'secondary', function () {
        var backBtn = document.getElementById('back-to-menu-btn');
        if (backBtn) {
          backBtn.click();
        }
      })
    );
    wrap.appendChild(btnRow);
  }

  var highScoreInfo = null;

  function submitFinalScoreIfNeeded() {
    if (scoreSubmitted) {
      return;
    }
    scoreSubmitted = true;
    var summary = summarizeRounds(rounds);
    if (global && global.Arcade && typeof global.Arcade.submitScore === 'function') {
      try {
        highScoreInfo = global.Arcade.submitScore('reflex', summary.totalScore, selectedDifficulty);
      } catch (e) {
        console.error('reflex: Arcade.submitScore threw', e);
        highScoreInfo = null;
      }
      // Re-render so the high score line shows up now that we have it.
      if (state === 'final') {
        render();
      }
    }
  }

  function mount(container) {
    containerEl = container;
    mounted = true;
    // Fresh mount from the menu -> start at the default difficulty.
    selectedDifficulty = getDefaultDifficulty();
    resetGame();
    document.addEventListener('keydown', handleKeydown);
    render();
  }

  function unmount() {
    mounted = false;
    clearSignalTimeout();
    document.removeEventListener('keydown', handleKeydown);
    containerEl = null;
    highScoreInfo = null;
  }

  // ---- registration -------------------------------------------------------
  // Guarded so that loading this script never throws even if Arcade (from
  // core.js) hasn't been defined yet / at all, e.g. when this file is
  // require()'d directly under Node for testing the pure scoring logic.
  if (global && global.Arcade && typeof global.Arcade.registerScreen === 'function') {
    global.Arcade.registerScreen({
      id: 'reflex',
      title: 'Reflex',
      mount: mount,
      unmount: unmount
    });
  }

  // ---- expose pure helpers for Node-based testing --------------------------
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      computeRoundScore: computeRoundScore,
      summarizeRounds: summarizeRounds,
      randomDelayMs: randomDelayMs,
      delayRangeFor: delayRangeFor,
      DELAY_RANGES: DELAY_RANGES,
      FALLBACK_DIFFICULTIES: FALLBACK_DIFFICULTIES,
      ROUND_MAX_SCORE: ROUND_MAX_SCORE,
      ROUND_COUNT: ROUND_COUNT
    };
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
