/**
 * Mini Game Arcade - core.js  (schema v2: per-difficulty scores)
 *
 * Provides:
 *  - Global `Arcade` object shared by every game/screen.
 *  - Score/state persistence backed by a single localStorage key.
 *  - A tiny screen registry so the shell (index.html) can build the menu
 *    and switch between screens without knowing about individual games.
 *
 * localStorage:
 *  - Key: "arcade.save" (the ONLY key this app writes to localStorage)
 *  - Value: JSON object map, NESTED by gameId then difficulty:
 *      {
 *        "breakout": {
 *          "normal": { "highScore": 120, "plays": 4 },
 *          "hard":   { "highScore": 60,  "plays": 2 }
 *        },
 *        "reflex": { "normal": { "highScore": 88, "plays": 1 } }
 *      }
 *    Only the (gameId, difficulty) pairs that have actually been played
 *    need to exist.
 *
 * Difficulty:
 *  - Arcade.DIFFICULTIES = ['easy','normal','hard']  (frozen array)
 *  - Arcade.DEFAULT_DIFFICULTY = 'normal'
 *  - Every score API takes an optional `difficulty` argument; when omitted
 *    it defaults to 'normal'. A difficulty outside DIFFICULTIES throws
 *    TypeError.
 *
 * Migration (automatic, transparent):
 *  - The v1 FLAT shape { "<gameId>": { "highScore": number, "plays": number } }
 *    is migrated on read: each flat entry is wrapped as the 'normal'
 *    difficulty -> { "<gameId>": { "normal": { highScore, plays } } }.
 *  - Detection is unambiguous: if a gameId's value is an object that directly
 *    carries numeric `highScore` and `plays`, it is a v1 flat entry (-> wrap
 *    as normal). Otherwise, if its keys are difficulty names whose values are
 *    { highScore, plays }, it is already v2 nested.
 *  - loadState() normalizes on every read and, if normalization changed the
 *    content, writes the migrated map back to localStorage so migration is
 *    permanent. Malformed/invalid data safely normalizes to {}.
 *
 * Public API (window.Arcade / global.Arcade):
 *  - Arcade.DIFFICULTIES: readonly ['easy','normal','hard']
 *  - Arcade.DEFAULT_DIFFICULTY: 'normal'
 *
 *  - Arcade.submitScore(gameId: string, score: number, difficulty?: string)
 *        : { highScore: number, plays: number }
 *      difficulty defaults to 'normal'; invalid difficulty -> TypeError.
 *      Updates highScore only if `score` beats the stored highScore for that
 *      (gameId, difficulty). `plays` is always incremented by 1. Other
 *      difficulties of the same game are untouched.
 *
 *  - Arcade.getHighScore(gameId: string, difficulty?: string): number | null
 *      difficulty defaults to 'normal'. null when that (gameId, difficulty)
 *      has never been played (or data was invalid).
 *
 *  - Arcade.getState(): { [gameId]: { [difficulty]: { highScore, plays } } }
 *      Returns the full normalized (migrated) nested map, a fresh object each
 *      call.
 *
 *  - Arcade.replaceState(newState): boolean
 *      Validates `newState` as a map of gameId -> ({ [difficulty]:
 *      { highScore:number, plays:number } } nested, OR a v1 flat
 *      { highScore:number, plays:number } entry which is migrated to 'normal'
 *      for import back-compat). On success, overwrites localStorage (with the
 *      normalized nested form) and returns true. On invalid input, does NOT
 *      touch storage and returns false. (Used by the Records screen's Import.)
 *
 *  - Arcade.registerScreen({ id, title, mount, unmount }): the registered screen
 *      - id: string, unique screen id (e.g. 'breakout', 'reflex', 'records')
 *      - title: string shown as the menu button label
 *      - mount(container: HTMLElement): called when the screen becomes visible;
 *          `container` is an empty <div> owned by that screen.
 *      - unmount(): optional; called when leaving the screen (menu or another
 *          screen). Use it to clear timers/listeners started in mount().
 *  - Arcade.getScreens(): array of registered screens, in registration order.
 *      Used by the shell to build the menu.
 *
 * Robustness: any read of localStorage that yields malformed JSON or a value
 * that doesn't match an expected shape is treated as "no data" ({}) instead of
 * throwing, so a corrupted save can never crash the app.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'arcade.save';

  var DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);
  var DEFAULT_DIFFICULTY = 'normal';
  var DIFFICULTY_SET = { easy: true, normal: true, hard: true };

  // ---- validation helpers -------------------------------------------------

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // A leaf score record: { highScore:number, plays:number }.
  function isScoreRecord(v) {
    return isPlainObject(v) && isFiniteNumber(v.highScore) && isFiniteNumber(v.plays);
  }

  function normalizeDifficulty(difficulty) {
    if (difficulty === undefined) {
      return DEFAULT_DIFFICULTY;
    }
    if (typeof difficulty !== 'string' || !DIFFICULTY_SET[difficulty]) {
      throw new TypeError(
        'Arcade: difficulty must be one of ' + DIFFICULTIES.join(', ') +
        ' (got ' + JSON.stringify(difficulty) + ')'
      );
    }
    return difficulty;
  }

  // ---- shape normalization / migration -------------------------------------

  // Given the value stored under one gameId, return a normalized nested map
  // { <difficulty>: { highScore, plays } }, or null if the value is invalid.
  function normalizeGameEntry(value) {
    if (!isPlainObject(value)) {
      return null;
    }

    // v1 flat entry: directly carries numeric highScore & plays.
    if (isScoreRecord(value)) {
      return { normal: { highScore: value.highScore, plays: value.plays } };
    }

    // v2 nested entry: keys must all be difficulty names mapping to score records.
    var out = {};
    var count = 0;
    for (var diff in value) {
      if (Object.prototype.hasOwnProperty.call(value, diff)) {
        if (!DIFFICULTY_SET[diff] || !isScoreRecord(value[diff])) {
          return null;
        }
        out[diff] = { highScore: value[diff].highScore, plays: value[diff].plays };
        count++;
      }
    }
    // An empty object is not a meaningful game entry; treat as invalid.
    if (count === 0) {
      return null;
    }
    return out;
  }

  // Normalize a whole raw map into the v2 nested form.
  // Returns { state, changed } where `changed` is true if normalization
  // altered the structure (used to decide whether to write back).
  // Returns { state: null } if the top-level value isn't a usable object map.
  function normalizeStateMap(raw) {
    if (!isPlainObject(raw)) {
      return { state: null, changed: false };
    }
    var out = {};
    var changed = false;
    for (var gameId in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, gameId)) {
        var normalized = normalizeGameEntry(raw[gameId]);
        if (normalized === null) {
          // Any invalid game entry poisons the whole map -> safe reset.
          return { state: null, changed: false };
        }
        out[gameId] = normalized;
        // Detect whether this entry differed from its normalized form.
        if (!changed && JSON.stringify(raw[gameId]) !== JSON.stringify(normalized)) {
          changed = true;
        }
      }
    }
    return { state: out, changed: changed };
  }

  function getLocalStorage() {
    try {
      return root && root.localStorage ? root.localStorage : null;
    } catch (e) {
      // Some environments (e.g. sandboxed iframes with storage blocked)
      // throw just accessing the `localStorage` property.
      return null;
    }
  }

  // ---- persistence ---------------------------------------------------------

  // Reads, normalizes/migrates, and (if migration changed content) writes back.
  function loadState() {
    var storage = getLocalStorage();
    if (!storage) {
      return {};
    }
    var raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (e) {
      return {};
    }
    if (!raw) {
      return {};
    }
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {};
    }
    var result = normalizeStateMap(parsed);
    if (result.state === null) {
      return {};
    }
    if (result.changed) {
      // Persist the migration so it only happens once.
      saveState(result.state);
    }
    return result.state;
  }

  function saveState(state) {
    var storage = getLocalStorage();
    if (!storage) {
      return false;
    }
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- public score API -----------------------------------------------------

  function submitScore(gameId, score, difficulty) {
    if (typeof gameId !== 'string' || gameId.length === 0) {
      throw new TypeError('Arcade.submitScore: gameId must be a non-empty string');
    }
    if (!isFiniteNumber(score)) {
      throw new TypeError('Arcade.submitScore: score must be a finite number');
    }
    var diff = normalizeDifficulty(difficulty);

    var state = loadState();
    var game = isPlainObject(state[gameId]) ? state[gameId] : {};
    var existing = isScoreRecord(game[diff]) ? game[diff] : null;
    var prevHigh = existing ? existing.highScore : null;
    var prevPlays = existing ? existing.plays : 0;
    var newHigh = prevHigh === null || score > prevHigh ? score : prevHigh;

    var entry = { highScore: newHigh, plays: prevPlays + 1 };
    game[diff] = entry;
    state[gameId] = game;
    saveState(state);

    return { highScore: entry.highScore, plays: entry.plays };
  }

  function getHighScore(gameId, difficulty) {
    var diff = normalizeDifficulty(difficulty);
    var state = loadState();
    var game = state[gameId];
    if (!isPlainObject(game) || !isScoreRecord(game[diff])) {
      return null;
    }
    return game[diff].highScore;
  }

  function getState() {
    return loadState();
  }

  function replaceState(newState) {
    // Validate + normalize (this also migrates v1 flat entries to normal).
    var result = normalizeStateMap(newState);
    if (result.state === null) {
      return false;
    }
    return saveState(result.state);
  }

  // ---- screen registry -------------------------------------------------------

  var screens = [];
  var screensById = {};

  function registerScreen(def) {
    if (!def || typeof def.id !== 'string' || def.id.length === 0) {
      throw new TypeError('Arcade.registerScreen: id must be a non-empty string');
    }
    if (typeof def.mount !== 'function') {
      throw new TypeError('Arcade.registerScreen: mount(container) function is required');
    }
    if (screensById[def.id]) {
      throw new Error('Arcade.registerScreen: screen "' + def.id + '" is already registered');
    }

    var screen = {
      id: def.id,
      title: typeof def.title === 'string' && def.title.length > 0 ? def.title : def.id,
      mount: def.mount,
      unmount: typeof def.unmount === 'function' ? def.unmount : function () {}
    };

    screensById[def.id] = screen;
    screens.push(screen);
    return screen;
  }

  function getScreens() {
    return screens.slice();
  }

  // ---- expose ------------------------------------------------------------

  var Arcade = {
    DIFFICULTIES: DIFFICULTIES,
    DEFAULT_DIFFICULTY: DEFAULT_DIFFICULTY,
    submitScore: submitScore,
    getHighScore: getHighScore,
    getState: getState,
    replaceState: replaceState,
    registerScreen: registerScreen,
    getScreens: getScreens
  };

  root.Arcade = Arcade;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Arcade;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
