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
} from './layout.js?v=38';

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
export function detectMarkers(grayMat, debug = false) {
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
      // Solidez = área preenchida / área do bounding box. Um marcador é um quadrado
      // SÓLIDO → ~1.0. Bolhas vazias (anéis) e rabiscos têm solidez baixa → filtrados.
      // É o que distingue marcador de bolha quando têm tamanhos parecidos (compacto).
      const solidity = area / (rect.width * rect.height);

      if (aspect > 0.6 && aspect < 1.6 && solidity > 0.80) {
        const M  = cv.moments(cnt);
        const cx = M.m00 !== 0 ? M.m10 / M.m00 : rect.x + rect.width / 2;
        const cy = M.m00 !== 0 ? M.m01 / M.m00 : rect.y + rect.height / 2;
        const h  = hier.intPtr(0, i);

        // hasChild só vale como ÂNCORA se o furo for pequeno e centrado (~16% da área).
        // Bolha vazia é um ANEL: seu "furo" interno é grande (>35%) → NÃO é âncora.
        let hasChild = false;
        if (h[2] >= 0) {
          const child     = contours.get(h[2]);
          const childArea = cv.contourArea(child);
          child.delete();
          hasChild = childArea > area * 0.02 && childArea < area * 0.35;
        }
        candidates.push({ cx, cy, area, hasChild });
      }
    }
    approx.delete();
    cnt.delete();
  }

  releaseMats(blurred, binary, hier);
  contours.delete();

  if (debug) {
    const nAnchor = candidates.filter(c => c.hasChild).length;
    console.log(`[OMR] detectMarkers: ${candidates.length} candidatos sólidos (${nAnchor} com furo).`);
  }

  return identifyMarkers(candidates, grayMat.cols, grayMat.rows);
}

/**
 * Orienta 4 candidatos por posição extrema, assumindo o cartão aproximadamente
 * na vertical: TL=min(x+y) · BR=max(x+y) · TR=max(x−y) · BL=min(x−y).
 * Retorna { tl, tr, bl, br } ou null se os extremos coincidirem (quad degenerado).
 */
function orientByExtremes(group) {
  let tl, tr, bl, br;
  let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
  for (const c of group) {
    const s = c.cx + c.cy, d = c.cx - c.cy;
    if (s < minS) { minS = s; tl = c; }
    if (s > maxS) { maxS = s; br = c; }
    if (d > maxD) { maxD = d; tr = c; }
    if (d < minD) { minD = d; bl = c; }
  }
  if (new Set([tl, tr, bl, br]).size !== 4) return null;
  return { tl, tr, bl, br };
}

/**
 * Valida um grupo de 4 candidatos como os marcadores de canto (apenas GEOMETRIA).
 *
 * A orientação aqui é só provisória, por extremos — a orientação FINAL (qual canto
 * é o BR) é decidida depois do warp, pelo furo da âncora (detectAnchorCornerInWarp),
 * que é robusto a rotação. Por isso a seleção NÃO depende da âncora: assim âncoras
 * falsas (bolhas com furo) não atrapalham a escolha dos 4 cantos.
 *
 * Retorna { tl, tr, bl, br } (coords) ou null.
 */
function validateGroup(group, imgW, imgH) {
  if (group.length !== 4) return null;

  const areas = group.map(c => c.area);
  // Os 4 marcadores de canto têm tamanho semelhante. Se a razão for grande,
  // o grupo misturou um marcador de canto com algo menor (coluna/ruído) → rejeita.
  if (Math.max(...areas) / Math.min(...areas) > 4) return null;

  // Orientação provisória por extremos.
  const o = orientByExtremes(group);
  if (!o) return null;
  const { tl, tr, bl, br } = o;

  // Rejeita grupos COLINEARES/degenerados: o bounding box dos 4 pontos precisa ter
  // os dois lados comparáveis. (4 pontos numa linha — ex.: bolhas de uma fileira —
  // enganavam o check de proporção baseado em papéis e produziam warp espremido.)
  const xs = [tl.cx, tr.cx, bl.cx, br.cx];
  const ys = [tl.cy, tr.cy, bl.cy, br.cy];
  const bbW = Math.max(...xs) - Math.min(...xs);
  const bbH = Math.max(...ys) - Math.min(...ys);
  if (bbW <= 0 || bbH <= 0) return null;
  if (Math.min(bbW, bbH) / Math.max(bbW, bbH) < 0.30) return null;

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
  if (quadDiag < imgDiag * 0.25) return null;  // o quad deve cobrir boa parte da imagem

  return {
    tl: [tl.cx, tl.cy],
    tr: [tr.cx, tr.cy],
    bl: [bl.cx, bl.cy],
    br: [br.cx, br.cy],
  };
}

