/**
 * omr.js — Pipeline OMR usando OpenCV.js (global `cv`).
 * Pressupõe que cv já foi carregado e inicializado.
 *
 * Fluxo:
 *   detectMarkers → warpToCanonical → sampleBubbles → decideAnswers → gradeAnswers
 *
 * As funções que dependem de geometria (warpToCanonical, refineWithColMarkers,
 * annotateCanvas, runOMR) recebem `layoutMod` — o módulo de layout a usar.
 * Isso suporta tanto o layout completo (layout.js) quanto o compacto (layout-compact.js).
 */

import {
  BLUR_K, ADAPT_BLOCK, ADAPT_C,
  FILL_MIN, MARGIN_MIN, ROI_FACTOR,
} from './layout.js?v=19';

// ─── Utilitários internos ─────────────────────────────────────────────────────

function releaseMats(...mats) {
  for (const m of mats) { try { if (m && !m.isDeleted()) m.delete(); } catch (_) {} }
}

export function sharpness(grayMat) {
  const lap  = new cv.Mat();
  const mean = new cv.Mat();
  const std  = new cv.Mat();
  cv.Laplacian(grayMat, lap, cv.CV_64F);
  cv.meanStdDev(lap, mean, std);
  const v = std.doubleAt(0, 0) ** 2;
  releaseMats(lap, mean, std);
  return v;
}

// ─── Detecção de marcadores ───────────────────────────────────────────────────

/**
 * Detecta os 4 marcadores fiduciais em `grayMat`.
 * Funciona para qualquer layout (não depende de geometria específica).
 */
export function detectMarkers(grayMat) {
  const blurred  = new cv.Mat();
  const binary   = new cv.Mat();
  const contours = new cv.MatVector();
  const hier     = new cv.Mat();

  cv.GaussianBlur(grayMat, blurred, new cv.Size(BLUR_K, BLUR_K), 0);
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
  cv.findContours(binary, contours, hier, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

  const imgArea = grayMat.cols * grayMat.rows;
  const minArea = imgArea * 0.0001;
  const maxArea = imgArea * 0.04;

  const candidates = [];

  for (let i = 0; i < contours.size(); i++) {
    const cnt  = contours.get(i);
    const area = cv.contourArea(cnt);

    if (area < minArea || area > maxArea) { cnt.delete(); continue; }

    const peri   = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.05 * peri, true);

    if (approx.rows === 4) {
      const rect   = cv.boundingRect(approx);
      const aspect = rect.width / rect.height;

      if (aspect > 0.6 && aspect < 1.6) {
        const M        = cv.moments(cnt);
        const cx       = M.m00 !== 0 ? M.m10 / M.m00 : rect.x + rect.width / 2;
        const cy       = M.m00 !== 0 ? M.m01 / M.m00 : rect.y + rect.height / 2;
        const h        = hier.intPtr(0, i);
        const hasChild = h[2] >= 0;
        candidates.push({ cx, cy, area, hasChild });
      }
    }
    approx.delete();
    cnt.delete();
  }

  releaseMats(blurred, binary, hier);
  contours.delete();

  return identifyMarkers(candidates, grayMat.cols, grayMat.rows);
}

