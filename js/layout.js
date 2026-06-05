/**
 * layout.js — Fonte única de verdade do layout canônico.
 * Usado pelo gerador (generator.js) e pelo corretor (omr.js).
 * Nunca duplicar estas constantes em outro arquivo.
 */

// === Espaço canônico (proporção A4 retrato ≈ 1:1.414) ===
export const CANON_W = 1000;
export const CANON_H = 1414;
export const MARGIN = 60;

// === Marcadores fiduciais ===
export const MARKER_SIZE = 40;
export const MARKER_INSET = 36;  // distância da borda ao marcador

// === Cabeçalho ===
export const HEADER_H = 264;   // reduzido de 280 → 16px a menos, cedendo espaço para a grade

// === Grade de bolhas ===
export const GRID_TOP = 285;   // reduzido: gap separador→grade de 68 para 27px | floor((1324-285)/40) = 25 linhas
export const GRID_BOTTOM = CANON_H - 90;  // 1324 — mantém distância segura dos marcadores inferiores
export const ROW_H = 40;
export const BUBBLE_R = 11;
export const LABEL_W = 44;

// === Marcadores de coluna ===
export const COL_MARKER_SIZE = 14;   // lado do marcador de coluna (u canônicos ≈ 2.94 mm)
export const COL_MARKER_GAP  = 6;    // espaço entre o marcador e a borda da grade

// === Parâmetros OMR (ajustáveis) ===
export const FILL_MIN      = 0.40;   // preenchimento mínimo para bolha marcada
export const MARGIN_MIN    = 0.10;   // diferença mínima entre 1ª e 2ª bolha
export const ROI_FACTOR    = 0.65;   // ROI = 65% do raio → amostra interior, evita a borda impressa
export const ADAPT_BLOCK   = 25;     // blockSize do adaptiveThreshold (deve ser ímpar)
export const ADAPT_C       = 7;      // constante C do adaptiveThreshold
export const BLUR_K        = 5;      // kernel GaussianBlur
export const SHARP_MIN     = 80;     // variância mínima do Laplaciano (nitidez)
export const STABLE_FRAMES = 6;      // frames estáveis para auto-disparo (~0.2s a 30fps)
export const LIVE_WIDTH    = 420;    // largura do frame ao vivo para detecção

/**
 * Retorna as posições (centros) dos 4 marcadores no espaço canônico.
 * BR é a âncora (quadrado com furo), os outros 3 são quadrados cheios.
 */
export function getMarkerPositions() {
  const cx = MARKER_INSET + MARKER_SIZE / 2;
  const cy = MARKER_INSET + MARKER_SIZE / 2;
  return {
    tl: [cx, cy],
    tr: [CANON_W - cx, cy],
    bl: [cx, CANON_H - cy],
    br: [CANON_W - cx, CANON_H - cy],   // âncora
  };
}

/**
 * Calcula as coordenadas de todas as bolhas para n questões com opt alternativas.
 * Retorna array de { n, labelX, labelY, bubbles: [{label, x, y, r}] }
 *
 * @param {number} n    número de questões
 * @param {number} opt  número de alternativas (2–5)
 */
export function getBubbleCoords(n, opt) {
  const rowsPerCol = Math.floor((GRID_BOTTOM - GRID_TOP) / ROW_H);
  const cols       = Math.max(1, Math.ceil(n / rowsPerCol));
  const perCol     = Math.ceil(n / cols);
  const colW       = (CANON_W - 2 * MARGIN) / cols;
  const optGap     = Math.min(46, (colW - LABEL_W - 24) / opt);

  const questions = [];
  for (let i = 0; i < n; i++) {
    const col  = Math.floor(i / perCol);
    const row  = i % perCol;
    const colX = MARGIN + col * colW;
    const y    = GRID_TOP + row * ROW_H + ROW_H / 2;
    const startX = colX + LABEL_W + BUBBLE_R + 6;

    const bubbles = [];
    for (let j = 0; j < opt; j++) {
      bubbles.push({
        label: String.fromCharCode(65 + j),   // A, B, C, D, E
        x: startX + j * optGap,
        y,
        r: BUBBLE_R,
      });
    }
    questions.push({ n: i + 1, labelX: colX + 4, labelY: y, bubbles });
  }
  return questions;
}

/**
 * Retorna os centros dos marcadores de coluna (topo e base de cada coluna).
 * Cada coluna tem um marcador pequeno acima da primeira questão e outro abaixo da última.
 * Isso permite calibração local do espaçamento de linhas por coluna após o warp global.
 *
 * @param {number} n    número total de questões
 * @param {number} opt  alternativas por questão
 * @returns {Array<{ col, top:[x,y], bot:[x,y], qInCol, firstRowY, lastRowY }>}
 */
export function getColMarkerPositions(n, opt) {
  const rowsPerCol = Math.floor((GRID_BOTTOM - GRID_TOP) / ROW_H);
  const cols       = Math.max(1, Math.ceil(n / rowsPerCol));
  const perCol     = Math.ceil(n / cols);
  const colW       = (CANON_W - 2 * MARGIN) / cols;

  const result = [];
  for (let c = 0; c < cols; c++) {
    const colX   = MARGIN + c * colW;
    const qInCol = (c === cols - 1) ? n - c * perCol : perCol;

    const firstRowY = GRID_TOP + ROW_H / 2;                        // centro da primeira linha
    const lastRowY  = GRID_TOP + (qInCol - 1) * ROW_H + ROW_H / 2; // centro da última linha

    const mx   = colX + COL_MARKER_SIZE / 2;                                          // x do centro
    const topY = firstRowY - ROW_H / 2 - COL_MARKER_GAP - COL_MARKER_SIZE / 2;       // acima da grade
    const botY = lastRowY  + ROW_H / 2 + COL_MARKER_GAP + COL_MARKER_SIZE / 2;       // abaixo da grade

    result.push({ col: c, top: [mx, topY], bot: [mx, botY], qInCol, firstRowY, lastRowY });
  }
  return result;
}

/**
 * Escala um ponto do espaço canônico para as dimensões reais de um canvas/imagem.
 */
export function scalePoint(x, y, targetW, targetH) {
  return [
    x * targetW / CANON_W,
    y * targetH / CANON_H,
  ];
}

/**
 * Escala uma medida (raio, tamanho) do espaço canônico para dimensões reais.
 */
export function scaleMeasure(v, targetW) {
  return v * targetW / CANON_W;
}
