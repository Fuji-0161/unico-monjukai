'use strict';

// ============================================================
// 定数
// ============================================================

const COLS       = 10;
const ROWS       = 20;
const CELL       = 30;
const NEXT_CELL  = 24;

const LEVEL_SPEEDS = [800, 650, 500, 380, 280, 200, 150, 110, 80, 60];
const LINE_SCORES  = [0, 100, 300, 500, 800];
const GARBAGE_THRESHOLDS = [Infinity, 10, 8, 7, 6, 5, 4, 3, 2, 2, 1];

// フェルト風パステルカラー
const TETROMINOES = {
  I: { color: '#a0d8e8', cells: [[1,0],[1,1],[1,2],[1,3]] },
  O: { color: '#ffe4a3', cells: [[0,1],[0,2],[1,1],[1,2]] },
  T: { color: '#d4b0e0', cells: [[0,1],[1,0],[1,1],[1,2]] },
  S: { color: '#b5e0c0', cells: [[0,1],[0,2],[1,0],[1,1]] },
  Z: { color: '#f7b8b8', cells: [[0,0],[0,1],[1,1],[1,2]] },
  J: { color: '#b0c4e0', cells: [[0,0],[1,0],[1,1],[1,2]] },
  L: { color: '#f5c89a', cells: [[0,2],[1,0],[1,1],[1,2]] },
};

const TETROMINO_KEYS = Object.keys(TETROMINOES);
const GARBAGE_COLOR  = '#d4c5b9';

const BG_COLOR       = '#fff8ee';   // 盤面の生成り色
const GRID_LINE      = 'rgba(168, 155, 140, 0.12)';
const STITCH_COLOR   = 'rgba(125, 90, 60, 0.35)';

// ============================================================
// ユーティリティ
// ============================================================

function randomKey() {
  return TETROMINO_KEYS[Math.floor(Math.random() * TETROMINO_KEYS.length)];
}

function createField() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

// 色を少し暗くして縁取りに使う
function darken(hex, amount = 0.3) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0,2), 16);
  const g = parseInt(m.slice(2,4), 16);
  const b = parseInt(m.slice(4,6), 16);
  const dr = Math.max(0, Math.floor(r * (1 - amount)));
  const dg = Math.max(0, Math.floor(g * (1 - amount)));
  const db = Math.max(0, Math.floor(b * (1 - amount)));
  return `rgb(${dr},${dg},${db})`;
}