function checkGroupAsMarkers(group, imgW, imgH) {
  const areas = group.map(c => c.area);
  if (Math.max(...areas) / Math.min(...areas) > 4) return null;

  const anchors = group.filter(c => c.hasChild);
  // Exige exatamente 1 âncora (marcador BR com furo branco).
  // 0 âncoras → grupo de elementos do ambiente ou marcadores de coluna → rejeitar.
  // 2+ âncoras → bolhas vazias ou padrões QR → rejeitar.
  if (anchors.length !== 1) return null;

  const mcx = group.reduce((s, c) => s + c.cx, 0) / 4;
  const mcy = group.reduce((s, c) => s + c.cy, 0) / 4;

  const tls = group.filter(c => c.cx <= mcx && c.cy <= mcy);
  const trs = group.filter(c => c.cx >  mcx && c.cy <= mcy);
  const bls = group.filter(c => c.cx <= mcx && c.cy >  mcy);
  const brs = group.filter(c => c.cx >  mcx && c.cy >  mcy);

  if (tls.length !== 1 || trs.length !== 1 || bls.length !== 1 || brs.length !== 1) return null;

  let tl = tls[0], tr = trs[0], bl = bls[0], br = brs[0];

  if (anchors.length === 1) {
    const anchor = anchors[0];
    const rots = [
      { tl, tr, bl, br },
      { tl: bl, tr: tl, bl: br, br: tr },
      { tl: br, tr: bl, bl: tr, br: tl },
      { tl: tr, tr: br, bl: tl, br: bl },
    ];
    const correct = rots.find(r => r.br === anchor);
    if (correct) { tl = correct.tl; tr = correct.tr; bl = correct.bl; br = correct.br; }
  }

  const topW   = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy);
  const botW   = Math.hypot(br.cx - bl.cx, br.cy - bl.cy);
  const leftH  = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy);
  const rightH = Math.hypot(br.cx - tr.cx, br.cy - tr.cy);
  const width  = (topW + botW) / 2;
  const height = (leftH + rightH) / 2;
  if (width <= 0 || height <= 0) return null;

  // Aceita portrait e landscape: lado menor / lado maior ≥ 0.30
  // (compacto tem proporção ~0.45, portrait tem ~0.71)
  const ratio = Math.min(width, height) / Math.max(width, height);
  if (ratio < 0.30) return null;

  const imgDiag  = Math.hypot(imgW, imgH);
  const quadDiag = Math.hypot(br.cx - tl.cx, br.cy - tl.cy);
  if (quadDiag < imgDiag * 0.25) return null;  // reduzido de 0.30 → cartão compacto cabe em menos espaço

  return {
    tl: [tl.cx, tl.cy],
    tr: [tr.cx, tr.cy],
    bl: [bl.cx, bl.cy],
    br: [br.cx, br.cy],
  };
}

function identifyMarkers(candidates, imgW, imgH) {
  if (candidates.length < 4) return null;

  candidates.sort((a, b) => a.area - b.area);
  const limit = Math.min(candidates.length, 15);

  for (let i = 0; i < limit - 3; i++) {
    const areaI = candidates[i].area;
    const maxAllowed = areaI * 4;
    for (let j = i + 1; j < limit - 2; j++) {
      if (candidates[j].area > maxAllowed) break;
      for (let k = j + 1; k < limit - 1; k++) {
        if (candidates[k].area > maxAllowed) break;
        for (let l = k + 1; l < limit; l++) {
          if (candidates[l].area > maxAllowed) break;
          const result = checkGroupAsMarkers(
            [candidates[i], candidates[j], candidates[k], candidates[l]],
            imgW, imgH,
          );
          if (result) return result;
        }
      }
    }
  }

  return null;
}

// ─── Homografia e warp ────────────────────────────────────────────────────────

/**
 * Aplica warpPerspective para transformar a imagem no espaço canônico do layout.
 *
 * @param {cv.Mat}   srcMat   imagem colorida (full-res)
 * @param {object}   markers  { tl, tr, bl, br } detectados
 * @param {object}   layoutMod módulo de layout (layout.js ou layout-compact.js)
 */
export function warpToCanonical(srcMat, markers, layoutMod, canonW, canonH) {
  const dst = layoutMod.getMarkerPositions(canonW, canonH);

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    ...markers.tl, ...markers.tr, ...markers.bl, ...markers.br,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    ...dst.tl, ...dst.tr, ...dst.bl, ...dst.br,
  ]);

  const M      = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();
  cv.warpPerspective(srcMat, warped, M, new cv.Size(canonW, canonH));

  releaseMats(srcPts, dstPts, M);
  return warped;
}

// ─── Binarização e amostragem ─────────────────────────────────────────────────