/**
 * Seleciona os 4 candidatos nos EXTREMOS da nuvem de pontos:
 *   TL = min(x+y) · BR = max(x+y) · TR = max(x−y) · BL = min(x−y)
 *
 * Os marcadores de canto são sempre os pontos extremos do cartão; os marcadores
 * de coluna, as bolhas e o ruído interno ficam "para dentro" e são ignorados
 * automaticamente. É o que permite usar marcadores de coluna sem confundir o warp.
 */
function selectByExtremes(candidates) {
  let tl, tr, bl, br;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;

  for (const c of candidates) {
    const sum  = c.cx + c.cy;
    const diff = c.cx - c.cy;
    if (sum  < minSum)  { minSum  = sum;  tl = c; }
    if (sum  > maxSum)  { maxSum  = sum;  br = c; }
    if (diff > maxDiff) { maxDiff = diff; tr = c; }
    if (diff < minDiff) { minDiff = diff; bl = c; }
  }

  const group = [tl, tr, bl, br];
  if (new Set(group).size !== 4) return null;   // candidatos extremos coincidentes
  return group;
}

/**
 * Força-bruta: testa todas as combinações de 4 dentro de `list` (até 16 itens).
 * Retorna o primeiro grupo válido ou null.
 */
function bruteForceGroups(list, imgW, imgH) {
  const limit = Math.min(list.length, 16);   // C(16,4)=1820 combinações — barato
  for (let i = 0; i < limit - 3; i++) {
    for (let j = i + 1; j < limit - 2; j++) {
      for (let k = j + 1; k < limit - 1; k++) {
        for (let l = k + 1; l < limit; l++) {
          const result = validateGroup([list[i], list[j], list[k], list[l]], imgW, imgH);
          if (result) return result;
        }
      }
    }
  }
  return null;
}

/**
 * Identifica os 4 marcadores de canto.
 *
 *   1) PRIMÁRIO — EXTREMOS sobre todos os candidatos: como o cartão ocupa quase
 *      todo o quadro, os 4 marcadores de canto são os pontos extremos da nuvem.
 *      É a forma mais direta e estável de pegar os cantos, e não depende da âncora
 *      (que pode ter falsos positivos entre bolhas).
 *
 *   2) FALLBACK — ancorado na âncora: filtra candidatos do tamanho da âncora e
 *      busca entre eles (útil quando o cartão não preenche o quadro).
 *
 *   3) FALLBACK — força-bruta sobre os maiores quadrados.
 */
function identifyMarkers(candidates, imgW, imgH) {
  if (candidates.length < 4) return null;

  // 1) Extremos — primário (cartão preenche o quadro → cantos são os extremos).
  const extreme = selectByExtremes(candidates);
  if (extreme) {
    const result = validateGroup(extreme, imgW, imgH);
    if (result) return result;
  }

  // 2) Ancorado na âncora.
  const anchors = candidates.filter(c => c.hasChild);
  for (const anchor of anchors) {
    const lo = anchor.area / 4, hi = anchor.area * 4;
    const similar = candidates.filter(c => c.area >= lo && c.area <= hi);
    const found = bruteForceGroups(similar, imgW, imgH);
    if (found) return found;
  }

  // 3) Força-bruta sobre os maiores quadrados.
  const sorted = [...candidates].sort((a, b) => b.area - a.area);
  return bruteForceGroups(sorted, imgW, imgH);
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

/**
 * Detecta a BORDA retangular do cartão (o quadrilátero impresso ao redor das
 * questões) e devolve seus 4 cantos, atribuídos aos papéis tl/tr/bl/br pela
 * proximidade aos marcadores já validados.
 *
 * A borda dá cantos muito mais precisos e distantes que os centros dos 4
 * marcadores pequenos → warp muito mais estável (menos inclinação).
 *
 * Ancorado nos marcadores: aceita apenas o quad cujos 4 cantos ABRAÇAM os
 * marcadores (cada canto a ≤20% da diagonal dos marcadores do seu marcador).
 * Isso rejeita a borda da página/mesa e quads espúrios (cantos distantes), e
 * faz cada canto herdar o papel (tl/tr/bl/br) do marcador correspondente.
 * Se nenhum quad casar com folga apertada, retorna null → warp pelos marcadores.
 *
 * @returns {{tl,tr,bl,br}|null}  cantos em coordenadas de imagem, ou null.
 */
function detectCardBorder(grayMat, markers) {
  const blurred  = new cv.Mat();
  const binary   = new cv.Mat();
  const contours = new cv.MatVector();
  const hier     = new cv.Mat();

  cv.GaussianBlur(grayMat, blurred, new cv.Size(BLUR_K, BLUR_K), 0);
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
  cv.findContours(binary, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const imgArea = grayMat.cols * grayMat.rows;
  const roles   = ['tl', 'tr', 'bl', 'br'];
  const mx = roles.map(r => markers[r][0]);
  const my = roles.map(r => markers[r][1]);
  const markerDiag = Math.hypot(Math.max(...mx) - Math.min(...mx), Math.max(...my) - Math.min(...my));

  // Cada canto da borda deve "abraçar" seu marcador: ficar bem próximo dele.
  // A borda do cartão fica a poucos % de distância dos marcadores; a página/mesa
  // (ou um quad espúrio) tem cantos muito mais distantes → rejeitado.
  const maxCornerDist = markerDiag * 0.20;

  let bestAssign = null, bestScore = Infinity;

  for (let i = 0; i < contours.size(); i++) {
    const cnt  = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < imgArea * 0.03) { cnt.delete(); continue; }

    const peri   = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const pts = [];
      for (let p = 0; p < 4; p++) {
        const ptr = approx.intPtr(p, 0);
        pts.push({ x: ptr[0], y: ptr[1] });
      }

      // Casa cada papel de marcador com o canto mais próximo (1-para-1).
      const used = new Set();
      const assign = {};
      let score = 0, ok = true;
      for (let r = 0; r < 4; r++) {
        let bi = -1, bd = Infinity;
        for (let k = 0; k < 4; k++) {
          if (used.has(k)) continue;
          const d = Math.hypot(pts[k].x - mx[r], pts[k].y - my[r]);
          if (d < bd) { bd = d; bi = k; }
        }
        if (bd > maxCornerDist) { ok = false; break; }
        used.add(bi);
        assign[roles[r]] = pts[bi];
        score += bd;
      }

      if (ok && score < bestScore) { bestScore = score; bestAssign = assign; }
    }
    approx.delete();
    cnt.delete();
  }

  releaseMats(blurred, binary, hier);
  contours.delete();
  if (!bestAssign) return null;

  return {
    tl: [bestAssign.tl.x, bestAssign.tl.y],
    tr: [bestAssign.tr.x, bestAssign.tr.y],
    bl: [bestAssign.bl.x, bestAssign.bl.y],
    br: [bestAssign.br.x, bestAssign.br.y],
  };
}