// roundRect ポリフィル
function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// ============================================================
// AudioEngine （おもろ可愛い音）
// Triangle 波中心、ベル＆音楽ボックス風
// ============================================================

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.bgm = null;
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }

  /**
   * 単音を再生する汎用ヘルパー
   * @param {number} freq         基準周波数 (Hz)
   * @param {string} type         波形 ('sine'|'triangle'|'square'|'sawtooth')
   * @param {number} duration     秒
   * @param {number} gainPeak     0〜1
   * @param {number} startOffset  開始遅延 (秒)
   * @param {number[]} freqRamp   [開始Hz, 終了Hz]（指数変化）
   */
  playTone(freq, type, duration, gainPeak, startOffset = 0, freqRamp = null) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime + startOffset;

    const osc = this.ctx.createOscillator();
    osc.type  = type;
    osc.frequency.setValueAtTime(freqRamp ? freqRamp[0] : freq, now);
    if (freqRamp) {
      // exponentialRamp は 0 に到達不可なので max(終値, 0.01)
      osc.frequency.exponentialRampToValueAtTime(Math.max(freqRamp[1], 0.01), now + duration);
    }

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainPeak, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** ベル音（基音＋オクターブ上） */
  playBell(freq, duration, gainPeak, startOffset = 0) {
    this.playTone(freq,     'triangle', duration,      gainPeak,        startOffset);
    this.playTone(freq * 2, 'sine',     duration * 0.7, gainPeak * 0.4, startOffset);
  }

  // ---- 効果音 ----

  /** 移動: 軽いポップ音 */
  playMove() {
    this.playTone(880, 'sine', 0.04, 0.10);
  }

  /** 回転: 上がるピロン音 */
  playRotate() {
    this.playTone(0, 'triangle', 0.1, 0.14, 0, [700, 1100]);
  }

  /** 固定: ふんわり「ぽとっ」 */
  playLock() {
    this.playTone(0, 'triangle', 0.12, 0.16, 0, [420, 220]);
    this.playTone(180, 'sine', 0.08, 0.06, 0.04);
  }

  /** ライン消去: ベル風きらきら */
  playClear(lines) {
    if (!this.ctx) return;
    if (lines === 4) {
      // テトリス: ハッピーな上昇アルペジオ＋キラーン
      [523.25, 659.25, 783.99, 1046.50, 1318.51].forEach((f, i) => {
        this.playBell(f, 0.45, 0.18, i * 0.06);
      });
    } else {
      const base = 523 + (lines - 1) * 65;
      this.playBell(base,      0.35, 0.18);
      this.playBell(base * 1.25, 0.35, 0.14, 0.06);
      if (lines >= 2) this.playBell(base * 1.5, 0.35, 0.12, 0.12);
    }
  }

  /** ハードドロップ: 「ヒュン→ぽてっ」 */
  playHardDrop() {
    this.playTone(0, 'triangle', 0.16, 0.18, 0, [800, 180]);
    this.playTone(160, 'sine', 0.1, 0.12, 0.14);
  }

  /** ガベージ追加: 「ぴょよよよん」（ビブラート風） */
  playGarbage() {
    if (!this.ctx) return;
    // 警告のうにょん音
    this.playTone(0, 'triangle', 0.5, 0.20, 0,    [330, 220]);
    this.playTone(0, 'triangle', 0.5, 0.12, 0.06, [380, 260]);
    // 軽くシャープな注意音
    this.playTone(0, 'sine',     0.3, 0.08, 0.15, [660, 440]);
  }

  /** ゲームオーバー: しょぼーん下降 */
  playGameOver() {
    if (!this.ctx) return;
    const notes = [659.25, 587.33, 523.25, 466.16, 415.30, 369.99];
    notes.forEach((f, i) => {
      this.playTone(f, 'triangle', 0.45, 0.18, i * 0.14);
    });
    // 最後にぽとっと
    this.playTone(220, 'sine', 0.5, 0.12, notes.length * 0.14);
  }

  // ---- BGM（音楽ボックス風 / Triangle波）----

  startBGM() {
    if (!this.ctx) return;
    this.stopBGM();

    const BPM      = 140;
    const BEAT     = 60 / BPM;     // 1拍 = 約0.428秒
    const NOTE_GAP = 0.04;         // スタッカート感

    const N = {
      C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46,
      G5: 783.99, A5: 880.00, B5: 987.77, C6: 1046.50,
      D6: 1174.66,
      G4: 392.00, A4: 440.00, B4: 493.88, F5s: 739.99,
      _:    0,
    };

    // ふわふわかわいい原曲メロディー [周波数, 拍数]
    const melody = [
      // フレーズ1: 軽快な上昇
      [N.G5,1],[N.E5,1],[N.G5,1],[N.E5,1],
      [N.A5,1],[N.F5,1],[N.A5,1],[N.F5,1],
      [N.G5,2],[N.E5,2],
      [N.C5,3],[N._,1],
      // フレーズ2: 下降ハッピー
      [N.C6,2],[N.B5,1],[N.A5,1],
      [N.G5,1],[N.F5,1],[N.E5,1],[N.D5,1],
      [N.C5,2],[N.E5,2],
      [N.G5,3],[N._,1],
      // フレーズ3: 真ん中で揺れ
      [N.E5,1],[N.F5,1],[N.G5,1],[N.A5,1],
      [N.G5,1],[N.F5,1],[N.E5,1],[N.D5,1],
      [N.C5,2],[N.E5,2],
      [N.G5,3],[N._,1],
      // フレーズ4: スキップして終わり
      [N.E5,1],[N.D5,1],[N.C5,1],[N._,1],
      [N.G5,1],[N.F5,1],[N.E5,1],[N._,1],
      [N.D5,1],[N.E5,1],[N.F5,1],[N.G5,1],
      [N.C5,3],[N._,1],
    ];

    // 低音ベース（控えめ）
    const bass = [
      [N.G4,4],[N.A4,4],[N.C5,4],[N.G4,4],
      [N.A4,4],[N.G4,4],[N.C5,4],[N.G4,4],
      [N.A4,4],[N.G4,4],[N.C5,4],[N.G4,4],
      [N.A4,4],[N.G4,4],[N.F5s,4],[N.G4,4],
    ];

    this.bgm = { active: true, nodes: [], timer: null };

    const schedulePart = (notes, startTime, gainPeak, waveType) => {
      let t = startTime;
      for (const [freq, beats] of notes) {
        const dur = beats * BEAT;
        if (freq > 0) {
          const osc = this.ctx.createOscillator();
          osc.type  = waveType;
          osc.frequency.setValueAtTime(freq, t);

          const gain = this.ctx.createGain();
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(gainPeak, t + 0.015);
          gain.gain.setValueAtTime(gainPeak, t + dur - NOTE_GAP);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(t);
          osc.stop(t + dur + 0.02);
          this.bgm.nodes.push(osc, gain);
        }
        t += dur;
      }
      return t;
    };

    const scheduleLoop = (startTime) => {
      if (!this.bgm || !this.bgm.active) return;
      const endMelody = schedulePart(melody, startTime, 0.07, 'triangle');
      schedulePart(bass,   startTime, 0.04, 'sine');

      const loopDuration = endMelody - startTime;
      this.bgm.timer = setTimeout(() => {
        scheduleLoop(startTime + loopDuration);
      }, loopDuration * 1000 - 250);
    };

    scheduleLoop(this.ctx.currentTime + 0.1);
  }

  stopBGM() {
    if (!this.bgm) return;
    this.bgm.active = false;
    clearTimeout(this.bgm.timer);
    for (const node of this.bgm.nodes) {
      try { node.disconnect(); } catch (_) {}
    }
    this.bgm = null;
  }
}