export function binarize(grayCanon) {
  const blurred = new cv.Mat();
  const binary  = new cv.Mat();

  cv.GaussianBlur(grayCanon, blurred, new cv.Size(BLUR_K, BLUR_K), 0);
  cv.adaptiveThreshold(
    blurred, binary, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY_INV,
    ADAPT_BLOCK, ADAPT_C,
  );

  releaseMats(blurred);
  return binary;
}

export function sampleBubbles(binaryCanon, questions) {
  const results = [];

  for (const q of questions) {
    const ratios = q.bubbles.map((b) => {
      const roi = computeROI(b.x, b.y, b.r, binaryCanon.cols, binaryCanon.rows);
      if (!roi) return 0;

      const { x, y, w, h } = roi;
      const rect   = new cv.Rect(x, y, w, h);
      const patch  = binaryCanon.roi(rect);
      const total  = w * h;
      const filled = cv.countNonZero(patch);
      patch.delete();

      return total > 0 ? filled / total : 0;
    });

    results.push({ q: q.n, ratios });
  }

  return results;
}

function computeROI(cx, cy, r, imgW, imgH) {
  const half = Math.ceil(r * ROI_FACTOR);
  const x    = Math.max(0, Math.round(cx - half));
  const y    = Math.max(0, Math.round(cy - half));
  const x2   = Math.min(imgW, Math.round(cx + half));
  const y2   = Math.min(imgH, Math.round(cy + half));
  const w    = x2 - x;
  const h    = y2 - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

// ─── Calibração local por marcadores de coluna ───────────────────────────────

function findColMarkerCenter(binaryCanon, cx, cy, searchR, colMarkerSize) {
  const x1 = Math.max(0, Math.round(cx - searchR));
  const y1 = Math.max(0, Math.round(cy - searchR));
  const w  = Math.min(binaryCanon.cols - x1, Math.round(searchR * 2));
  const h  = Math.min(binaryCanon.rows - y1, Math.round(searchR * 2));
  if (w <= 0 || h <= 0) return null;

  const roi      = binaryCanon.roi(new cv.Rect(x1, y1, w, h));
  const white    = cv.countNonZero(roi);
  const minWhite = colMarkerSize * colMarkerSize * 0.25;
  if (white < minWhite) { roi.delete(); return null; }

  const M = cv.moments(roi, true);
  roi.delete();
  if (M.m00 === 0) return null;

  return [x1 + M.m10 / M.m00, y1 + M.m01 / M.m00];
}

/**
 * Calibra posições Y das bolhas usando marcadores de coluna detectados.
 *
 * @param {cv.Mat} binaryCanon
 * @param {Array}  questions    (modificado in-place)
 * @param {number} n
 * @param {number} opt
 * @param {object} layoutMod
 */
export function refineWithColMarkers(binaryCanon, questions, n, opt, layoutMod) {
  const colData   = layoutMod.getColMarkerPositions(n, opt);
  const perCol    = Math.ceil(n / colData.length);
  const CMS       = layoutMod.COL_MARKER_SIZE;
  const CMG       = layoutMod.COL_MARKER_GAP;
  const ROW_H_L   = layoutMod.ROW_H;
  const SEARCH    = 22;

  let calibrated = 0;

  for (const { col, top, bot, qInCol } of colData) {
    const topFound = findColMarkerCenter(binaryCanon, top[0], top[1], SEARCH, CMS);
    const botFound = findColMarkerCenter(binaryCanon, bot[0], bot[1], SEARCH, CMS);

    if (!topFound || !botFound) continue;

    const calibFirstY = topFound[1] + CMS / 2 + CMG + ROW_H_L / 2;
    const calibLastY  = botFound[1] - CMS / 2 - CMG - ROW_H_L / 2;
    const spacing     = qInCol > 1 ? (calibLastY - calibFirstY) / (qInCol - 1) : ROW_H_L;

    const qStart = col * perCol;
    for (let r = 0; r < qInCol; r++) {
      const qi = qStart + r;
      if (qi >= questions.length) break;
      const newY = calibFirstY + r * spacing;
      questions[qi].labelY = newY;
      questions[qi].bubbles.forEach(b => { b.y = newY; });
    }

    calibrated++;
    console.log(
      `[OMR] Col${col}: topY=${topFound[1].toFixed(1)} botY=${botFound[1].toFixed(1)}` +
      ` spacing=${spacing.toFixed(1)} (nominal: ${ROW_H_L})`,
    );
  }

  if (calibrated === 0) {
    console.warn('[OMR] Marcadores de coluna não encontrados — usando coordenadas canônicas.');
  }
}

// ─── Decisão por questão ──────────────────────────────────────────────────────

export function decideAnswers(samples, opt) {
  samples.slice(0, 3).forEach(({ q, ratios }) => {
    console.log(`[OMR] Q${q} fillRatios:`, ratios.map(r => r.toFixed(3)).join(' '));
  });

  const letters = 'ABCDE'.slice(0, opt);

  return samples.map(({ q, ratios }) => {
    const indexed = ratios.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);
    const max     = indexed[0].r;
    const second  = indexed.length > 1 ? indexed[1].r : 0;
    const marked  = ratios.map((r, i) => ({ r, i })).filter(x => x.r >= FILL_MIN);

    let status, markedStr;

    if (marked.length === 0) {
      status    = max < FILL_MIN * 0.7 ? 'blank' : 'low_conf';
      markedStr = null;
    } else if (marked.length > 1) {
      status    = 'multi';
      markedStr = marked.map(x => letters[x.i]).join('');
    } else if (max >= FILL_MIN && (max - second) >= MARGIN_MIN) {
      status    = 'ok';
      markedStr = letters[indexed[0].i];
    } else {
      status    = 'low_conf';
      markedStr = letters[indexed[0].i];
    }

    return { q, marked: markedStr, status, ratios };
  });
}