/**
 * Warp usando os 4 cantos da BORDA do cartão → retângulo canônico completo
 * (0,0)–(canonW,canonH). A borda impressa fica rente à borda do espaço canônico,
 * então as bolhas (em coordenadas canônicas) caem exatamente no lugar.
 */
export function warpByBorder(srcMat, border, canonW, canonH) {
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    ...border.tl, ...border.tr, ...border.bl, ...border.br,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,  canonW, 0,  0, canonH,  canonW, canonH,
  ]);

  const M      = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();
  cv.warpPerspective(srcMat, warped, M, new cv.Size(canonW, canonH));

  releaseMats(srcPts, dstPts, M);
  return warped;
}

/**
 * Determina a orientação correta DEPOIS do warp, pelo furo da âncora.
 *
 * No espaço canônico o marcador-âncora tem ~32px com um furo branco de ~13px —
 * grande e nítido (ao contrário do frame original, onde o furo some). Amostra o
 * CENTRO dos 4 cantos: a âncora é o de centro mais claro (furo). Devolve o canto
 * onde a âncora caiu ('tl'|'tr'|'bl'|'br'), ou null se ambíguo.
 */
function detectAnchorCornerInWarp(grayCanon, layoutMod, canonW, canonH) {
  const pos = layoutMod.getMarkerPositions(canonW, canonH);
  const r   = Math.max(3, Math.round(canonW * 0.006));

  const sampleCenter = ([cx, cy]) => {
    const x = Math.max(0, Math.round(cx - r));
    const y = Math.max(0, Math.round(cy - r));
    const w = Math.min(grayCanon.cols - x, 2 * r);
    const h = Math.min(grayCanon.rows - y, 2 * r);
    if (w <= 0 || h <= 0) return 0;
    const roi = grayCanon.roi(new cv.Rect(x, y, w, h));
    const m   = cv.mean(roi)[0];
    roi.delete();
    return m;
  };

  const vals = {
    tl: sampleCenter(pos.tl), tr: sampleCenter(pos.tr),
    bl: sampleCenter(pos.bl), br: sampleCenter(pos.br),
  };
  const keys = ['tl', 'tr', 'bl', 'br'].sort((a, b) => vals[b] - vals[a]);
  // O furo (branco) deve ser claramente mais brilhante que o 2º canto mais claro.
  if (vals[keys[0]] - vals[keys[1]] < 40) return null;
  return keys[0];
}