// ============================================================
// Piece クラス
// ============================================================

class Piece {
  constructor(key) {
    this.key       = key;
    this.color     = TETROMINOES[key].color;
    this.cells     = TETROMINOES[key].cells.map(([r, c]) => [r, c]);
    this.offsetRow = 0;
    this.offsetCol = Math.floor((COLS - 4) / 2);
  }

  absoluteCells() {
    return this.cells.map(([r, c]) => [r + this.offsetRow, c + this.offsetCol]);
  }

  // 時計回り90度回転: (r,c) -> (c, 3-r)
  rotatedCells() {
    return this.cells.map(([r, c]) => [c, 3 - r]);
  }
}

// ============================================================
// TetrisGame クラス
// ============================================================

class TetrisGame {
  constructor() {
    this.boardCanvas  = document.getElementById('board');
    this.boardCtx     = this.boardCanvas.getContext('2d');
    this.nextCanvas   = document.getElementById('next-canvas');
    this.nextCtx      = this.nextCanvas.getContext('2d');

    this.scoreEl      = document.getElementById('score');
    this.levelEl      = document.getElementById('level');
    this.linesEl      = document.getElementById('lines');
    this.overlay      = document.getElementById('overlay');
    this.overlayTitle = document.getElementById('overlay-title');
    this.overlaySub   = document.getElementById('overlay-sub');
    this.boardWrapper = document.getElementById('board-wrapper');

    this.field        = createField();
    this.piece        = null;
    this.nextKey      = randomKey();
    this.score        = 0;
    this.level        = 1;
    this.lines        = 0;
    this.linesInLevel = 0;
    this.garbageAccum = 0;
    this.isRunning    = false;
    this.isGameOver   = false;
    this.dropTimer    = null;

    this.audio = new AudioEngine();

    document.addEventListener('keydown', (e) => this.handleKey(e));

    this.drawBoard();
    this.drawNext();
  }

  // ---- ゲーム制御 ----

  start() {
    this.audio.init();
    this.audio.startBGM();

    this.field        = createField();
    this.score        = 0;
    this.level        = 1;
    this.lines        = 0;
    this.linesInLevel = 0;
    this.garbageAccum = 0;
    this.isGameOver   = false;
    this.nextKey      = randomKey();
    this.updateUI();
    this.hideOverlay();
    this.spawnPiece();
    this.startDropTimer();
    this.isRunning = true;
  }

  startDropTimer() {
    if (this.dropTimer) clearInterval(this.dropTimer);
    const speed = LEVEL_SPEEDS[Math.min(this.level - 1, LEVEL_SPEEDS.length - 1)];
    this.dropTimer = setInterval(() => this.softDrop(false), speed);
  }

  gameOver() {
    this.isRunning  = false;
    this.isGameOver = true;
    clearInterval(this.dropTimer);
    this.audio.stopBGM();
    this.audio.playGameOver();
    this.showOverlay('GAME OVER', 'Press ENTER to Retry');
  }

  // ---- ピース管理 ----

  spawnPiece() {
    this.piece   = new Piece(this.nextKey);
    this.nextKey = randomKey();
    this.drawNext();
    if (this.collides(this.piece, 0, 0)) {
      this.drawBoard();
      this.gameOver();
    }
  }

