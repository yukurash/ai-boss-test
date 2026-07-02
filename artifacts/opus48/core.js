/**
 * core.js — Mini Game Arcade 共通シェル + 状態管理 (T1) — v2 (難易度対応)
 *
 * 公開グローバル: window.Arcade
 *
 * 保存仕様 (v2):
 *   - localStorage キーは "arcade.save" のみを使用する（v1 から不変）。
 *   - 形式は難易度別ネストのオブジェクトマップ:
 *       {
 *         "<gameId>": {
 *           "easy":   { "highScore": number|null, "plays": number },
 *           "normal": { "highScore": number|null, "plays": number },
 *           "hard":   { "highScore": number|null, "plays": number }
 *         }
 *       }
 *     未プレイの難易度バケットは省略可（未存在なら highScore=null, plays=0 扱い）。
 *   - 破損データ / 未保存時は空オブジェクト {} から開始し、例外は投げない。
 *
 * マイグレーション:
 *   - ロード時に旧フラット形式 { "<gameId>": { "highScore", "plays" } } を検出したら、
 *     その値を normal バケットへ移送し新形式へ変換して localStorage に書き戻す。
 *   - 冪等（既に新形式なら変換しない・書き戻さない）。
 *
 * このファイルは Node.js からも読み込んで純粋ロジック（保存/読込/検証/マイグレーション）を
 * 単体テストできるように、DOM への参照は showScreen() 呼び出し時にのみ行う。
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'arcade.save';

  // PM 統合契約により厳密にこの配列内容とする
  var GAMES = [
    { id: 'breakout', name: 'Breakout' },
    { id: 'reflex', name: 'Reflex' }
  ];

  var DIFFICULTIES = ['easy', 'normal', 'hard'];
  var DEFAULT_DIFFICULTY = 'normal';

  function getLocalStorage() {
    // ブラウザでは root.localStorage、Node テストではスタブを root(=global) に注入して使う
    return root && root.localStorage ? root.localStorage : null;
  }

  function normalizeDifficulty(difficulty) {
    // 未知/未指定の難易度は normal にフォールバック（後方互換）
    return DIFFICULTIES.indexOf(difficulty) !== -1 ? difficulty : DEFAULT_DIFFICULTY;
  }

  // ---- 形式判定 --------------------------------------------------------

  // 難易度バケット: { highScore: number|null(有限), plays: number(有限) }
  function isDifficultyBucket(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var hs = v.highScore;
    if (!(hs === null || (typeof hs === 'number' && isFinite(hs)))) return false;
    if (typeof v.plays !== 'number' || !isFinite(v.plays)) return false;
    return true;
  }

  // 旧フラット形式のエントリ: { highScore: number(有限), plays: number(有限) }
  function isFlatEntry(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    return typeof v.highScore === 'number' && isFinite(v.highScore)
      && typeof v.plays === 'number' && isFinite(v.plays);
  }

  // 新ネスト形式のエントリ: キーは DIFFICULTIES のいずれかのみ、各値が有効なバケット。
  // 空オブジェクト {} も（全難易度未プレイの）有効なネストエントリとして扱う。
  function isNestedEntry(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) {
      if (DIFFICULTIES.indexOf(keys[i]) === -1) return false;
      if (!isDifficultyBucket(v[keys[i]])) return false;
    }
    return true;
  }

  function copyBucket(b) {
    return { highScore: (b.highScore === undefined ? null : b.highScore), plays: b.plays };
  }

  /**
   * 任意のマップを検証しつつ新ネスト形式へ変換する。
   * 各 gameId エントリを「旧フラット→normal へ移送」または「新ネスト→そのまま」に正規化する。
   * どちらでもないエントリが 1 つでもあれば {ok:false}。
   * 戻り値: { ok:boolean, state?:object, changed?:boolean }
   *   changed は旧フラットからの変換が発生したか（=書き戻しが必要か）を示す。
   */
  function migrateMap(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return { ok: false };
    var out = {};
    var changed = false;
    for (var gameId in map) {
      if (!Object.prototype.hasOwnProperty.call(map, gameId)) continue;
      var val = map[gameId];
      if (isFlatEntry(val)) {
        // 旧フラット形式 → normal バケットへ移送
        out[gameId] = { normal: { highScore: val.highScore, plays: val.plays } };
        changed = true;
      } else if (isNestedEntry(val)) {
        // 既に新形式 → バケットを複製して保持（冪等・変換なし）
        var entry = {};
        for (var i = 0; i < DIFFICULTIES.length; i++) {
          var d = DIFFICULTIES[i];
          if (val[d]) entry[d] = copyBucket(val[d]);
        }
        out[gameId] = entry;
      } else {
        return { ok: false };
      }
    }
    return { ok: true, state: out, changed: changed };
  }

  function loadState() {
    var storage = getLocalStorage();
    if (!storage) return {};
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      var result = migrateMap(parsed);
      if (!result.ok) return {}; // 破損/不正形式は空から開始
      if (result.changed) saveState(result.state); // 旧→新の書き戻し（冪等）
      return result.state;
    } catch (e) {
      // パース失敗等は空オブジェクトから開始（例外を投げない）
      return {};
    }
  }

  function saveState(state) {
    var storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // 書き込み失敗（容量超過等）は静かに無視し、アプリを落とさない
    }
  }

  /**
   * 指定難易度の highScore を（高い時のみ）更新し、その難易度の plays を必ず +1。
   * difficulty 省略時・未知値は normal 扱い（後方互換）。
   */
  function submitScore(gameId, score, difficulty) {
    if (typeof gameId !== 'string' || !gameId) {
      throw new TypeError('Arcade.submitScore: gameId must be a non-empty string');
    }
    var d = normalizeDifficulty(difficulty);
    var numScore = Number(score);
    if (!isFinite(numScore)) numScore = 0;

    var state = loadState();
    var entry = state[gameId];
    if (!entry || typeof entry !== 'object') entry = {};

    var bucket = entry[d];
    if (!bucket || typeof bucket !== 'object') bucket = { highScore: null, plays: 0 };

    if (bucket.highScore === null || bucket.highScore === undefined || numScore > bucket.highScore) {
      bucket.highScore = numScore;
    }
    bucket.plays = (typeof bucket.plays === 'number' && isFinite(bucket.plays) ? bucket.plays : 0) + 1;

    entry[d] = bucket;
    state[gameId] = entry;
    saveState(state);
    return { highScore: bucket.highScore, plays: bucket.plays };
  }

  function getHighScore(gameId, difficulty) {
    var d = normalizeDifficulty(difficulty);
    var state = loadState();
    var entry = state[gameId];
    if (!entry) return null;
    var bucket = entry[d];
    if (!bucket || typeof bucket.highScore !== 'number') return null;
    return bucket.highScore;
  }

  function getPlays(gameId, difficulty) {
    var d = normalizeDifficulty(difficulty);
    var state = loadState();
    var entry = state[gameId];
    if (!entry) return 0;
    var bucket = entry[d];
    if (!bucket || typeof bucket.plays !== 'number') return 0;
    return bucket.plays;
  }

  function getState() {
    // 呼び出し元による内部状態の意図しない書き換えを防ぐため複製（新ネスト形式）を返す
    var state = loadState();
    return JSON.parse(JSON.stringify(state));
  }

  function exportData() {
    return JSON.stringify(loadState(), null, 2);
  }

  /**
   * JSON をパースし、新ネスト形式を検証。旧フラット形式もマイグレーションして受理する。
   * 正しければ localStorage を置換し {ok:true}、不正なら例外を投げず {ok:false, error}。
   */
  function importData(jsonString) {
    var parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (e) {
      return { ok: false, error: 'JSON の構文が不正です: ' + e.message };
    }
    var result = migrateMap(parsed);
    if (!result.ok) {
      return {
        ok: false,
        error: 'データ形式が不正です。{ "<gameId>": { "easy|normal|hard": { "highScore": number|null, "plays": number } } } ' +
               'または旧形式 { "<gameId>": { "highScore": number, "plays": number } } を指定してください。'
      };
    }
    saveState(result.state); // 旧形式なら新形式へ変換済みのものを保存
    return { ok: true };
  }

  // ---- 画面遷移（ライフサイクル）----------------------------------------

  var currentScreen = null;

  function getModuleFor(name) {
    if (name === 'breakout') return root.Breakout || null;
    if (name === 'reflex') return root.Reflex || null;
    if (name === 'records') return root.Records || null;
    return null; // menu にはモジュール不要
  }

  function showComingSoon(sectionEl) {
    if (!sectionEl || sectionEl.querySelector('.coming-soon')) return;
    var msg = document.createElement('p');
    msg.className = 'coming-soon';
    msg.textContent = 'Coming soon';
    sectionEl.appendChild(msg);
  }

  /**
   * .screen を全て隠し #screen-<name> を表示する。
   * 離れる画面のモジュールに onExit があれば呼び、入る画面のモジュールに
   * onEnter(container) があればその section 要素を渡して呼ぶ。
   * モジュール未ロード時は「Coming soon」を表示して落ちないようにする。
   */
  function showScreen(name) {
    if (typeof document === 'undefined') {
      throw new Error('Arcade.showScreen: document is not available in this environment');
    }

    var target = document.getElementById('screen-' + name);
    if (!target) {
      console.error('Arcade.showScreen: unknown screen "' + name + '"');
      return;
    }

    // 離れる画面の onExit
    if (currentScreen && currentScreen !== name) {
      var leavingModule = getModuleFor(currentScreen);
      if (leavingModule && typeof leavingModule.onExit === 'function') {
        try {
          leavingModule.onExit();
        } catch (e) {
          console.error('Arcade: onExit failed for "' + currentScreen + '"', e);
        }
      }
    }

    var sections = document.querySelectorAll('.screen');
    for (var i = 0; i < sections.length; i++) {
      sections[i].style.display = 'none';
    }
    // Explicitly set 'block' (not '') so the shown screen doesn't fall back
    // to the CSS class rule ".screen { display: none; }" — only #screen-menu
    // has an ID-specific CSS override for its default state.
    target.style.display = 'block';

    // 入る画面の onEnter（menu はモジュール不要）
    if (name !== 'menu') {
      var enteringModule = getModuleFor(name);
      if (enteringModule && typeof enteringModule.onEnter === 'function') {
        try {
          enteringModule.onEnter(target);
        } catch (e) {
          console.error('Arcade: onEnter failed for "' + name + '"', e);
        }
      } else if (!enteringModule) {
        showComingSoon(target);
      }
    }

    currentScreen = name;
  }

  var Arcade = {
    GAMES: GAMES,
    DIFFICULTIES: DIFFICULTIES,
    DEFAULT_DIFFICULTY: DEFAULT_DIFFICULTY,
    submitScore: submitScore,
    getHighScore: getHighScore,
    getPlays: getPlays,
    getState: getState,
    exportData: exportData,
    importData: importData,
    showScreen: showScreen
  };

  root.Arcade = Arcade;
})(typeof window !== 'undefined' ? window : globalThis);
