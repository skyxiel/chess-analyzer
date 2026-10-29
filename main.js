import { Chess } from './chess.js';

(function () {
    'use strict';

    var STOCKFISH_URL = './stockfish.js';

    var PIECES = {
        wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
        bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟'
    };

    var THRESHOLDS = { excellent: 10, good: 30, inaccuracy: 75, mistake: 150, blunder: 300 };
    var ANNOTATIONS = { best: '!!', excellent: '!', good: '', book: '', inaccuracy: '?!', mistake: '?', blunder: '??' };
    var CLASS_LABELS = {
        best: 'Best', excellent: 'Excellent', good: 'Good', book: 'Book',
        inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder'
    };

    var MATE_SCORE = 10000;

    var state = {
        game: null,
        moves: [],
        positions: [],
        currentIndex: 0,
        flipped: false,
        evaluations: [],
        classifications: [],
        engine: null,
        analyzing: false,
        cancelled: false,
        depth: 14,
        autoplayTimer: null,
        liveEngine: null,
        headers: {}
    };

    // ---- Engine ----

    function createEngine() {
        return new Promise(function (resolve, reject) {
            var worker;
            try {
                worker = new Worker(STOCKFISH_URL);
            } catch (e1) {
                try {
                    var code = "importScripts('" + new URL(STOCKFISH_URL, location.href).href + "');";
                    var blob = new Blob([code], { type: 'application/javascript' });
                    worker = new Worker(URL.createObjectURL(blob));
                } catch (e2) {
                    reject(new Error('Failed to create Stockfish worker'));
                    return;
                }
            }
            var ready = false;

            worker.onerror = function (e) {
                if (!ready) reject(new Error('Failed to load Stockfish engine'));
            };

            worker.onmessage = function (e) {
                if (e.data === 'uciok') {
                    worker.postMessage('isready');
                }
                if (e.data === 'readyok' && !ready) {
                    ready = true;
                    resolve(worker);
                }
            };

            worker.postMessage('uci');
        });
    }

    function analyzePosition(engine, fen, depth) {
        return new Promise(function (resolve) {
            var result = { score: 0, mate: null, bestMove: null, pv: '' };

            function handler(e) {
                var line = e.data;
                if (typeof line !== 'string') return;

                if (line.indexOf('info depth') !== -1 && line.indexOf(' pv ') !== -1) {
                    var depthMatch = line.match(/depth (\d+)/);
                    var d = depthMatch ? parseInt(depthMatch[1]) : 0;
                    if (d <= depth) {
                        var scoreMatch = line.match(/score cp (-?\d+)/);
                        var mateMatch = line.match(/score mate (-?\d+)/);
                        var pvMatch = line.match(/ pv (.+)/);
                        if (scoreMatch) {
                            result.score = parseInt(scoreMatch[1]);
                            result.mate = null;
                        }
                        if (mateMatch) {
                            var m = parseInt(mateMatch[1]);
                            result.mate = m;
                            result.score = m > 0 ? MATE_SCORE - Math.abs(m) : -MATE_SCORE + Math.abs(m);
                        }
                        if (pvMatch) {
                            result.pv = pvMatch[1].trim();
                            result.bestMove = result.pv.split(' ')[0];
                        }
                    }
                }

                if (line.indexOf('bestmove') === 0) {
                    engine.removeEventListener('message', handler);
                    var bm = line.split(' ')[1];
                    if (bm && bm !== '(none)') result.bestMove = bm;
                    resolve(result);
                }
            }

            engine.addEventListener('message', handler);
            engine.postMessage('position fen ' + fen);
            engine.postMessage('go depth ' + depth);
        });
    }

    function stopEngine(engine) {
        if (engine) engine.postMessage('stop');
    }

    // ---- PGN / Game ----

    function loadPGN(pgn) {
        var game = new Chess();
        pgn = pgn.trim();

        if (game.load_pgn(pgn)) {
            return game;
        }

        var cleaned = pgn.replace(/\r\n/g, '\n').replace(/\{[^}]*\}/g, '').replace(/\([^)]*\)/g, '');
        if (game.load_pgn(cleaned)) return game;

        var movesOnly = cleaned.replace(/\[.*?\]\s*/g, '').trim();
        if (game.load_pgn(movesOnly)) return game;

        var temp = new Chess();
        var tokens = movesOnly.replace(/\d+\.\s*/g, ' ').replace(/1-0|0-1|1\/2-1\/2|\*/g, '').trim().split(/\s+/);
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i] && !temp.move(tokens[i])) break;
        }
        if (temp.history().length > 0) return temp;

        return null;
    }

    function extractPositions(game) {
        var moves = game.history({ verbose: true });
        var positions = [];
        var temp = new Chess();

        var headers = game.header();
        if (headers.FEN) {
            temp = new Chess(headers.FEN);
        }

        positions.push(temp.fen());
        for (var i = 0; i < moves.length; i++) {
            temp.move(moves[i].san);
            positions.push(temp.fen());
        }

        return { moves: moves, positions: positions, headers: headers };
    }

    // ---- Classification ----

    function classifyMove(evalBefore, evalAfter, playedMoveUCI, bestMoveUCI) {
        var wb = evalBefore.score;
        var wa = -evalAfter.score;
        var loss = wb - wa;

        if (playedMoveUCI && bestMoveUCI && playedMoveUCI === bestMoveUCI) {
            return 'best';
        }

        if (loss <= THRESHOLDS.excellent) return 'excellent';
        if (loss <= THRESHOLDS.good) return 'good';
        if (loss <= THRESHOLDS.inaccuracy) return 'inaccuracy';
        if (loss <= THRESHOLDS.mistake) return 'mistake';
        return 'blunder';
    }

    function moveToUCI(move) {
        var uci = move.from + move.to;
        if (move.promotion) uci += move.promotion;
        return uci;
    }

    function computeAccuracy(acpl) {
        var acc = 103.1668 * Math.exp(-0.04354 * acpl) - 3.1669;
        return Math.max(0, Math.min(100, acc));
    }

    // ---- Board Rendering ----

    function createBoard() {
        var board = document.getElementById('board');
        board.innerHTML = '';

        for (var rank = 0; rank < 8; rank++) {
            for (var file = 0; file < 8; file++) {
                var sq = document.createElement('div');
                var isLight = (rank + file) % 2 === 0;
                sq.className = 'square ' + (isLight ? 'light' : 'dark');

                var r = state.flipped ? rank : 7 - rank;
                var f = state.flipped ? 7 - file : file;
                var name = 'abcdefgh'[f] + (r + 1);
                sq.dataset.square = name;

                if (file === 0) {
                    var rl = document.createElement('span');
                    rl.className = 'coord-rank';
                    rl.textContent = r + 1;
                    sq.appendChild(rl);
                }
                if (rank === 7) {
                    var fl = document.createElement('span');
                    fl.className = 'coord-file';
                    fl.textContent = 'abcdefgh'[f];
                    sq.appendChild(fl);
                }

                var piece = document.createElement('span');
                piece.className = 'piece';
                sq.appendChild(piece);

                board.appendChild(sq);
            }
        }
    }

    function updateBoard() {
        var fen = state.positions[state.currentIndex];
        var temp = new Chess(fen);
        var boardArr = temp.board();

        var squares = document.querySelectorAll('#board .square');
        for (var i = 0; i < squares.length; i++) {
            var sq = squares[i];
            var name = sq.dataset.square;
            var f = name.charCodeAt(0) - 97;
            var r = parseInt(name[1]) - 1;
            var cell = boardArr[7 - r][f];
            var pieceEl = sq.querySelector('.piece');

            if (cell) {
                var key = cell.color + cell.type.toUpperCase();
                pieceEl.textContent = PIECES[key];
            } else {
                pieceEl.textContent = '';
            }

            sq.classList.remove('highlight-from', 'highlight-to');
        }

        if (state.currentIndex > 0) {
            var last = state.moves[state.currentIndex - 1];
            var fromSq = document.querySelector('.square[data-square="' + last.from + '"]');
            var toSq = document.querySelector('.square[data-square="' + last.to + '"]');
            if (fromSq) fromSq.classList.add('highlight-from');
            if (toSq) toSq.classList.add('highlight-to');
        }
    }

    // ---- Move List ----

    function buildMoveList() {
        var container = document.getElementById('move-list');
        container.innerHTML = '';

        for (var i = 0; i < state.moves.length; i++) {
            var move = state.moves[i];
            var cls = state.classifications[i] || '';
            var isWhite = i % 2 === 0;

            if (isWhite) {
                var num = document.createElement('div');
                num.className = 'move-number';
                num.textContent = Math.floor(i / 2) + 1 + '.';
                container.appendChild(num);
            }

            var cell = document.createElement('div');
            cell.className = 'move-cell' + (cls ? ' c-' + cls : '');
            cell.dataset.index = i + 1;

            var san = document.createElement('span');
            san.textContent = move.san;
            cell.appendChild(san);

            if (cls && ANNOTATIONS[cls]) {
                var ann = document.createElement('span');
                ann.className = 'move-annotation';
                ann.textContent = ANNOTATIONS[cls];
                cell.appendChild(ann);
            }

            cell.addEventListener('click', (function (idx) {
                return function () { goToMove(idx); };
            })(i + 1));

            container.appendChild(cell);

            if (!isWhite || i === state.moves.length - 1) {
                if (isWhite) {
                    var empty = document.createElement('div');
                    empty.className = 'move-cell';
                    container.appendChild(empty);
                }
            }
        }

        highlightActiveMove();
    }

    function highlightActiveMove() {
        var cells = document.querySelectorAll('.move-cell');
        for (var i = 0; i < cells.length; i++) {
            cells[i].classList.remove('active');
            if (parseInt(cells[i].dataset.index) === state.currentIndex) {
                cells[i].classList.add('active');
                cells[i].scrollIntoView({ block: 'nearest' });
            }
        }
    }

    // ---- Eval Bar ----

    function updateEvalBar() {
        var evalData = state.evaluations[state.currentIndex];
        var fill = document.getElementById('eval-fill');
        var text = document.getElementById('eval-text');

        if (!evalData) {
            fill.style.height = '50%';
            text.textContent = '0.0';
            return;
        }

        var fen = state.positions[state.currentIndex];
        var isWhiteTurn = fen.split(' ')[1] === 'w';
        var whiteScore = isWhiteTurn ? evalData.score : -evalData.score;
        var whiteMate = evalData.mate !== null ? (isWhiteTurn ? evalData.mate : -evalData.mate) : null;

        if (whiteMate !== null) {
            var pct = whiteMate > 0 ? 95 : 5;
            fill.style.height = pct + '%';
            text.textContent = 'M' + Math.abs(whiteMate);
        } else {
            var cp = whiteScore / 100;
            var pct2 = 50 + (Math.atan(cp / 2) / (Math.PI / 2)) * 45;
            pct2 = Math.max(3, Math.min(97, pct2));
            fill.style.height = pct2 + '%';

            if (Math.abs(cp) >= 10) {
                text.textContent = cp > 0 ? '+' + Math.round(cp) : Math.round(cp);
            } else {
                text.textContent = (cp > 0 ? '+' : '') + cp.toFixed(1);
            }
        }
    }

    // ---- Eval Graph ----

    function drawEvalGraph() {
        var canvas = document.getElementById('eval-graph');
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        var rect = canvas.getBoundingClientRect();

        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        var w = rect.width;
        var h = rect.height;
        var n = state.positions.length;
        if (n < 2) return;

        var maxEval = 5;

        function evalToWhite(idx) {
            var ev = state.evaluations[idx];
            if (!ev) return 0;
            var fen = state.positions[idx];
            var isW = fen.split(' ')[1] === 'w';
            var s = isW ? ev.score : -ev.score;
            return Math.max(-maxEval, Math.min(maxEval, s / 100));
        }

        function xFor(i) { return (i / (n - 1)) * w; }
        function yFor(v) { return h / 2 - (v / maxEval) * (h / 2); }

        ctx.fillStyle = '#161625';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = '#2a2a4a';
        ctx.lineWidth = 0.5;
        for (var g = -4; g <= 4; g++) {
            var gy = yFor(g);
            ctx.beginPath();
            ctx.moveTo(0, gy);
            ctx.lineTo(w, gy);
            ctx.stroke();
        }

        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yFor(0));
        ctx.lineTo(w, yFor(0));
        ctx.stroke();

        var points = [];
        for (var i = 0; i < n; i++) {
            points.push({ x: xFor(i), y: yFor(evalToWhite(i)) });
        }

        ctx.beginPath();
        ctx.moveTo(points[0].x, yFor(0));
        for (var i2 = 0; i2 < points.length; i2++) ctx.lineTo(points[i2].x, points[i2].y);
        ctx.lineTo(points[points.length - 1].x, yFor(0));
        ctx.closePath();

        var gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(240,240,240,0.25)');
        gradient.addColorStop(0.5, 'rgba(240,240,240,0.02)');
        gradient.addColorStop(0.5, 'rgba(40,40,40,0.02)');
        gradient.addColorStop(1, 'rgba(40,40,40,0.25)');
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (var i3 = 1; i3 < points.length; i3++) ctx.lineTo(points[i3].x, points[i3].y);
        ctx.strokeStyle = '#bbb';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        for (var i4 = 1; i4 < n && i4 <= state.classifications.length; i4++) {
            var cls = state.classifications[i4 - 1];
            if (cls === 'inaccuracy' || cls === 'mistake' || cls === 'blunder') {
                var color = cls === 'inaccuracy' ? '#f7c631' : cls === 'mistake' ? '#e58f2a' : '#ca3431';
                ctx.beginPath();
                ctx.arc(points[i4].x, points[i4].y, 3.5, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
            }
        }

        if (state.currentIndex >= 0 && state.currentIndex < points.length) {
            var cp = points[state.currentIndex];
            ctx.beginPath();
            ctx.moveTo(cp.x, 0);
            ctx.lineTo(cp.x, h);
            ctx.strokeStyle = 'rgba(78,204,163,0.5)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#4ecca3';
            ctx.fill();
        }
    }

    // ---- Engine Info ----

    function updateEngineInfo() {
        var evalEl = document.getElementById('engine-eval');
        var lineEl = document.getElementById('engine-line');
        var depthEl = document.getElementById('engine-depth');

        var ev = state.evaluations[state.currentIndex];
        if (!ev) {
            evalEl.textContent = '-';
            lineEl.textContent = '';
            depthEl.textContent = '';
            return;
        }

        var fen = state.positions[state.currentIndex];
        var isW = fen.split(' ')[1] === 'w';
        var ws = isW ? ev.score : -ev.score;
        var wm = ev.mate !== null ? (isW ? ev.mate : -ev.mate) : null;

        if (wm !== null) {
            evalEl.textContent = (wm > 0 ? '+' : '') + 'M' + Math.abs(wm);
            evalEl.style.color = wm > 0 ? '#f0f0f0' : '#888';
        } else {
            var cp = ws / 100;
            evalEl.textContent = (cp > 0 ? '+' : '') + cp.toFixed(2);
            evalEl.style.color = cp >= 0.5 ? '#f0f0f0' : cp <= -0.5 ? '#888' : '#aaa';
        }

        depthEl.textContent = 'depth ' + state.depth;

        if (ev.pv) {
            var pvMoves = ev.pv.split(' ').slice(0, 8);
            var temp = new Chess(fen);
            var sanMoves = [];
            for (var i = 0; i < pvMoves.length; i++) {
                var from = pvMoves[i].substring(0, 2);
                var to = pvMoves[i].substring(2, 4);
                var promo = pvMoves[i].length > 4 ? pvMoves[i][4] : undefined;
                var m = temp.move({ from: from, to: to, promotion: promo });
                if (m) {
                    sanMoves.push(m.san);
                } else {
                    break;
                }
            }
            lineEl.textContent = sanMoves.join(' ');
        } else {
            lineEl.textContent = '';
        }
    }

    // ---- Summary ----

    function buildSummary() {
        var panel = document.getElementById('summary-panel');
        var content = document.getElementById('summary-content');
        panel.classList.remove('hidden');

        var wStats = { best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, totalLoss: 0, count: 0 };
        var bStats = { best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0, totalLoss: 0, count: 0 };

        for (var i = 0; i < state.classifications.length; i++) {
            var cls = state.classifications[i];
            var isWhite = i % 2 === 0;
            var stats = isWhite ? wStats : bStats;
            if (cls) stats[cls]++;
            stats.count++;

            if (i < state.evaluations.length - 1) {
                var wb = state.evaluations[i] ? state.evaluations[i].score : 0;
                var wa = state.evaluations[i + 1] ? -state.evaluations[i + 1].score : 0;
                var loss = Math.min(500, Math.max(0, wb - wa));
                stats.totalLoss += loss;
            }
        }

        var wACPL = wStats.count > 0 ? wStats.totalLoss / wStats.count : 0;
        var bACPL = bStats.count > 0 ? bStats.totalLoss / bStats.count : 0;
        var wAcc = computeAccuracy(wACPL);
        var bAcc = computeAccuracy(bACPL);

        var wName = state.headers.White || 'White';
        var bName = state.headers.Black || 'Black';

        function classRow(label, wCount, bCount, color) {
            return '<div class="classification-row">' +
                '<span class="count">' + wCount + '</span>' +
                '<span><span class="classification-dot" style="background:' + color + '"></span>' + label + '</span>' +
                '<span class="count">' + bCount + '</span>' +
                '</div>';
        }

        content.innerHTML =
            '<div class="summary-row">' +
                '<div class="summary-player" style="text-align:center">' +
                    '<div class="summary-player-name">' + wName + '</div>' +
                    '<div class="accuracy-value">' + wAcc.toFixed(1) + '%</div>' +
                    '<div class="accuracy-label">Accuracy</div>' +
                '</div>' +
                '<div class="summary-player" style="text-align:center">' +
                    '<div class="summary-player-name">' + bName + '</div>' +
                    '<div class="accuracy-value">' + bAcc.toFixed(1) + '%</div>' +
                    '<div class="accuracy-label">Accuracy</div>' +
                '</div>' +
            '</div>' +
            '<div>' +
                classRow('Best', wStats.best, bStats.best, 'var(--c-best)') +
                classRow('Excellent', wStats.excellent, bStats.excellent, 'var(--c-excellent)') +
                classRow('Good', wStats.good, bStats.good, 'var(--c-good)') +
                classRow('Inaccuracy', wStats.inaccuracy, bStats.inaccuracy, 'var(--c-inaccuracy)') +
                classRow('Mistake', wStats.mistake, bStats.mistake, 'var(--c-mistake)') +
                classRow('Blunder', wStats.blunder, bStats.blunder, 'var(--c-blunder)') +
            '</div>';
    }

    // ---- Player Bars ----

    function updatePlayerBars() {
        var wName = state.headers.White || 'White';
        var bName = state.headers.Black || 'Black';
        var wElo = state.headers.WhiteElo ? ' (' + state.headers.WhiteElo + ')' : '';
        var bElo = state.headers.BlackElo ? ' (' + state.headers.BlackElo + ')' : '';

        var topBar = document.getElementById(state.flipped ? 'player-bottom' : 'player-top');
        var bottomBar = document.getElementById(state.flipped ? 'player-top' : 'player-bottom');

        topBar.querySelector('.player-name').textContent = bName + bElo;
        bottomBar.querySelector('.player-name').textContent = wName + wElo;
    }

    // ---- Navigation ----

    function goToMove(index) {
        state.currentIndex = Math.max(0, Math.min(index, state.positions.length - 1));
        updateBoard();
        highlightActiveMove();
        updateEvalBar();
        updateEngineInfo();
        drawEvalGraph();
    }

    function goStart() { goToMove(0); }
    function goPrev() { goToMove(state.currentIndex - 1); }
    function goNext() { goToMove(state.currentIndex + 1); }
    function goEnd() { goToMove(state.positions.length - 1); }

    function flipBoard() {
        state.flipped = !state.flipped;
        createBoard();
        updateBoard();
        updatePlayerBars();
    }

    function toggleAutoplay() {
        var btn = document.getElementById('btn-autoplay');
        if (state.autoplayTimer) {
            clearInterval(state.autoplayTimer);
            state.autoplayTimer = null;
            btn.textContent = 'Play';
        } else {
            btn.textContent = 'Stop';
            state.autoplayTimer = setInterval(function () {
                if (state.currentIndex >= state.positions.length - 1) {
                    clearInterval(state.autoplayTimer);
                    state.autoplayTimer = null;
                    btn.textContent = 'Play';
                    return;
                }
                goNext();
            }, 800);
        }
    }

    // ---- Full Analysis ----

    async function runAnalysis() {
        var overlay = document.getElementById('progress-overlay');
        var bar = document.getElementById('progress-bar');
        var text = document.getElementById('progress-text');
        overlay.classList.remove('hidden');

        state.cancelled = false;
        state.analyzing = true;
        state.evaluations = [];
        state.classifications = [];

        text.textContent = 'Loading Stockfish engine...';
        bar.style.width = '0%';

        try {
            var engine = await createEngine();
            state.engine = engine;
        } catch (err) {
            text.textContent = 'Failed to load engine: ' + err.message;
            state.analyzing = false;
            return;
        }

        var total = state.positions.length;

        for (var i = 0; i < total; i++) {
            if (state.cancelled) break;

            var pct = Math.round(((i + 1) / total) * 100);
            bar.style.width = pct + '%';
            text.textContent = 'Analyzing position ' + (i + 1) + ' of ' + total + ' (' + pct + '%)';

            var result = await analyzePosition(engine, state.positions[i], state.depth);
            state.evaluations.push(result);

            if (i > 0) {
                var prev = state.evaluations[i - 1];
                var curr = state.evaluations[i];
                var playedUCI = moveToUCI(state.moves[i - 1]);
                var bestUCI = prev.bestMove || '';
                state.classifications.push(classifyMove(prev, curr, playedUCI, bestUCI));
            }
        }

        state.analyzing = false;

        if (state.engine) {
            state.engine.terminate();
            state.engine = null;
        }

        overlay.classList.add('hidden');

        if (!state.cancelled) {
            buildMoveList();
            buildSummary();
            goToMove(0);
        }
    }

    function cancelAnalysis() {
        state.cancelled = true;
        if (state.engine) {
            stopEngine(state.engine);
            state.engine.terminate();
            state.engine = null;
        }
        document.getElementById('progress-overlay').classList.add('hidden');
        state.analyzing = false;
    }

    // ---- Export ----

    function exportPGN() {
        if (!state.game) return;
        var pgn = state.game.pgn();
        var blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (state.headers.White || 'white') + '_vs_' + (state.headers.Black || 'black') + '.pgn';
        a.click();
        URL.revokeObjectURL(url);
    }

    // ---- Screens ----

    function showAnalysis() {
        document.getElementById('upload-screen').classList.remove('active');
        document.getElementById('analysis-screen').classList.add('active');
    }

    function showUpload() {
        document.getElementById('analysis-screen').classList.remove('active');
        document.getElementById('upload-screen').classList.add('active');

        if (state.autoplayTimer) {
            clearInterval(state.autoplayTimer);
            state.autoplayTimer = null;
        }

        state.game = null;
        state.moves = [];
        state.positions = [];
        state.evaluations = [];
        state.classifications = [];
        state.currentIndex = 0;
        document.getElementById('summary-panel').classList.add('hidden');
    }

    // ---- Start Game ----

    function startAnalysis(pgnText) {
        var errorEl = document.getElementById('upload-error');
        errorEl.textContent = '';

        var game = loadPGN(pgnText);
        if (!game) {
            errorEl.textContent = 'Could not parse PGN. Check your input and try again.';
            return;
        }

        if (game.history().length === 0) {
            errorEl.textContent = 'No moves found in the PGN.';
            return;
        }

        state.game = game;
        var extracted = extractPositions(game);
        state.moves = extracted.moves;
        state.positions = extracted.positions;
        state.headers = extracted.headers;
        state.depth = parseInt(document.getElementById('depth-select').value);

        var info = document.getElementById('game-info');
        var parts = [];
        if (state.headers.Event && state.headers.Event !== '?') parts.push(state.headers.Event);
        if (state.headers.Date) parts.push(state.headers.Date);
        if (state.headers.White) parts.push(state.headers.White + ' vs ' + (state.headers.Black || '?'));
        if (state.headers.Result) parts.push(state.headers.Result);
        info.textContent = parts.join('  |  ');

        showAnalysis();
        createBoard();
        updateBoard();
        updatePlayerBars();
        buildMoveList();
        drawEvalGraph();
        updateEvalBar();
        updateEngineInfo();

        runAnalysis();
    }

    // ---- Graph click ----

    function onGraphClick(e) {
        var canvas = document.getElementById('eval-graph');
        var rect = canvas.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var n = state.positions.length;
        if (n < 2) return;
        var idx = Math.round((x / rect.width) * (n - 1));
        goToMove(idx);
    }

    // ---- Init ----

    function init() {
        var dropZone = document.getElementById('drop-zone');
        var fileInput = document.getElementById('file-input');
        var pgnInput = document.getElementById('pgn-input');
        var analyzeBtn = document.getElementById('analyze-btn');

        dropZone.addEventListener('click', function () { fileInput.click(); });

        dropZone.addEventListener('dragover', function (e) {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });

        dropZone.addEventListener('dragleave', function () {
            dropZone.classList.remove('drag-over');
        });

        dropZone.addEventListener('drop', function (e) {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            var file = e.dataTransfer.files[0];
            if (file) {
                var reader = new FileReader();
                reader.onload = function (ev) {
                    pgnInput.value = ev.target.result;
                };
                reader.readAsText(file);
            }
        });

        fileInput.addEventListener('change', function () {
            if (fileInput.files[0]) {
                var reader = new FileReader();
                reader.onload = function (ev) {
                    pgnInput.value = ev.target.result;
                };
                reader.readAsText(fileInput.files[0]);
            }
        });

        analyzeBtn.addEventListener('click', function () {
            var pgn = pgnInput.value.trim();
            if (!pgn) {
                document.getElementById('upload-error').textContent = 'Please upload a file or paste a PGN.';
                return;
            }
            startAnalysis(pgn);
        });

        document.getElementById('new-game-btn').addEventListener('click', showUpload);
        document.getElementById('export-btn').addEventListener('click', exportPGN);
        document.getElementById('cancel-analysis').addEventListener('click', cancelAnalysis);

        document.getElementById('btn-start').addEventListener('click', goStart);
        document.getElementById('btn-prev').addEventListener('click', goPrev);
        document.getElementById('btn-next').addEventListener('click', goNext);
        document.getElementById('btn-end').addEventListener('click', goEnd);
        document.getElementById('btn-flip').addEventListener('click', flipBoard);
        document.getElementById('btn-autoplay').addEventListener('click', toggleAutoplay);

        document.addEventListener('keydown', function (e) {
            if (document.getElementById('analysis-screen').classList.contains('active')) {
                if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
                if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
                if (e.key === 'Home') { e.preventDefault(); goStart(); }
                if (e.key === 'End') { e.preventDefault(); goEnd(); }
                if (e.key === 'f' || e.key === 'F') { flipBoard(); }
            }
        });

        document.getElementById('eval-graph').addEventListener('click', onGraphClick);

        window.addEventListener('resize', function () {
            if (document.getElementById('analysis-screen').classList.contains('active')) {
                drawEvalGraph();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