  collides(piece, dr, dc, overrideCells = null) {
    const cells = overrideCells
      ? overrideCells.map(([r, c]) => [r + piece.offsetRow, c + piece.offsetCol])
      : piece.absoluteCells();
    for (const [r, c] of cells) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return true;
      if (this.field[nr][nc] !== null) return true;
    }
    return false;
  }

  lockPiece() {
    for (const [r, c] of this.piece.absoluteCells()) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        this.field[r][c] = this.piece.color;
      }
    }
    this.audio.playLock();
    this.clearLines();
    this.spawnPiece();
  }

  // ---- ライン消去・スコア・ガベージ ----

  clearLines() {
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; ) {
      if (this.field[r].every(cell => cell !== null)) {
        this.field.splice(r, 1);
        this.field.unshift(Array(COLS).fill(null));
        cleared++;
      } else {
        r--;
      }
    }
    if (cleared > 0) {
      this.audio.playClear(cleared);
      this.score += LINE_SCORES[cleared] * this.level;
      this.lines += cleared;
      this.linesInLevel += cleared;
      const newLevel = Math.floor(this.lines / 10) + 1;
      if (newLevel !== this.level) {
        this.level = newLevel;
        this.startDropTimer();
      }
      this.checkGarbage(cleared);
      this.updateUI();
    }
  }

  checkGarbage(cleared) {
    const threshold = GARBAGE_THRESHOLDS[Math.min(this.level, GARBAGE_THRESHOLDS.length - 1)];
    if (threshold === Infinity) return;
    this.garbageAccum += cleared;
    while (this.garbageAccum >= threshold) {
      this.garbageAccum -= threshold;
      this.addGarbageLine();
    }
  }

  addGarbageLine() {
    this.field.shift();
    const hole = Math.floor(Math.random() * COLS);
    this.field.push(Array.from({ length: COLS }, (_, c) =>
      c === hole ? null : GARBAGE_COLOR
    ));
    this.audio.playGarbage();
    this.flashGarbage();
  }

  flashGarbage() {
    this.boardWrapper.classList.remove('garbage-flash');
    void this.boardWrapper.offsetWidth;
    this.boardWrapper.classList.add('garbage-flash');
  }

  // ---- 入力処理 ----

  handleKey(e) {
    if (e.code === 'Enter' && !this.isRunning) { this.start(); return; }
    if (!this.isRunning) return;
    switch (e.code) {
      case 'ArrowLeft':  e.preventDefault(); this.moveHorizontal(-1); break;
      case 'ArrowRight': e.preventDefault(); this.moveHorizontal(1);  break;
      case 'ArrowDown':  e.preventDefault(); this.softDrop(true);     break;
      case 'ArrowUp':    e.preventDefault(); this.rotate();           break;
      case 'Space':      e.preventDefault(); this.hardDrop();         break;
    }
  }

  moveHorizontal(dc) {
    if (!this.collides(this.piece, 0, dc)) {
      this.piece.offsetCol += dc;
      this.audio.playMove();
      this.drawBoard();
    }
  }

  softDrop(manual) {
    if (!this.collides(this.piece, 1, 0)) {
      this.piece.offsetRow += 1;
      if (manual) this.score += 1;
      this.updateUI();
    } else {
      this.lockPiece();
    }
    this.drawBoard();
  }

  hardDrop() {
    let dropped = 0;
    while (!this.collides(this.piece, 1, 0)) {
      this.piece.offsetRow += 1;
      dropped++;
    }
    this.score += dropped * 2;
    this.audio.playHardDrop();
    this.updateUI();
    this.lockPiece();
    this.drawBoard();
  }

  rotate() {
    const rotated = this.piece.rotatedCells();
    if (!this.collides(this.piece, 0, 0, rotated)) {
      this.piece.cells = rotated;
      this.audio.playRotate();
      this.drawBoard();
      return;
    }
    for (const dc of [1, -1, 2, -2]) {
      if (!this.collides(this.piece, 0, dc, rotated)) {
        this.piece.cells    = rotated;
        this.piece.offsetCol += dc;
        this.audio.playRotate();
        this.drawBoard();
        return;
      }
    }
  }

  // ---- 描画（フェルト風） ----

  /**
   * フェルトピース1マスを描画する。
   *  1. 角丸の本体（指定color）
   *  2. 上部ハイライト（白の薄い帯）
   *  3. 下部シャドウ
   *  4. ステッチ風の破線アウトライン
   */
  drawCell(ctx, x, y, color, size) {
    const m  = 2;            // パディング
    const r  = size * 0.22;  // 角丸半径
    const ix = x + m,        iy = y + m;
    const iw = size - m * 2, ih = size - m * 2;

    // 本体
    roundedRectPath(ctx, ix, iy, iw, ih, r);
    ctx.fillStyle = color;
    ctx.fill();

    // 上部ハイライト（白の薄い帯）
    roundedRectPath(ctx, ix + 3, iy + 3, iw - 6, ih * 0.38, r * 0.65);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fill();

    // 下部シャドウ（深みを出す）
    roundedRectPath(ctx, ix + 3, iy + ih * 0.62, iw - 6, ih * 0.32, r * 0.55);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.07)';
    ctx.fill();

    // ステッチ風の破線アウトライン
    ctx.save();
    ctx.setLineDash([2.8, 2.2]);
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = darken(color, 0.42);
    roundedRectPath(ctx, ix + 1.5, iy + 1.5, iw - 3, ih - 3, Math.max(2, r - 1.5));
    ctx.stroke();
    ctx.restore();
  }

  getGhostCells() {
    let ghostRow = this.piece.offsetRow;
    while (!this.collides(
      { ...this.piece, offsetRow: ghostRow+1, absoluteCells: () =>
        this.piece.cells.map(([r,c]) => [r+ghostRow+1, c+this.piece.offsetCol]) },
      0, 0
    )) { ghostRow++; }
    return this.piece.cells.map(([r,c]) => [r+ghostRow, c+this.piece.offsetCol]);
  }

  drawBoard() {
    const ctx = this.boardCtx;
    const W = COLS * CELL, H = ROWS * CELL;

    // 生成り背景
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, W, H);

    // ふんわりドット
    ctx.fillStyle = 'rgba(244, 168, 185, 0.08)';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if ((r + c) % 2 === 0) {
          ctx.beginPath();
          ctx.arc(c*CELL + CELL/2, r*CELL + CELL/2, 1.5, 0, Math.PI*2);
          ctx.fill();
        }
      }
    }

    // 控えめグリッド
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath(); ctx.moveTo(0, r*CELL); ctx.lineTo(W, r*CELL); ctx.stroke();
    }
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath(); ctx.moveTo(c*CELL, 0); ctx.lineTo(c*CELL, H); ctx.stroke();
    }

    // 固定済みブロック
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (this.field[r][c]) this.drawCell(ctx, c*CELL, r*CELL, this.field[r][c], CELL);

    if (!this.piece) return;

    // ゴースト
    const ghost = this.getGhostCells();
    ctx.globalAlpha = 0.25;
    for (const [r,c] of ghost) this.drawCell(ctx, c*CELL, r*CELL, this.piece.color, CELL);
    ctx.globalAlpha = 1.0;

    // 現在のピース
    for (const [r,c] of this.piece.absoluteCells())
      if (r >= 0) this.drawCell(ctx, c*CELL, r*CELL, this.piece.color, CELL);
  }

  drawNext() {
    const ctx = this.nextCtx, size = this.nextCanvas.width;
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, size, size);
    if (!this.nextKey) return;

    const def = TETROMINOES[this.nextKey], cells = def.cells;
    const minR = Math.min(...cells.map(([r])=>r));
    const maxR = Math.max(...cells.map(([r])=>r));
    const minC = Math.min(...cells.map(([,c])=>c));
    const maxC = Math.max(...cells.map(([,c])=>c));
    const sx = Math.floor((size-(maxC-minC+1)*NEXT_CELL)/2) - minC*NEXT_CELL;
    const sy = Math.floor((size-(maxR-minR+1)*NEXT_CELL)/2) - minR*NEXT_CELL;
    for (const [r,c] of cells)
      this.drawCell(ctx, sx+c*NEXT_CELL, sy+r*NEXT_CELL, def.color, NEXT_CELL);
  }

  // ---- UI更新 ----

  updateUI() {
    this.scoreEl.textContent = this.score.toLocaleString();
    this.levelEl.textContent = this.level;
    this.linesEl.textContent = this.lines;
  }

  showOverlay(title, sub) {
    this.overlayTitle.textContent = title;
    this.overlaySub.textContent   = sub;
    this.overlay.classList.add('active');
  }

  hideOverlay() {
    this.overlay.classList.remove('active');
  }
}

// ============================================================
// 起動
// ============================================================

const game = new TetrisGame();