/**
 * Reatribui os papéis tl/tr/bl/br a 4 pontos sabendo qual é a âncora (= BR),
 * pelo método invariante a rotação (TL = mais distante; TR/BL pela diagonal).
 * @param {Array<[number,number]>} pts
 * @param {[number,number]}        anchor  um dos pontos de pts
 */
function orientByAnchorPoint(pts, anchor) {
  const br = anchor;
  const others = pts.filter(p => p !== anchor);
  let tl = others[0], maxD = -1;
  for (const p of others) {
    const d = Math.hypot(p[0] - br[0], p[1] - br[1]);
    if (d > maxD) { maxD = d; tl = p; }
  }
  const rest = others.filter(p => p !== tl);
  const dx = br[0] - tl[0], dy = br[1] - tl[1];
  const cross = p => dx * (p[1] - tl[1]) - dy * (p[0] - tl[0]);
  let tr, bl;
  if (cross(rest[0]) < 0) { tr = rest[0]; bl = rest[1]; }
  else                    { tr = rest[1]; bl = rest[0]; }
  return { tl, tr, bl, br };
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

    // Trava de sanidade: se o espaçamento calibrado destoar muito do nominal
    // (±30%), é quase certo um falso positivo (texto, borda, bolha) — ignora a
    // calibração desta coluna e mantém as coordenadas canônicas.
    if (spacing < ROW_H_L * 0.7 || spacing > ROW_H_L * 1.3) {
      console.warn(`[OMR] Col${col}: calibração descartada (spacing=${spacing.toFixed(1)}, nominal=${ROW_H_L}).`);
      continue;
    }

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
    const markers = detectMarkers(grayMat, true);
    if (!markers) {
      releaseMats(srcMat, grayMat);
      return { result: null, canonCanvas: null, error: 'Marcadores não encontrados. Enquadre melhor o cartão.' };
    }
    console.log('[OMR] Marcadores (img):',
      'tl', markers.tl.map(Math.round), 'tr', markers.tr.map(Math.round),
      'bl', markers.bl.map(Math.round), 'br', markers.br.map(Math.round));

    // 4. Warp para espaço canônico do layout (largura adaptativa se disponível)
    const canonW = layoutMod.getCanonW ? layoutMod.getCanonW(exam.n, exam.opt) : layoutMod.CANON_W;
    const canonH = layoutMod.CANON_H;

    // Aplica o warp com uma dada orientação de marcadores. Prefere a BORDA do
    // cartão (cantos precisos → warp estável) nos layouts com borda nítida (compacto);
    // a página inteira usa sempre os centros dos 4 marcadores.
    const doWarp = (mk) => {
      if (layoutMod.USE_BORDER_WARP) {
        const b = detectCardBorder(grayMat, mk);
        if (b) { console.log('[OMR] Warp pela BORDA do cartão.'); return warpByBorder(srcMat, b, canonW, canonH); }
        console.warn('[OMR] Borda NÃO casou com os marcadores → warp pelos marcadores.');
      }
      return warpToCanonical(srcMat, mk, layoutMod, canonW, canonH);
    };

    // Warp provisório (orientação inicial dos marcadores).
    warpedColor = doWarp(markers);

    // Confirma a orientação pelo furo da âncora NO ESPAÇO RETIFICADO (onde o furo
    // é grande e nítido). Se a âncora não caiu no canto BR, corrige e refaz o warp.
    // É isso que elimina o cartão sair de cabeça pra baixo / espelhado.
    let gOrient = new cv.Mat();
    cv.cvtColor(warpedColor, gOrient, cv.COLOR_RGBA2GRAY);
    const holeCorner = detectAnchorCornerInWarp(gOrient, layoutMod, canonW, canonH);
    gOrient.delete();

    if (holeCorner && holeCorner !== 'br') {
      console.log(`[OMR] Âncora detectada no canto ${holeCorner} → corrigindo orientação e refazendo o warp.`);
      const pts   = [markers.tl, markers.tr, markers.bl, markers.br];
      const fixed = orientByAnchorPoint(pts, markers[holeCorner]);
      releaseMats(warpedColor);
      warpedColor = doWarp(fixed);
    }

    // 5. Cinza canônico
    grayCanon = new cv.Mat();
    cv.cvtColor(warpedColor, grayCanon, cv.COLOR_RGBA2GRAY);

    // 6. Binarização
    binary = binarize(grayCanon);

    // 7. Coordenadas das bolhas
    const questions = layoutMod.getBubbleCoords(exam.n, exam.opt);

    // 7b. Calibração local com marcadores de coluna (só se o layout os imprime).
    // O compacto não desenha marcadores de coluna → calibrar contra eles
    // produziria falsos positivos e desalinharia as bolhas.
    if (layoutMod.HAS_COL_MARKERS) {
      refineWithColMarkers(binary, questions, exam.n, exam.opt, layoutMod);
    }

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