// ─── Correção contra gabarito ─────────────────────────────────────────────────

export function gradeAnswers(decisions, key, examId, student = '') {
  const answers = decisions.map(({ q, marked, status, ratios }) => {
    const correct = key[q - 1] ? key[q - 1].toUpperCase() : '?';
    const right   = status === 'ok' && marked === correct;
    return { q, marked, correct, status, right, ratios };
  });

  const score = answers.filter(a => a.right).length;
  const total = answers.length;

  return {
    examId,
    student,
    score,
    total,
    pct: total > 0 ? Math.round((score / total) * 100) : 0,
    answers,
    capturedAt: new Date().toISOString(),
  };
}

// ─── Anotação visual ──────────────────────────────────────────────────────────

function annotateCanvas(warpedColor, questions, answers, canonW, canonH) {
  const annotated = warpedColor.clone();

  answers.forEach((ans) => {
    const q = questions.find(q => q.n === ans.q);
    if (!q) return;

    q.bubbles.forEach((b) => {
      const isMarked = ans.marked && ans.marked.includes(b.label);
      if (!isMarked) return;

      let color;
      if (ans.right) {
        color = new cv.Scalar(0, 200, 0, 255);
      } else if (ans.status === 'blank') {
        color = new cv.Scalar(150, 150, 150, 255);
      } else {
        color = new cv.Scalar(220, 50, 50, 255);
      }

      cv.circle(annotated, new cv.Point(Math.round(b.x), Math.round(b.y)), Math.round(b.r + 4), color, 3);
    });

    const correctBubble = q.bubbles.find(b => b.label === ans.correct);
    if (correctBubble && !ans.right) {
      cv.circle(
        annotated,
        new cv.Point(Math.round(correctBubble.x), Math.round(correctBubble.y)),
        Math.round(correctBubble.r + 4),
        new cv.Scalar(0, 180, 0, 180), 1,
      );
    }
  });

  const canvas = document.createElement('canvas');
  canvas.width  = canonW;
  canvas.height = canonH;
  cv.imshow(canvas, annotated);
  releaseMats(annotated);
  return canvas;
}

