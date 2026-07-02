/**
 * games/breakout.js — T2: ブロック崩し (Breakout)
 *
 * 公開グローバル:
 *   - window.Breakout      … PM 統合契約のライフサイクル { onEnter(container), onExit() }
 *   - window.BreakoutLogic … 純粋ロジック（DOM に触れない）。tests/breakout.test.html から参照する。
 *
 * 外部ライブラリ・CDN は使用しない。バニラ JS + canvas のみ。
 * すべての描画・入力ハンドラは onEnter で渡された container 配下に閉じ、
 * onExit で確実に後始末する（rAF 停止・イベント解除・タイマー解除）。
 */
(function (root) {
  'use strict';

  // =====================================================================
  // 純粋ロジック（DOM 非依存・テスト可能）
  // =====================================================================

  var CANVAS_W = 480;
  var CANVAS_H = 600;
  var PADDLE_W = 90;
  var PADDLE_H = 12;
  var PADDLE_Y = CANVAS_H - 30;
  var BALL_R = 7;
  var BASE_BALL_SPEED = 260;
  var BALL_SPEED_STEP = 40;
  var HIT_POINTS = 10; // ブロックに 1 発当てるごとの加点
  var MAX_BOUNCE_ANGLE = Math.PI / 3; // パドル端で反射する最大角度（60度）

  // --- 難易度設定 --------------------------------------------------------
  // core.js (v2) の難易度と一致させる。第3引数省略時のフォールバックは normal。
  var DIFFICULTIES = ['easy', 'normal', 'hard'];
  var DEFAULT_DIFFICULTY = 'normal';
  // 採用値の根拠:
  //   speedMul … normal(1.0) を基準に easy は 0.75 倍で「ゆっくり反応しやすく」、
  //              hard は 1.35 倍で「速く反射に追従しづらく」する。レベル進行加速
  //              (BALL_SPEED_STEP) にも同じ倍率が掛かる。
  //   lives    … PM 例示どおり easy=5 / normal=3 / hard=2。難易度が上がるほど猶予が減る。
  var DIFFICULTY_CONFIG = {
    easy:   { speedMul: 0.75, lives: 5 },
    normal: { speedMul: 1.0,  lives: 3 },
    hard:   { speedMul: 1.35, lives: 2 }
  };

  function normalizeDifficulty(difficulty) {
    return DIFFICULTIES.indexOf(difficulty) !== -1 ? difficulty : DEFAULT_DIFFICULTY;
  }

  function livesForDifficulty(difficulty) {
    return DIFFICULTY_CONFIG[normalizeDifficulty(difficulty)].lives;
  }

  function speedMultiplierForDifficulty(difficulty) {
    return DIFFICULTY_CONFIG[normalizeDifficulty(difficulty)].speedMul;
  }

  // レベル定義: pattern は行×列の 0/1/2（0=無し, 1=耐久1, 2=耐久2）
  // 3 レベルとも配置が異なる（受入基準5）
  var LEVEL_DEFS = [
    {
      // Level 1: シンプルな全面グリッド
      cols: 8,
      pattern: [
        [1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1]
      ]
    },
    {
      // Level 2: 市松模様 + 耐久2ブロック
      cols: 8,
      pattern: [
        [1, 0, 1, 0, 1, 0, 1, 0],
        [0, 2, 0, 2, 0, 2, 0, 2],
        [1, 0, 1, 0, 1, 0, 1, 0],
        [0, 2, 0, 2, 0, 2, 0, 2],
        [1, 0, 1, 0, 1, 0, 1, 0]
      ]
    },
    {
      // Level 3: 中央に耐久2ブロックの塊、外周は耐久1
      cols: 8,
      pattern: [
        [0, 0, 1, 1, 1, 1, 0, 0],
        [0, 1, 2, 1, 1, 2, 1, 0],
        [1, 2, 2, 2, 2, 2, 2, 1],
        [1, 1, 2, 1, 1, 2, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1]
      ]
    }
  ];

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  /** レベルインデックス（0始まり）からブロック配列を生成する純粋関数 */
  function buildBlocksForLevel(levelIndex) {
    var cfg = LEVEL_DEFS[levelIndex];
    if (!cfg) return [];
    var marginX = 24;
    var marginTop = 50;
    var gap = 6;
    var blockH = 18;
    var cols = cfg.cols;
    var blockW = (CANVAS_W - marginX * 2 - gap * (cols - 1)) / cols;
    var blocks = [];
    for (var r = 0; r < cfg.pattern.length; r++) {
      var row = cfg.pattern[r];
      for (var c = 0; c < cols; c++) {
        var hp = row[c];
        if (!hp) continue;
        blocks.push({
          x: marginX + c * (blockW + gap),
          y: marginTop + r * (blockH + gap),
          w: blockW,
          h: blockH,
          hp: hp,
          maxHp: hp,
          points: hp * 20,
          alive: true,
          row: r,
          col: c
        });
      }
    }
    return blocks;
  }

  function clampPaddleX(x, paddleWidth, canvasWidth) {
    return clamp(x, 0, canvasWidth - paddleWidth);
  }

  /**
   * パドルの当たり位置（offset: -1=左端 〜 0=中央 〜 1=右端）から
   * 反射後の速度ベクトルを算出する。速度の大きさ(speed)は保存される。
   */
  function paddleBounceVelocity(offset, speed) {
    var o = clamp(offset, -1, 1);
    var angle = o * MAX_BOUNCE_ANGLE;
    return {
      vx: speed * Math.sin(angle),
      vy: -speed * Math.cos(angle)
    };
  }

  /** 円と矩形の交差判定 */
  function circleRectIntersect(cx, cy, r, rx, ry, rw, rh) {
    var closestX = clamp(cx, rx, rx + rw);
    var closestY = clamp(cy, ry, ry + rh);
    var dx = cx - closestX;
    var dy = cy - closestY;
    return (dx * dx + dy * dy) <= r * r;
  }

  /**
   * ブロック(矩形)に衝突した際の反射速度を求める（最小重なり軸で反射）。
   * ball: {x,y,r,vx,vy}, rect: {x,y,w,h}
   */
  function resolveBlockCollision(ball, rect) {
    var rectCx = rect.x + rect.w / 2;
    var rectCy = rect.y + rect.h / 2;
    var dx = ball.x - rectCx;
    var dy = ball.y - rectCy;
    var overlapX = (rect.w / 2 + ball.r) - Math.abs(dx);
    var overlapY = (rect.h / 2 + ball.r) - Math.abs(dy);
    if (overlapX < overlapY) {
      return { vx: -ball.vx, vy: ball.vy };
    }
    return { vx: ball.vx, vy: -ball.vy };
  }

  function allBlocksDestroyed(blocks) {
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].alive) return false;
    }
    return true;
  }

  /** レベルクリアボーナス（レベルが進むほど高い） */
  function levelClearBonus(levelIndex) {
    return (levelIndex + 1) * 100;
  }

  /** ブロックが破壊された時点で加算される得点（1発あたりの HIT_POINTS とは別枠のボーナス） */
  function computeBlockScore(block) {
    return block.maxHp * 20;
  }

  // difficulty 省略時は normal 相当（倍率 1.0）。既存呼び出しと後方互換。
  function ballSpeedForLevel(levelIndex, difficulty) {
    var base = BASE_BALL_SPEED + levelIndex * BALL_SPEED_STEP;
    return base * speedMultiplierForDifficulty(difficulty);
  }

  var BreakoutLogic = {
    CANVAS_W: CANVAS_W,
    CANVAS_H: CANVAS_H,
    PADDLE_W: PADDLE_W,
    PADDLE_H: PADDLE_H,
    BALL_R: BALL_R,
    HIT_POINTS: HIT_POINTS,
    LEVEL_DEFS: LEVEL_DEFS,
    LEVEL_COUNT: LEVEL_DEFS.length,
    DIFFICULTIES: DIFFICULTIES,
    DEFAULT_DIFFICULTY: DEFAULT_DIFFICULTY,
    DIFFICULTY_CONFIG: DIFFICULTY_CONFIG,
    normalizeDifficulty: normalizeDifficulty,
    livesForDifficulty: livesForDifficulty,
    speedMultiplierForDifficulty: speedMultiplierForDifficulty,
    buildBlocksForLevel: buildBlocksForLevel,
    clampPaddleX: clampPaddleX,
    paddleBounceVelocity: paddleBounceVelocity,
    circleRectIntersect: circleRectIntersect,
    resolveBlockCollision: resolveBlockCollision,
    allBlocksDestroyed: allBlocksDestroyed,
    levelClearBonus: levelClearBonus,
    computeBlockScore: computeBlockScore,
    ballSpeedForLevel: ballSpeedForLevel
  };

  root.BreakoutLogic = BreakoutLogic;

  // =====================================================================
  // ゲーム本体（DOM / canvas 依存）— container 配下に完全に閉じる
  // =====================================================================

  // onExit で後始末できるように、現在アクティブなインスタンスの破棄関数を保持する
  var activeTeardown = null;

  function createGame(container, difficulty) {
    difficulty = normalizeDifficulty(difficulty);

    container.innerHTML =
      '<div class="t2bo-wrap" style="display:flex;flex-direction:column;align-items:center;gap:10px;font-family:inherit;color:#e8ecf4;">' +
        '<div class="t2bo-hud" style="display:flex;gap:16px;align-items:center;width:' + CANVAS_W + 'px;justify-content:space-between;flex-wrap:wrap;">' +
          '<span>Score: <strong id="t2bo-score">0</strong></span>' +
          '<span>Lives: <strong id="t2bo-lives">3</strong></span>' +
          '<span>Level: <strong id="t2bo-level">1</strong>/' + LEVEL_DEFS.length + '</span>' +
          '<span>Diff: <strong id="t2bo-diff">' + difficulty + '</strong></span>' +
          '<span>High: <strong id="t2bo-highscore">-</strong></span>' +
          '<button type="button" id="t2bo-pause-btn">Pause (Esc)</button>' +
          '<button type="button" id="t2bo-menu-btn">Menu</button>' +
        '</div>' +
        '<div style="position:relative;">' +
          '<canvas id="t2bo-canvas" width="' + CANVAS_W + '" height="' + CANVAS_H + '" ' +
            'style="background:#0b0e14;border:1px solid #3a4257;border-radius:4px;display:block;touch-action:none;"></canvas>' +
          '<div id="t2bo-overlay" style="position:absolute;inset:0;display:none;flex-direction:column;' +
            'align-items:center;justify-content:center;gap:12px;background:rgba(10,12,18,0.86);' +
            'text-align:center;padding:16px;box-sizing:border-box;">' +
            '<h3 id="t2bo-overlay-title" style="margin:0;font-size:1.3rem;"></h3>' +
            '<p id="t2bo-overlay-msg" style="margin:0;color:#8a93a6;"></p>' +
            '<div id="t2bo-overlay-actions" style="display:flex;gap:10px;"></div>' +
          '</div>' +
        '</div>' +
        '<p style="margin:0;color:#8a93a6;font-size:0.9rem;">← → キーまたはマウスでパドル操作 / クリックまたは Space でボール発射 / Esc で一時停止</p>' +
      '</div>';

    var canvas = container.querySelector('#t2bo-canvas');
    var ctx = canvas.getContext('2d');
    var overlay = container.querySelector('#t2bo-overlay');
    var overlayTitle = container.querySelector('#t2bo-overlay-title');
    var overlayMsg = container.querySelector('#t2bo-overlay-msg');
    var overlayActions = container.querySelector('#t2bo-overlay-actions');
    var scoreEl = container.querySelector('#t2bo-score');
    var livesEl = container.querySelector('#t2bo-lives');
    var levelEl = container.querySelector('#t2bo-level');
    var highScoreEl = container.querySelector('#t2bo-highscore');
    var pauseBtn = container.querySelector('#t2bo-pause-btn');
    var menuBtn = container.querySelector('#t2bo-menu-btn');

    // ---- ゲーム状態 -----------------------------------------------------
    var levelIndex = 0;
    var score = 0;
    var lives = livesForDifficulty(difficulty);
    var blocks = buildBlocksForLevel(levelIndex);
    var paddle = { x: (CANVAS_W - PADDLE_W) / 2, y: PADDLE_Y, w: PADDLE_W, h: PADDLE_H };
    var ball = { x: 0, y: 0, r: BALL_R, vx: 0, vy: 0 };
    var waitingLaunch = true;
    var leftPressed = false;
    var rightPressed = false;
    var paused = false;
    // phase: 'playing' | 'gameover' | 'levelclear' | 'cleared'
    var phase = 'playing';
    var rafId = null;
    var lastTs = null;
    var launchTimeoutId = null;
    var destroyed = false;

    function resetBallOnPaddle() {
      ball.x = paddle.x + paddle.w / 2;
      ball.y = paddle.y - BALL_R - 1;
      ball.vx = 0;
      ball.vy = 0;
      waitingLaunch = true;
      scheduleAutoLaunch();
    }

    function clearLaunchTimeout() {
      if (launchTimeoutId !== null) {
        clearTimeout(launchTimeoutId);
        launchTimeoutId = null;
      }
    }

    // ポーズ中にタイマーが発火した場合は取りこぼさず、再開まで発射を再試行し続ける
    function scheduleAutoLaunch() {
      clearLaunchTimeout();
      launchTimeoutId = setTimeout(checkAutoLaunch, 1200);
    }

    function checkAutoLaunch() {
      launchTimeoutId = null;
      if (destroyed || phase !== 'playing' || !waitingLaunch) return;
      if (paused) {
        // 一時停止中はまだ発射しない。再開されるまで短い間隔で再チェックする。
        launchTimeoutId = setTimeout(checkAutoLaunch, 300);
        return;
      }
      launchBall();
    }

    function launchBall() {
      if (!waitingLaunch || phase !== 'playing' || paused) return;
      var speed = ballSpeedForLevel(levelIndex, difficulty);
      var angle = (Math.random() * 0.5 - 0.25); // わずかにランダムな初期角
      ball.vx = speed * Math.sin(angle);
      ball.vy = -speed * Math.cos(angle);
      waitingLaunch = false;
      clearLaunchTimeout();
    }

    function updateHud() {
      scoreEl.textContent = String(score);
      livesEl.textContent = String(lives);
      levelEl.textContent = String(levelIndex + 1);
      var hs = null;
      try {
        // 現在の難易度のハイスコアを表示（難易度別）
        hs = root.Arcade ? root.Arcade.getHighScore('breakout', difficulty) : null;
      } catch (e) { hs = null; }
      highScoreEl.textContent = (hs === null || hs === undefined) ? '-' : String(hs);
    }

    function showOverlay(title, msg, buttons) {
      overlayTitle.textContent = title;
      overlayMsg.textContent = msg;
      overlayActions.innerHTML = '';
      buttons.forEach(function (b) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = b.label;
        btn.addEventListener('click', b.onClick);
        overlayActions.appendChild(btn);
      });
      overlay.style.display = 'flex';
    }

    function hideOverlay() {
      overlay.style.display = 'none';
    }

    function backToMenu() {
      root.Arcade.showScreen('menu');
    }

    function backToDifficultySelect() {
      // 自分自身を破棄してから難易度選択画面へ戻る
      showDifficultySelect(container);
    }

    function submitFinalScore() {
      try {
        // 選択難易度でスコアを保存
        root.Arcade.submitScore('breakout', score, difficulty);
      } catch (e) {
        // Arcade 未提供でも描画は継続する
      }
      updateHud();
    }

    function gameOver() {
      phase = 'gameover';
      clearLaunchTimeout();
      submitFinalScore();
      showOverlay('Game Over', 'Score: ' + score + '  (' + difficulty + ')', [
        { label: 'Retry (' + difficulty + ')', onClick: restartGame },
        { label: 'Difficulty', onClick: backToDifficultySelect },
        { label: 'Menu', onClick: backToMenu }
      ]);
    }

    function proceedToNextLevel() {
      hideOverlay();
      levelIndex += 1;
      blocks = buildBlocksForLevel(levelIndex);
      paddle.x = (CANVAS_W - PADDLE_W) / 2;
      phase = 'playing';
      resetBallOnPaddle();
      updateHud();
    }

    function levelClear() {
      score += levelClearBonus(levelIndex);
      updateHud();
      if (levelIndex >= LEVEL_DEFS.length - 1) {
        phase = 'cleared';
        clearLaunchTimeout();
        submitFinalScore();
        showOverlay('All Clear!', 'Score: ' + score + '  (' + difficulty + ')', [
          { label: 'Retry (' + difficulty + ')', onClick: restartGame },
          { label: 'Difficulty', onClick: backToDifficultySelect },
          { label: 'Menu', onClick: backToMenu }
        ]);
      } else {
        phase = 'levelclear';
        clearLaunchTimeout();
        showOverlay('Level ' + (levelIndex + 1) + ' Clear!', 'Score: ' + score, [
          { label: 'Next Level', onClick: proceedToNextLevel },
          { label: 'Menu', onClick: backToMenu }
        ]);
      }
    }

    function restartGame() {
      // 同じ難易度でやり直し（ライフも難易度基準に戻す）
      levelIndex = 0;
      score = 0;
      lives = livesForDifficulty(difficulty);
      blocks = buildBlocksForLevel(levelIndex);
      paddle.x = (CANVAS_W - PADDLE_W) / 2;
      phase = 'playing';
      paused = false;
      hideOverlay();
      resetBallOnPaddle();
      updateHud();
    }

    function togglePause() {
      if (phase !== 'playing') return;
      paused = !paused;
      if (paused) {
        showOverlay('Pause', '', [
          { label: 'Resume', onClick: togglePause },
          { label: 'Menu', onClick: backToMenu }
        ]);
      } else {
        hideOverlay();
      }
      pauseBtn.textContent = paused ? 'Resume (Esc)' : 'Pause (Esc)';
    }

    // ---- 入力 ------------------------------------------------------------
    var paddleKeySpeed = 420; // px/sec

    function onKeyDown(e) {
      if (e.key === 'ArrowLeft' || e.key === 'Left') { leftPressed = true; e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'Right') { rightPressed = true; e.preventDefault(); }
      else if (e.key === 'Escape' || e.key === 'Esc') { togglePause(); }
      else if (e.key === ' ' || e.key === 'Spacebar') { launchBall(); e.preventDefault(); }
    }
    function onKeyUp(e) {
      if (e.key === 'ArrowLeft' || e.key === 'Left') leftPressed = false;
      else if (e.key === 'ArrowRight' || e.key === 'Right') rightPressed = false;
    }
    function onMouseMove(e) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = CANVAS_W / rect.width;
      var relX = (e.clientX - rect.left) * scaleX;
      paddle.x = clampPaddleX(relX - paddle.w / 2, paddle.w, CANVAS_W);
    }
    function onCanvasClick() {
      launchBall();
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('click', onCanvasClick);
    pauseBtn.addEventListener('click', togglePause);
    menuBtn.addEventListener('click', backToMenu);

    // ---- 更新 / 描画 -------------------------------------------------------
    function update(dt) {
      if (leftPressed) paddle.x -= paddleKeySpeed * dt;
      if (rightPressed) paddle.x += paddleKeySpeed * dt;
      paddle.x = clampPaddleX(paddle.x, paddle.w, CANVAS_W);

      if (waitingLaunch) {
        ball.x = paddle.x + paddle.w / 2;
        ball.y = paddle.y - BALL_R - 1;
        return;
      }

      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      // 壁反射
      if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
      else if (ball.x + ball.r > CANVAS_W) { ball.x = CANVAS_W - ball.r; ball.vx = -Math.abs(ball.vx); }
      if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); }

      // パドル反射（下向きに移動中のみ）
      if (ball.vy > 0 && circleRectIntersect(ball.x, ball.y, ball.r, paddle.x, paddle.y, paddle.w, paddle.h)) {
        var offset = (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2);
        var speed = ballSpeedForLevel(levelIndex, difficulty);
        var v = paddleBounceVelocity(offset, speed);
        ball.vx = v.vx;
        ball.vy = v.vy;
        ball.y = paddle.y - ball.r - 0.5;
      }

      // ブロック衝突（1フレームにつき1個まで処理）
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (!b.alive) continue;
        if (circleRectIntersect(ball.x, ball.y, ball.r, b.x, b.y, b.w, b.h)) {
          var refl = resolveBlockCollision(ball, b);
          ball.vx = refl.vx;
          ball.vy = refl.vy;
          b.hp -= 1;
          score += HIT_POINTS;
          if (b.hp <= 0) {
            b.alive = false;
            score += computeBlockScore(b);
          }
          updateHud();
          break;
        }
      }

      // 落下判定
      if (ball.y - ball.r > CANVAS_H) {
        lives -= 1;
        updateHud();
        if (lives <= 0) {
          gameOver();
          return;
        }
        resetBallOnPaddle();
        return;
      }

      if (allBlocksDestroyed(blocks)) {
        levelClear();
      }
    }

    function draw() {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      // ブロック
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (!b.alive) continue;
        ctx.fillStyle = b.maxHp >= 2 ? (b.hp >= 2 ? '#ff8a5f' : '#ffcf5f') : '#5fd0ff';
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }

      // パドル
      ctx.fillStyle = '#e8ecf4';
      ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);

      // ボール
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    function loop(ts) {
      if (destroyed) return;
      if (lastTs === null) lastTs = ts;
      var dt = Math.min((ts - lastTs) / 1000, 0.033);
      lastTs = ts;

      if (phase === 'playing' && !paused) {
        update(dt);
      }
      draw();

      rafId = root.requestAnimationFrame(loop);
    }

    // ---- 初期化 ------------------------------------------------------------
    resetBallOnPaddle();
    updateHud();
    rafId = root.requestAnimationFrame(loop);

    function teardown() {
      destroyed = true;
      if (rafId !== null) root.cancelAnimationFrame(rafId);
      clearLaunchTimeout();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('click', onCanvasClick);
      pauseBtn.removeEventListener('click', togglePause);
      menuBtn.removeEventListener('click', backToMenu);
    }

    return teardown;
  }

  // 現在マウントされているもの（難易度選択画面 or ゲーム）を破棄する
  function teardownActive() {
    if (activeTeardown) {
      try { activeTeardown(); } catch (e) { /* noop */ }
      activeTeardown = null;
    }
  }

  /**
   * 難易度選択画面を描画する。ボタン選択でゲーム開始。
   * 各難易度ボタンにはその難易度のハイスコアを併記する。
   * この画面には rAF もタイマーもグローバルリスナも無いため teardown は要素破棄で足りるが、
   * 再入場時の整合のため活性 teardown として空関数を登録しておく。
   */
  function showDifficultySelect(container) {
    teardownActive();

    var btnStyle = 'display:flex;flex-direction:column;gap:4px;align-items:flex-start;' +
      'padding:14px 18px;min-width:220px;font-size:1.05rem;';

    function diffMeta(d) {
      var cfg = DIFFICULTY_CONFIG[d];
      var hs = null;
      try { hs = root.Arcade ? root.Arcade.getHighScore('breakout', d) : null; } catch (e) { hs = null; }
      var hsText = (hs === null || hs === undefined) ? '-' : String(hs);
      return { cfg: cfg, hsText: hsText };
    }

    var rows = DIFFICULTIES.map(function (d) {
      var m = diffMeta(d);
      var isDefault = (d === DEFAULT_DIFFICULTY);
      return '<button type="button" class="t2bo-diff-btn" data-diff="' + d + '" style="' + btnStyle +
        (isDefault ? 'border-color:#5fd0ff;' : '') + '">' +
        '<span style="font-weight:bold;text-transform:capitalize;">' + d + (isDefault ? ' (default)' : '') + '</span>' +
        '<span style="color:#8a93a6;font-size:0.85rem;">ボール速度 x' + m.cfg.speedMul + ' / ライフ ' + m.cfg.lives +
        ' / High: ' + m.hsText + '</span>' +
        '</button>';
    }).join('');

    container.innerHTML =
      '<div class="t2bo-select" style="display:flex;flex-direction:column;align-items:center;gap:16px;' +
        'font-family:inherit;color:#e8ecf4;padding:24px 0;">' +
        '<h2 style="margin:0;">Breakout</h2>' +
        '<p style="margin:0;color:#8a93a6;">難易度を選択してください</p>' +
        '<div style="display:flex;flex-direction:column;gap:12px;">' + rows + '</div>' +
        '<button type="button" id="t2bo-select-menu-btn" style="margin-top:8px;">Menu</button>' +
      '</div>';

    var diffButtons = Array.prototype.slice.call(container.querySelectorAll('.t2bo-diff-btn'));
    var selectMenuBtn = container.querySelector('#t2bo-select-menu-btn');

    var handlers = [];
    diffButtons.forEach(function (btn) {
      var h = function () { startGame(container, btn.getAttribute('data-diff')); };
      btn.addEventListener('click', h);
      handlers.push({ el: btn, fn: h });
    });
    var menuH = function () { root.Arcade.showScreen('menu'); };
    selectMenuBtn.addEventListener('click', menuH);
    handlers.push({ el: selectMenuBtn, fn: menuH });

    activeTeardown = function () {
      handlers.forEach(function (h) { h.el.removeEventListener('click', h.fn); });
      handlers = [];
    };
  }

  function startGame(container, difficulty) {
    teardownActive();
    activeTeardown = createGame(container, difficulty);
  }

  var Breakout = {
    onEnter: function (container) {
      // 再入場時に前のインスタンス（ゲーム or 選択画面）を必ず破棄してから
      // 難易度選択画面から開始する（再入場対応）。
      teardownActive();
      showDifficultySelect(container);
    },
    onExit: function () {
      teardownActive();
    }
  };

  root.Breakout = Breakout;
})(typeof window !== 'undefined' ? window : globalThis);
