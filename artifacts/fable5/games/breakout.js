/**
 * T2: Breakout (games/breakout.js)
 *
 * Structure:
 *  - `BreakoutLogic`: pure, DOM-free game logic (level data, collision/
 *    reflection math, scoring, and a single `stepGame(state, dt, input)`
 *    reducer). Exposed on the global object and via `module.exports` so
 *    tests/breakout.test.html (browser) and a plain Node script can both
 *    exercise it without a DOM.
 *  - Screen wiring: builds the canvas + HUD inside the container handed to
 *    mount(), drives a requestAnimationFrame loop that calls
 *    BreakoutLogic.stepGame() every frame, and renders the resulting state.
 *
 * This file must not throw when loaded outside the arcade shell (e.g. from
 * the test page), so the Arcade.registerScreen() call is guarded.
 */
(function (root) {
  'use strict';

  // ===== Config constants ==================================================

  var CANVAS_WIDTH = 480;
  var CANVAS_HEIGHT = 560;
  var PADDLE_WIDTH = 84;
  var PADDLE_HEIGHT = 12;
  var PADDLE_Y = CANVAS_HEIGHT - 34;
  var PADDLE_SPEED = 380; // px/sec, keyboard control
  var BALL_RADIUS = 7;
  var BASE_BALL_SPEED = 240; // px/sec at level 0
  var BALL_SPEED_PER_LEVEL = 25;
  var MAX_BOUNCE_ANGLE = Math.PI / 3; // 60 degrees, at the paddle edges
  var BRICK_COLS = 8;
  var BRICK_HEIGHT = 20;
  var BRICK_TOP = 54;
  var BRICK_GAP = 4;
  var BRICK_SIDE_MARGIN = 12;
  var LIVES_START = 3;

  // Difficulty tuning. Each preset sets starting lives and a ball-speed
  // multiplier applied on top of the per-level base speed.
  var DIFFICULTY_SETTINGS = {
    easy:   { lives: 5, speedMultiplier: 0.8 },
    normal: { lives: 3, speedMultiplier: 1.0 },
    hard:   { lives: 2, speedMultiplier: 1.3 }
  };
  var DIFFICULTY_ORDER = ['easy', 'normal', 'hard'];
  var DEFAULT_DIFFICULTY = 'normal';

  function difficultyConfig(difficulty) {
    return DIFFICULTY_SETTINGS[difficulty] ? difficulty : DEFAULT_DIFFICULTY;
  }

  // Three levels with different layouts (also different total brick counts).
  var LEVELS = [
    { rows: ['11111111', '11111111', '11111111', '11111111', '11111111'] },
    { rows: ['00111100', '01111110', '11111111', '11111111', '01111110', '00111100'] },
    { rows: ['10101010', '01010101', '10101010', '01010101', '10101010', '01010101'] }
  ];

  // ===== Pure logic ========================================================

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function computeBrickWidth() {
    return (CANVAS_WIDTH - BRICK_SIDE_MARGIN * 2 - BRICK_GAP * (BRICK_COLS - 1)) / BRICK_COLS;
  }

  function computeBrickPoints(rowIndex, levelIndex) {
    return 10 + rowIndex * 5 + levelIndex * 5;
  }

  function computeLevelClearBonus(levelIndex, livesRemaining) {
    return 100 * (levelIndex + 1) + livesRemaining * 20;
  }

  function buildBricks(levelIndex) {
    var level = LEVELS[clamp(levelIndex, 0, LEVELS.length - 1)];
    var brickWidth = computeBrickWidth();
    var bricks = [];
    level.rows.forEach(function (rowStr, rowIndex) {
      for (var col = 0; col < rowStr.length; col++) {
        if (rowStr.charAt(col) === '1') {
          bricks.push({
            row: rowIndex,
            col: col,
            x: BRICK_SIDE_MARGIN + col * (brickWidth + BRICK_GAP),
            y: BRICK_TOP + rowIndex * (BRICK_HEIGHT + BRICK_GAP),
            w: brickWidth,
            h: BRICK_HEIGHT,
            alive: true,
            points: computeBrickPoints(rowIndex, levelIndex)
          });
        }
      }
    });
    return bricks;
  }

  function countAliveBricks(bricks) {
    var n = 0;
    for (var i = 0; i < bricks.length; i++) {
      if (bricks[i].alive) n++;
    }
    return n;
  }

  function ballSpeedForLevel(levelIndex, speedMultiplier) {
    var mult = typeof speedMultiplier === 'number' ? speedMultiplier : 1;
    return (BASE_BALL_SPEED + levelIndex * BALL_SPEED_PER_LEVEL) * mult;
  }

  // Angle-based paddle reflection: hitting dead center sends the ball
  // straight up; hitting near an edge sends it out at up to MAX_BOUNCE_ANGLE.
  function reflectOffPaddle(ballX, paddleX, paddleWidth, speed, maxAngle) {
    maxAngle = typeof maxAngle === 'number' ? maxAngle : MAX_BOUNCE_ANGLE;
    var paddleCenter = paddleX + paddleWidth / 2;
    var rel = paddleWidth > 0 ? (ballX - paddleCenter) / (paddleWidth / 2) : 0;
    rel = clamp(rel, -1, 1);
    var angle = rel * maxAngle;
    return {
      vx: speed * Math.sin(angle),
      vy: -Math.abs(speed * Math.cos(angle))
    };
  }

  // Circle (ball) vs axis-aligned rect collision via closest-point test.
  function circleRectCollision(cx, cy, r, rx, ry, rw, rh) {
    var closestX = clamp(cx, rx, rx + rw);
    var closestY = clamp(cy, ry, ry + rh);
    var dx = cx - closestX;
    var dy = cy - closestY;
    return dx * dx + dy * dy <= r * r;
  }

  // Decide which axis to flip when a ball hits a brick: whichever axis has
  // the larger penetration relative to the rect's closest point wins.
  function resolveBrickBounce(ball, brick) {
    var closestX = clamp(ball.x, brick.x, brick.x + brick.w);
    var closestY = clamp(ball.y, brick.y, brick.y + brick.h);
    var dx = ball.x - closestX;
    var dy = ball.y - closestY;
    if (Math.abs(dx) > Math.abs(dy)) {
      return { vx: -ball.vx, vy: ball.vy };
    }
    return { vx: ball.vx, vy: -ball.vy };
  }

  function resetBall(state) {
    var speed = ballSpeedForLevel(state.level, state.speedMultiplier);
    state.ball = {
      x: CANVAS_WIDTH / 2,
      y: PADDLE_Y - BALL_RADIUS - 1,
      radius: BALL_RADIUS,
      vx: 0,
      vy: -speed
    };
  }

  function createInitialState(difficulty) {
    var diff = difficultyConfig(difficulty);
    var settings = DIFFICULTY_SETTINGS[diff];
    var state = {
      difficulty: diff,
      speedMultiplier: settings.speedMultiplier,
      level: 0,
      score: 0,
      lives: settings.lives,
      status: 'playing', // 'playing' | 'paused' | 'gameover' | 'allclear'
      paddleWidth: PADDLE_WIDTH,
      paddleX: (CANVAS_WIDTH - PADDLE_WIDTH) / 2,
      bricks: buildBricks(0),
      ball: null
    };
    resetBall(state);
    return state;
  }

  /**
   * Advance the game by `dt` seconds given `input`:
   *   input.mouseX  - absolute paddle-center target in canvas px (mouse control)
   *   input.keyDir  - -1 / 0 / 1 (keyboard control), used when mouseX absent
   * Mutates and returns `state`, plus a list of event name strings that
   * occurred this frame (e.g. 'paddleHit', 'brickDestroyed', 'lifeLost',
   * 'gameOver', 'levelBonus', 'nextLevel', 'allClear'). No DOM access here.
   */
  function stepGame(state, dt, input) {
    var events = [];
    if (state.status !== 'playing') {
      return { state: state, events: events };
    }
    input = input || {};

    // --- paddle ---
    var paddleX = state.paddleX;
    if (typeof input.mouseX === 'number') {
      paddleX = input.mouseX - state.paddleWidth / 2;
    } else if (input.keyDir) {
      paddleX += input.keyDir * PADDLE_SPEED * dt;
    }
    state.paddleX = clamp(paddleX, 0, CANVAS_WIDTH - state.paddleWidth);

    // --- ball motion ---
    var ball = state.ball;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // walls
    if (ball.x - ball.radius <= 0) {
      ball.x = ball.radius;
      ball.vx = Math.abs(ball.vx);
      events.push('wallBounce');
    } else if (ball.x + ball.radius >= CANVAS_WIDTH) {
      ball.x = CANVAS_WIDTH - ball.radius;
      ball.vx = -Math.abs(ball.vx);
      events.push('wallBounce');
    }
    if (ball.y - ball.radius <= 0) {
      ball.y = ball.radius;
      ball.vy = Math.abs(ball.vy);
      events.push('wallBounce');
    }

    // paddle (only relevant while ball travels downward)
    if (
      ball.vy > 0 &&
      circleRectCollision(ball.x, ball.y, ball.radius, state.paddleX, PADDLE_Y, state.paddleWidth, PADDLE_HEIGHT)
    ) {
      var speed = ballSpeedForLevel(state.level, state.speedMultiplier);
      var bounced = reflectOffPaddle(ball.x, state.paddleX, state.paddleWidth, speed);
      ball.vx = bounced.vx;
      ball.vy = bounced.vy;
      ball.y = PADDLE_Y - ball.radius;
      events.push('paddleHit');
    }

    // bricks (resolve at most one per frame to keep physics simple/stable)
    for (var i = 0; i < state.bricks.length; i++) {
      var brick = state.bricks[i];
      if (!brick.alive) continue;
      if (circleRectCollision(ball.x, ball.y, ball.radius, brick.x, brick.y, brick.w, brick.h)) {
        var reflected = resolveBrickBounce(ball, brick);
        ball.vx = reflected.vx;
        ball.vy = reflected.vy;
        brick.alive = false;
        state.score += brick.points;
        events.push('brickDestroyed');
        break;
      }
    }

    // dropped below the paddle
    if (ball.y - ball.radius > CANVAS_HEIGHT) {
      state.lives -= 1;
      events.push('lifeLost');
      if (state.lives <= 0) {
        state.status = 'gameover';
        events.push('gameOver');
      } else {
        resetBall(state);
      }
    }

    // level clear check
    if (state.status === 'playing' && countAliveBricks(state.bricks) === 0) {
      var bonus = computeLevelClearBonus(state.level, state.lives);
      state.score += bonus;
      events.push('levelBonus');
      if (state.level >= LEVELS.length - 1) {
        state.status = 'allclear';
        events.push('allClear');
      } else {
        state.level += 1;
        state.bricks = buildBricks(state.level);
        resetBall(state);
        events.push('nextLevel');
      }
    }

    return { state: state, events: events };
  }

  var BreakoutLogic = {
    CANVAS_WIDTH: CANVAS_WIDTH,
    CANVAS_HEIGHT: CANVAS_HEIGHT,
    PADDLE_WIDTH: PADDLE_WIDTH,
    PADDLE_HEIGHT: PADDLE_HEIGHT,
    PADDLE_Y: PADDLE_Y,
    PADDLE_SPEED: PADDLE_SPEED,
    BALL_RADIUS: BALL_RADIUS,
    LIVES_START: LIVES_START,
    MAX_BOUNCE_ANGLE: MAX_BOUNCE_ANGLE,
    LEVELS: LEVELS,
    DIFFICULTY_SETTINGS: DIFFICULTY_SETTINGS,
    DIFFICULTY_ORDER: DIFFICULTY_ORDER,
    DEFAULT_DIFFICULTY: DEFAULT_DIFFICULTY,
    difficultyConfig: difficultyConfig,
    clamp: clamp,
    buildBricks: buildBricks,
    computeBrickPoints: computeBrickPoints,
    computeLevelClearBonus: computeLevelClearBonus,
    countAliveBricks: countAliveBricks,
    ballSpeedForLevel: ballSpeedForLevel,
    reflectOffPaddle: reflectOffPaddle,
    circleRectCollision: circleRectCollision,
    resolveBrickBounce: resolveBrickBounce,
    createInitialState: createInitialState,
    stepGame: stepGame
  };

  root.BreakoutLogic = BreakoutLogic;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BreakoutLogic;
  }

  // ===== Screen (DOM/canvas) layer ========================================
  // Everything below only runs once mount() is actually invoked by the
  // arcade shell, so referencing `document`/canvas APIs at module scope is
  // safe even in environments without a DOM (e.g. plain Node `require`).

  function createBreakoutScreen() {
    var mounted = false;
    var rafId = null;
    var lastTime = null;

    var container = null;
    var canvas = null;
    var ctx = null;
    var scoreEl = null;
    var livesEl = null;
    var levelEl = null;
    var difficultyEl = null;
    var pauseBtn = null;
    var overlayEl = null;
    var overlayTitleEl = null;
    var overlaySubEl = null;
    var retryBtn = null;
    var changeDiffBtn = null;
    var menuBtn = null;
    var selectOverlayEl = null;
    var diffButtons = []; // { el, value, onClick }

    var state = null;
    var selectedDifficulty = DEFAULT_DIFFICULTY;
    var keyState = { left: false, right: false };
    var lastInputMethod = null; // 'mouse' | 'key'
    var mouseX = null;
    var scoreSubmittedForRun = false;

    // Read the available difficulties from core (v2) with a typeof guard,
    // falling back to the logic module's own order when Arcade is absent
    // (e.g. the test page) or older.
    function getDifficulties() {
      if (
        root_global.Arcade &&
        Array.isArray(root_global.Arcade.DIFFICULTIES) &&
        root_global.Arcade.DIFFICULTIES.length > 0
      ) {
        return root_global.Arcade.DIFFICULTIES;
      }
      return DIFFICULTY_ORDER;
    }

    function difficultyLabel(value) {
      var s = DIFFICULTY_SETTINGS[value];
      var name = value.charAt(0).toUpperCase() + value.slice(1);
      if (!s) return name;
      return name + '  (ライフ ' + s.lives + ' / 速度 x' + s.speedMultiplier + ')';
    }

    function applyStyle(el, styles) {
      for (var key in styles) {
        if (Object.prototype.hasOwnProperty.call(styles, key)) {
          el.style[key] = styles[key];
        }
      }
      return el;
    }

    function el(tag, styles, text) {
      var e = document.createElement(tag);
      if (styles) applyStyle(e, styles);
      if (typeof text === 'string') e.textContent = text;
      return e;
    }

    function buildDom(mountContainer) {
      container = mountContainer;
      container.innerHTML = '';

      var root = el('div', { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' });

      var hud = el('div', {
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        flexWrap: 'wrap',
        fontVariantNumeric: 'tabular-nums'
      });
      scoreEl = el('span', {}, 'Score: 0');
      livesEl = el('span', {}, 'Lives: ' + LIVES_START);
      levelEl = el('span', {}, 'Level 1/' + LEVELS.length);
      difficultyEl = el('span', { color: '#9096a8' }, 'Difficulty: ' + selectedDifficulty);
      pauseBtn = el('button', {
        marginLeft: 'auto',
        border: '1px solid #2c3040',
        background: '#1a1d29',
        color: '#e7e9f0',
        borderRadius: '8px',
        padding: '6px 12px',
        cursor: 'pointer',
        fontFamily: 'inherit'
      }, '一時停止');
      pauseBtn.type = 'button';
      hud.appendChild(scoreEl);
      hud.appendChild(livesEl);
      hud.appendChild(levelEl);
      hud.appendChild(difficultyEl);
      hud.appendChild(pauseBtn);

      var canvasWrap = el('div', {
        position: 'relative',
        width: '100%',
        maxWidth: CANVAS_WIDTH + 'px',
        margin: '0 auto'
      });

      canvas = document.createElement('canvas');
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      applyStyle(canvas, {
        display: 'block',
        width: '100%',
        height: 'auto',
        background: '#0d0f16',
        borderRadius: '8px',
        touchAction: 'none'
      });
      ctx = canvas.getContext('2d');

      overlayEl = el('div', {
        position: 'absolute',
        inset: '0',
        display: 'none',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        background: 'rgba(10,12,20,0.82)',
        borderRadius: '8px',
        textAlign: 'center',
        padding: '16px'
      });
      overlayTitleEl = el('div', { fontSize: '1.4rem', fontWeight: '700' }, '');
      overlaySubEl = el('div', { color: '#9096a8', fontSize: '0.9rem' }, '');
      retryBtn = el('button', {
        border: '1px solid #2c3040',
        background: '#5b8cff',
        color: '#fff',
        borderRadius: '8px',
        padding: '10px 18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: '600'
      }, 'もう一度プレイ');
      retryBtn.type = 'button';
      changeDiffBtn = el('button', {
        border: '1px solid #2c3040',
        background: 'transparent',
        color: '#e7e9f0',
        borderRadius: '8px',
        padding: '10px 18px',
        cursor: 'pointer',
        fontFamily: 'inherit'
      }, '難易度を変更');
      changeDiffBtn.type = 'button';
      menuBtn = el('button', {
        border: '1px solid #2c3040',
        background: 'transparent',
        color: '#e7e9f0',
        borderRadius: '8px',
        padding: '10px 18px',
        cursor: 'pointer',
        fontFamily: 'inherit'
      }, 'メニューに戻る');
      menuBtn.type = 'button';
      overlayEl.appendChild(overlayTitleEl);
      overlayEl.appendChild(overlaySubEl);
      overlayEl.appendChild(retryBtn);
      overlayEl.appendChild(changeDiffBtn);
      overlayEl.appendChild(menuBtn);

      // Difficulty-select overlay (shown before the game starts, and again
      // whenever the player chooses to change difficulty).
      selectOverlayEl = el('div', {
        position: 'absolute',
        inset: '0',
        display: 'none',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        background: 'rgba(10,12,20,0.92)',
        borderRadius: '8px',
        textAlign: 'center',
        padding: '16px'
      });
      selectOverlayEl.appendChild(el('div', { fontSize: '1.3rem', fontWeight: '700' }, '難易度を選択'));
      diffButtons = [];
      getDifficulties().forEach(function (value) {
        var btn = el('button', {
          minWidth: '260px',
          border: '1px solid #2c3040',
          background: '#1a1d29',
          color: '#e7e9f0',
          borderRadius: '8px',
          padding: '10px 18px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontWeight: '600'
        }, difficultyLabel(value));
        btn.type = 'button';
        var handler = (function (v) {
          return function () { startGame(v); };
        })(value);
        btn.addEventListener('click', handler);
        selectOverlayEl.appendChild(btn);
        diffButtons.push({ el: btn, value: value, onClick: handler });
      });

      canvasWrap.appendChild(canvas);
      canvasWrap.appendChild(overlayEl);
      canvasWrap.appendChild(selectOverlayEl);

      var hint = el('div', { color: '#9096a8', fontSize: '0.85rem' },
        '難易度を選んで開始。←→ キー またはマウスでパドルを操作。Esc で一時停止。');

      root.appendChild(hud);
      root.appendChild(canvasWrap);
      root.appendChild(hint);
      container.appendChild(root);
    }

    function submitScoreSafe(score) {
      if (scoreSubmittedForRun) return;
      if (root_global.Arcade && typeof root_global.Arcade.submitScore === 'function') {
        // core v2: pass the selected difficulty so scores are bucketed per
        // difficulty. The stored difficulty on state is the source of truth.
        root_global.Arcade.submitScore('breakout', score, state ? state.difficulty : selectedDifficulty);
      }
      scoreSubmittedForRun = true;
    }

    function updateHud() {
      if (!state) return;
      scoreEl.textContent = 'Score: ' + state.score;
      livesEl.textContent = 'Lives: ' + Math.max(0, state.lives);
      levelEl.textContent = 'Level ' + (state.level + 1) + '/' + LEVELS.length;
      difficultyEl.textContent = 'Difficulty: ' + state.difficulty;
    }

    function updateOverlay() {
      if (!state) return;
      if (state.status === 'gameover' || state.status === 'allclear') {
        overlayEl.style.display = 'flex';
        overlayTitleEl.textContent = state.status === 'allclear' ? 'ALL CLEAR!' : 'GAME OVER';
        overlaySubEl.textContent = 'Score: ' + state.score + '  (' + state.difficulty + ')';
        retryBtn.style.display = '';
        changeDiffBtn.style.display = '';
        menuBtn.style.display = '';
        pauseBtn.disabled = true;
      } else if (state.status === 'paused') {
        overlayEl.style.display = 'flex';
        overlayTitleEl.textContent = 'PAUSED';
        overlaySubEl.textContent = 'Esc またはボタンで再開';
        retryBtn.style.display = 'none';
        changeDiffBtn.style.display = 'none';
        menuBtn.style.display = 'none';
        pauseBtn.disabled = false;
        pauseBtn.textContent = '再開';
      } else {
        overlayEl.style.display = 'none';
        pauseBtn.disabled = false;
        pauseBtn.textContent = '一時停止';
      }
    }

    function togglePause() {
      if (!state) return;
      // Ignore pause while the difficulty-select screen is up.
      if (selectOverlayEl && selectOverlayEl.style.display !== 'none') return;
      if (state.status === 'playing') {
        state.status = 'paused';
      } else if (state.status === 'paused') {
        state.status = 'playing';
      } else {
        return;
      }
      updateOverlay();
    }

    // Show the difficulty-select screen; the game is not running until a
    // difficulty is chosen via startGame().
    function showDifficultySelect() {
      overlayEl.style.display = 'none';
      selectOverlayEl.style.display = 'flex';
      pauseBtn.disabled = true;
      diffButtons.forEach(function (b) {
        b.el.style.borderColor = b.value === selectedDifficulty ? '#5b8cff' : '#2c3040';
        b.el.style.background = b.value === selectedDifficulty ? '#243154' : '#1a1d29';
      });
    }

    function startGame(difficulty) {
      selectedDifficulty = difficultyConfig(difficulty);
      selectOverlayEl.style.display = 'none';
      resetGame();
    }

    function resetGame() {
      state = createInitialState(selectedDifficulty);
      scoreSubmittedForRun = false;
      lastTime = null;
      keyState.left = false;
      keyState.right = false;
      updateHud();
      updateOverlay();
    }

    function draw() {
      if (!ctx || !state) return;
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.fillStyle = '#0d0f16';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      var rowColors = ['#ff6b6b', '#ffb86b', '#ffe66b', '#8bff6b', '#6bd4ff', '#a06bff'];
      for (var i = 0; i < state.bricks.length; i++) {
        var b = state.bricks[i];
        if (!b.alive) continue;
        ctx.fillStyle = rowColors[b.row % rowColors.length];
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }

      ctx.fillStyle = '#5b8cff';
      ctx.fillRect(state.paddleX, PADDLE_Y, state.paddleWidth, PADDLE_HEIGHT);

      ctx.beginPath();
      ctx.fillStyle = '#e7e9f0';
      ctx.arc(state.ball.x, state.ball.y, state.ball.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    function onKeyDown(e) {
      if (!mounted) return;
      if (e.key === 'ArrowLeft') {
        keyState.left = true;
        lastInputMethod = 'key';
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        keyState.right = true;
        lastInputMethod = 'key';
        e.preventDefault();
      } else if (e.key === 'Escape') {
        togglePause();
      }
    }

    function onKeyUp(e) {
      if (e.key === 'ArrowLeft') keyState.left = false;
      else if (e.key === 'ArrowRight') keyState.right = false;
    }

    function onMouseMove(e) {
      if (!canvas) return;
      var rect = canvas.getBoundingClientRect();
      var scaleX = rect.width > 0 ? CANVAS_WIDTH / rect.width : 1;
      mouseX = (e.clientX - rect.left) * scaleX;
      lastInputMethod = 'mouse';
    }

    function onPauseClick() {
      togglePause();
    }

    function onRetryClick() {
      // Retry with the SAME difficulty.
      resetGame();
    }

    function onChangeDiffClick() {
      showDifficultySelect();
    }

    function onMenuClick() {
      var backBtn = document.getElementById('back-to-menu-btn');
      if (backBtn) backBtn.click();
    }

    function frame(timestamp) {
      if (!mounted) return;
      // Not started yet (difficulty select showing) or between screens: keep
      // the loop alive but don't advance simulation.
      if (!state || (selectOverlayEl && selectOverlayEl.style.display !== 'none')) {
        rafId = root_global.requestAnimationFrame(frame);
        return;
      }
      if (lastTime === null) lastTime = timestamp;
      var dt = Math.min(0.05, Math.max(0, (timestamp - lastTime) / 1000));
      lastTime = timestamp;

      var input = {};
      if (lastInputMethod === 'mouse' && mouseX !== null) {
        input.mouseX = mouseX;
      } else {
        var dir = 0;
        if (keyState.left && !keyState.right) dir = -1;
        else if (keyState.right && !keyState.left) dir = 1;
        input.keyDir = dir;
      }

      var result = stepGame(state, dt, input);
      state = result.state;

      if (result.events.indexOf('gameOver') !== -1 || result.events.indexOf('allClear') !== -1) {
        submitScoreSafe(state.score);
        updateOverlay();
      }

      updateHud();
      draw();

      rafId = root_global.requestAnimationFrame(frame);
    }

    function mount(mountContainer) {
      mounted = true;
      lastTime = null;
      selectedDifficulty = DEFAULT_DIFFICULTY;
      buildDom(mountContainer);
      // Prime a state so the canvas has something to draw behind the select
      // overlay, but keep the game paused on the difficulty-select screen.
      state = createInitialState(selectedDifficulty);
      scoreSubmittedForRun = false;
      updateHud();
      showDifficultySelect();

      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('mousemove', onMouseMove);
      pauseBtn.addEventListener('click', onPauseClick);
      retryBtn.addEventListener('click', onRetryClick);
      changeDiffBtn.addEventListener('click', onChangeDiffClick);
      menuBtn.addEventListener('click', onMenuClick);

      draw();
      rafId = root_global.requestAnimationFrame(frame);
    }

    function unmount() {
      mounted = false;
      if (rafId !== null) {
        root_global.cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      if (canvas) canvas.removeEventListener('mousemove', onMouseMove);
      if (pauseBtn) pauseBtn.removeEventListener('click', onPauseClick);
      if (retryBtn) retryBtn.removeEventListener('click', onRetryClick);
      if (changeDiffBtn) changeDiffBtn.removeEventListener('click', onChangeDiffClick);
      if (menuBtn) menuBtn.removeEventListener('click', onMenuClick);
      diffButtons.forEach(function (b) {
        b.el.removeEventListener('click', b.onClick);
      });
      diffButtons = [];

      canvas = null;
      ctx = null;
      scoreEl = null;
      livesEl = null;
      levelEl = null;
      difficultyEl = null;
      pauseBtn = null;
      overlayEl = null;
      overlayTitleEl = null;
      overlaySubEl = null;
      retryBtn = null;
      changeDiffBtn = null;
      menuBtn = null;
      selectOverlayEl = null;
      container = null;
      state = null;
      keyState = { left: false, right: false };
      lastInputMethod = null;
      mouseX = null;
    }

    return { id: 'breakout', title: 'Breakout', mount: mount, unmount: unmount };
  }

  // `root` here is the same global (window / globalThis) core.js attaches
  // Arcade to; keep a stable reference for the closures above.
  var root_global = root;

  if (
    typeof root_global !== 'undefined' &&
    root_global &&
    root_global.Arcade &&
    typeof root_global.Arcade.registerScreen === 'function' &&
    typeof root_global.document !== 'undefined'
  ) {
    root_global.Arcade.registerScreen(createBreakoutScreen());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