// ─── Pipeline completo ────────────────────────────────────────────────────────

/**
 * Roda o pipeline OMR completo.
 *
 * @param {HTMLCanvasElement|ImageData} source   imagem capturada
 * @param {{ id, n, opt, k, layout }}   exam     configuração da prova
 * @param {string}                      student  nome do aluno
 * @param {object}                      layoutMod módulo de layout (layout.js ou layout-compact.js)
 * @returns {{ result, canonCanvas, error }}
 */
export function runOMR(source, exam, student = '', layoutMod) {
  let srcMat, grayMat, warpedColor, grayCanon, binary;

  try {
    // 1. Carregar imagem
    if (source instanceof HTMLCanvasElement) {
      srcMat = cv.imread(source);
    } else {
      srcMat = cv.matFromImageData(source);
    }

    // 2. Escala de cinza
    grayMat = new cv.Mat();
    cv.cvtColor(srcMat, grayMat, cv.COLOR_RGBA2GRAY);

    // 3. Detectar marcadores
    const markers = detectMarkers(grayMat);
    if (!markers) {
      releaseMats(srcMat, grayMat);
      return { result: null, canonCanvas: null, error: 'Marcadores não encontrados. Enquadre melhor o cartão.' };
    }

    // 4. Warp para espaço canônico do layout (largura adaptativa se disponível)
    const canonW = layoutMod.getCanonW ? layoutMod.getCanonW(exam.n, exam.opt) : layoutMod.CANON_W;
    const canonH = layoutMod.CANON_H;
    warpedColor = warpToCanonical(srcMat, markers, layoutMod, canonW, canonH);

    // 5. Cinza canônico
    grayCanon = new cv.Mat();
    cv.cvtColor(warpedColor, grayCanon, cv.COLOR_RGBA2GRAY);

    // 6. Binarização
    binary = binarize(grayCanon);

    // 7. Coordenadas das bolhas
    const questions = layoutMod.getBubbleCoords(exam.n, exam.opt);

    // 7b. Calibração local com marcadores de coluna
    refineWithColMarkers(binary, questions, exam.n, exam.opt, layoutMod);

    // 8. Amostrar bolhas
    const samples = sampleBubbles(binary, questions);

    // 9. Decisão por questão
    const decisions = decideAnswers(samples, exam.opt);

    // 10. Correção
    const result = gradeAnswers(decisions, exam.k, exam.id, student);

    // 11. Canvas anotado
    const canonCanvas = annotateCanvas(warpedColor, questions, result.answers, canonW, canonH);

    releaseMats(srcMat, grayMat, warpedColor, grayCanon, binary);
    return { result, canonCanvas, error: null };

  } catch (err) {
    releaseMats(srcMat, grayMat, warpedColor, grayCanon, binary);
    return { result: null, canonCanvas: null, error: `Erro no pipeline: ${err.message}` };
  }
}

// ─── Detecção ao vivo (quality gate) ─────────────────────────────────────────

/**
 * Analisa um frame para o quality gate (não depende de layout).
 */
export function analyzeFrame(frameData) {
  let mat, gray;
  try {
    mat  = cv.matFromImageData(frameData);
    gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    const markers  = detectMarkers(gray);
    const sharpVal = sharpness(gray);
    const sharpOk  = sharpVal > 80;

    let quadOk = false;
    if (markers) {
      const margin = frameData.width * 0.05;
      const pts    = [markers.tl, markers.tr, markers.bl, markers.br];
      quadOk = pts.every(([x, y]) =>
        x > margin && x < frameData.width  - margin &&
        y > margin && y < frameData.height - margin,
      );
    }

    releaseMats(mat, gray);
    return { markersFound: !!markers, quadOk, sharpOk, sharpVal, markers };
  } catch (_) {
    releaseMats(mat, gray);
    return { markersFound: false, quadOk: false, sharpOk: false, sharpVal: 0, markers: null };
  }
}
