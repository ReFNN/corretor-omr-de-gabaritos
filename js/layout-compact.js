/**
 * layout-compact.js — Layout canônico para cartão compacto.
 *
 * A LARGURA é adaptativa: calculada a partir do conteúdo (número de colunas).
 * A ALTURA é fixa (460 px) — calculada para que os marcadores principais
 * fiquem rentes ao conteúdo (4px de margem entre marcador de canto e
 * marcador de coluna, tanto em cima quanto embaixo).
 *
 * Equilíbrio vertical para 10 linhas (máx por coluna):
 *   topGap  = GRID_TOP  − 56  = 4 px
 *   botGap  = CANON_H − GRID_TOP − 396 = 4 px
 *   centro  = (CANON_H / 2) = 230 = centro do conteúdo ✓
 *
 * Mesma convenção do layout.js: marcador BR é a âncora.
 */

// === Altura fixa ===
export const CANON_H = 460;

// === Marcadores fiduciais ===
// MARKER_INSET = 8 → marcadores próximos da borda, rentes ao conteúdo
export const MARKER_SIZE  = 32;
export const MARKER_INSET = 8;

// === Margens e geometria da grade ===
const SIDE_MARGIN = 68;

// GRID_TOP = 60 → 4 px de folga entre marcador de canto e marcador de coluna
// GRID_BOTTOM = 400 → floor((400-60)/34) = 10 linhas por coluna
export const GRID_TOP    = 60;
export const GRID_BOTTOM = 400;

// === Geometria das bolhas ===
export const ROW_H    = 34;
export const BUBBLE_R = 11;

// === Geometria fixa de cada coluna ===
const LABEL_W  = 36;   // largura do número da questão
const OPT_GAP  = 38;   // distância centro-a-centro entre bolhas (horizontal)
const COL_GAP  = 48;   // espaço extra entre duas colunas adjacentes

// === Estratégia de warp ===
// O compacto tem borda preta nítida → usá-la dá cantos precisos e warp estável.
export const USE_BORDER_WARP = true;

// === Marcadores de coluna ===
// O layout compacto NÃO imprime marcadores de coluna (confundiam o detector e
// não cabem bem no cartão pequeno). A calibração por coluna fica desligada.
export const HAS_COL_MARKERS = false;
export const COL_MARKER_SIZE = 12;
export const COL_MARKER_GAP  = 4;

// === Parâmetros OMR — idênticos ao layout completo ===
export const FILL_MIN      = 0.40;
export const MARGIN_MIN    = 0.10;
export const ROI_FACTOR    = 0.65;
export const ADAPT_BLOCK   = 25;
export const ADAPT_C       = 7;
export const BLUR_K        = 5;
export const SHARP_MIN     = 80;
export const STABLE_FRAMES = 15;     // ~0.5s a 30fps — cartão menor treme mais, exige mais estabilidade
export const LIVE_WIDTH    = 420;    // compacto é paisagem e preenche o quadro → 420px já basta

// ─── Helper: dimensões do conteúdo ───────────────────────────────────────────

/** Largura real do conteúdo de UMA coluna (label + bolhas). */
function _colContentW(opt) {
  return LABEL_W + 6 + BUBBLE_R + (opt - 1) * OPT_GAP + BUBBLE_R;
}

/** Número máximo de linhas que cabem na altura fixa. */
function _maxRows() {
  return Math.floor((GRID_BOTTOM - GRID_TOP) / ROW_H);
}

/** Parâmetros derivados para um cartão de n questões / opt alternativas. */
function _params(n, opt) {
  const maxRows    = _maxRows();
  const cols       = Math.max(1, Math.ceil(n / maxRows));
  const perCol     = Math.ceil(n / cols);
  const colW       = _colContentW(opt);
  const totalW     = cols * colW + (cols - 1) * COL_GAP;
  const canonW     = SIDE_MARGIN * 2 + totalW;
  const contentX   = SIDE_MARGIN;   // X de início da primeira coluna
  return { cols, perCol, colW, canonW, contentX };
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Largura canônica adaptativa para n questões e opt alternativas.
 * Usada pelo gerador e pelo pipeline OMR.
 */
export function getCanonW(n, opt) {
  return _params(n, opt).canonW;
}

/**
 * Posições dos 4 marcadores fiduciais (centros, espaço canônico).
 * Recebe a largura real do cartão (use getCanonW para obtê-la).
 */
export function getMarkerPositions(canonW = 1000, canonH = CANON_H) {
  const cx = MARKER_INSET + MARKER_SIZE / 2;
  const cy = MARKER_INSET + MARKER_SIZE / 2;
  return {
    tl: [cx, cy],
    tr: [canonW - cx, cy],
    bl: [cx, canonH - cy],
    br: [canonW - cx, canonH - cy],  // âncora
  };
}

/**
 * Coordenadas de todas as bolhas, colunas a partir da margem esquerda.
 */
export function getBubbleCoords(n, opt) {
  const { cols, perCol, colW, contentX } = _params(n, opt);

  const questions = [];
  for (let i = 0; i < n; i++) {
    const col  = Math.floor(i / perCol);
    const row  = i % perCol;
    const colX = contentX + col * (colW + COL_GAP);
    const y    = GRID_TOP + row * ROW_H + ROW_H / 2;

    const firstBubbleX = colX + LABEL_W + 6 + BUBBLE_R;

    const bubbles = [];
    for (let j = 0; j < opt; j++) {
      bubbles.push({
        label: String.fromCharCode(65 + j),
        x: firstBubbleX + j * OPT_GAP,
        y,
        r: BUBBLE_R,
      });
    }
    questions.push({ n: i + 1, labelX: colX, labelY: y, bubbles });
  }
  return questions;
}

/**
 * Centros dos marcadores de coluna (topo e base de cada coluna de questões).
 */
export function getColMarkerPositions(n, opt) {
  const { cols, perCol, colW, contentX } = _params(n, opt);

  const result = [];
  for (let c = 0; c < cols; c++) {
    const colX   = contentX + c * (colW + COL_GAP);
    const qInCol = c === cols - 1 ? n - c * perCol : perCol;

    const firstRowY = GRID_TOP + ROW_H / 2;
    const lastRowY  = GRID_TOP + (qInCol - 1) * ROW_H + ROW_H / 2;
    const mx        = colX + COL_MARKER_SIZE / 2;
    const topY      = firstRowY - ROW_H / 2 - COL_MARKER_GAP - COL_MARKER_SIZE / 2;
    const botY      = lastRowY  + ROW_H / 2 + COL_MARKER_GAP + COL_MARKER_SIZE / 2;

    result.push({ col: c, top: [mx, topY], bot: [mx, botY], qInCol, firstRowY, lastRowY });
  }
  return result;
}

export function scalePoint(x, y, targetW, targetH, canonW = 1000) {
  return [x * targetW / canonW, y * targetH / CANON_H];
}

export function scaleMeasure(v, targetW, canonW = 1000) {
  return v * targetW / canonW;
}
