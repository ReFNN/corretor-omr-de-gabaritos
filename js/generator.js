/**
 * generator.js — Gerador de cartões-resposta.
 * Suporta dois layouts: 'full' (A4 completo) e 'compact' (bloco inserido na prova).
 * Despacha para drawCardFull ou drawCardCompact com base em exam.layout.
 */

import {
  CANON_W    as FULL_W,
  CANON_H    as FULL_H,
  MARGIN,
  MARKER_SIZE    as FULL_MS,
  MARKER_INSET   as FULL_MI,
  HEADER_H,
  BUBBLE_R       as FULL_BR,
  COL_MARKER_SIZE as FULL_CMS,
  getMarkerPositions    as fullMarkers,
  getBubbleCoords       as fullBubbles,
  getColMarkerPositions as fullColMarkers,
} from './layout.js?v=38';

import {
  CANON_H    as COMP_H,
  MARKER_SIZE     as COMP_MS,
  BUBBLE_R        as COMP_BR,
  getCanonW            as compGetCanonW,
  getMarkerPositions   as compMarkers,
  getBubbleCoords      as compBubbles,
} from './layout-compact.js?v=38';

// ─── Utilitário comum ──────────────────────────────────────────────────────────

function drawMarker(ctx, cx, cy, size, isAnchor, sx, sy) {
  const half = size / 2;
  const x = (cx - half) * sx;
  const y = (cy - half) * sy;
  const w = size * sx;
  const h = size * sy;

  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);

  if (isAnchor) {
    const ratio = 0.40;
    const iw = w * ratio;
    const ih = h * ratio;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  }
}

// ─── Layout completo (A4) ──────────────────────────────────────────────────────

function drawCardFull(canvas, exam) {
  const { id, title, n, opt } = exam;
  const sx = canvas.width  / FULL_W;
  const sy = canvas.height / FULL_H;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

  // Marcadores
  const m = fullMarkers();
  drawMarker(ctx, m.tl[0], m.tl[1], FULL_MS, false, sx, sy);
  drawMarker(ctx, m.tr[0], m.tr[1], FULL_MS, false, sx, sy);
  drawMarker(ctx, m.bl[0], m.bl[1], FULL_MS, false, sx, sy);
  drawMarker(ctx, m.br[0], m.br[1], FULL_MS, true,  sx, sy);

  // Cabeçalho
  const hdrY = (FULL_MI + FULL_MS + 12) * sy;
  const hdrH = (HEADER_H - FULL_MI - FULL_MS - 20) * sy;
  const hdrX = MARGIN * sx;
  const hdrW = (FULL_W - 2 * MARGIN) * sx;

  ctx.fillStyle = '#000';
  ctx.font = `bold ${18 * sx}px Arial, sans-serif`;
  ctx.fillText(title || 'Cartão-Resposta', hdrX, hdrY + 22 * sy);

  ctx.font = `${12 * sx}px Arial, sans-serif`;
  ctx.fillText(`ID: ${id}  |  ${n} questões  |  ${opt} alternativas`, hdrX, hdrY + 42 * sy);
  ctx.fillText('Aluno(a): _____________________________________________', hdrX, hdrY + 70 * sy);
  ctx.fillText('Data: ___/___/______', hdrX, hdrY + 90 * sy);

  ctx.font = `italic ${10 * sx}px Arial, sans-serif`;
  ctx.fillStyle = '#555';
  ctx.fillText('Preencha completamente a bolha com caneta. Não rasure.', hdrX, hdrY + 110 * sy);

  // Marcadores de coluna: quadradinhos pretos acima/abaixo de cada coluna.
  // O detector (omr.js) agora seleciona os 4 marcadores de canto por posição
  // extrema, então estes marcadores interiores não confundem mais o warp.
  // Servem para calibrar o espaçamento de linhas por coluna (refineWithColMarkers).
  const colData = fullColMarkers(n, opt);
  ctx.fillStyle = '#000';
  colData.forEach(({ top, bot }) => {
    const half = FULL_CMS / 2;
    ctx.fillRect((top[0] - half) * sx, (top[1] - half) * sy, FULL_CMS * sx, FULL_CMS * sy);
    ctx.fillRect((bot[0] - half) * sx, (bot[1] - half) * sy, FULL_CMS * sx, FULL_CMS * sy);
  });

  // Cabeçalho de alternativas por coluna
  const questions = fullBubbles(n, opt);
  ctx.font = `bold ${13 * sx}px Arial, sans-serif`;
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  const firstPerCol = new Map();
  questions.forEach(q => { if (!firstPerCol.has(q.labelX)) firstPerCol.set(q.labelX, q); });
  firstPerCol.forEach(q => {
    const headerY = (q.labelY - 22) * sy;
    q.bubbles.forEach(b => ctx.fillText(b.label, b.x * sx, headerY));
  });
  ctx.textAlign = 'left';

  // Questões
  ctx.font = `bold ${14 * sx}px Arial, sans-serif`;
  const bubbleR = FULL_BR * sx;
  questions.forEach(q => {
    ctx.fillStyle = '#000';
    ctx.fillText(String(q.n).padStart(2, ' '), q.labelX * sx, q.labelY * sy + 5 * sy);
    q.bubbles.forEach(b => {
      ctx.beginPath();
      ctx.arc(b.x * sx, b.y * sy, bubbleR, 0, 2 * Math.PI);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1 * sx;
      ctx.stroke();
    });
  });
}

// ─── Layout compacto ───────────────────────────────────────────────────────────
// Sem cabeçalho, sem QR: apenas marcadores fiduciais + grade de questões.

function drawCardCompact(canvas, exam) {
  const { n, opt } = exam;
  const COMP_W = compGetCanonW(n, opt);   // largura adaptativa
  const sx = canvas.width  / COMP_W;
  const sy = canvas.height / COMP_H;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Borda externa
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5 * sx;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

  // ── Marcadores fiduciais ──
  const m = compMarkers(COMP_W, COMP_H);
  drawMarker(ctx, m.tl[0], m.tl[1], COMP_MS, false, sx, sy);
  drawMarker(ctx, m.tr[0], m.tr[1], COMP_MS, false, sx, sy);
  drawMarker(ctx, m.bl[0], m.bl[1], COMP_MS, false, sx, sy);
  drawMarker(ctx, m.br[0], m.br[1], COMP_MS, true,  sx, sy);

  // Marcadores de coluna removidos do layout compacto:
  // os pequenos quadrados pretos acima/abaixo de cada coluna são confundidos
  // pelo detector de marcadores com os 4 marcadores de canto reais,
  // causando warp incorreto. No layout compacto o warp global pelos 4 cantos é suficiente.

  // ── Cabeçalho de alternativas (A B C D E) por coluna ──
  const questions = compBubbles(n, opt);
  const bubbleR   = COMP_BR * sx;

  ctx.font = `bold ${13 * sx}px Arial, sans-serif`;
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  const firstPerCol = new Map();
  questions.forEach(q => { if (!firstPerCol.has(q.labelX)) firstPerCol.set(q.labelX, q); });
  firstPerCol.forEach(q => {
    const headerY = (q.labelY - 22) * sy;
    q.bubbles.forEach(b => ctx.fillText(b.label, b.x * sx, headerY));
  });
  ctx.textAlign = 'left';

  // ── Questões ──
  ctx.font = `bold ${13 * sx}px Arial, sans-serif`;
  questions.forEach(q => {
    ctx.fillStyle = '#000';
    ctx.fillText(String(q.n).padStart(2, ' '), q.labelX * sx, q.labelY * sy + 4 * sy);

    q.bubbles.forEach(b => {
      ctx.beginPath();
      ctx.arc(b.x * sx, b.y * sy, bubbleR, 0, 2 * Math.PI);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1 * sx;
      ctx.stroke();
    });
  });
}

// ─── API pública ───────────────────────────────────────────────────────────────

/**
 * Despacha para o gerador correto com base em exam.layout.
 * @param {HTMLCanvasElement} canvas
 * @param {{ layout, id, title, n, opt, k }} exam
 */
export function drawCard(canvas, exam) {
  if (exam.layout === 'compact') {
    drawCardCompact(canvas, exam);
  } else {
    drawCardFull(canvas, exam);
  }
}

/**
 * Gera um gabarito aleatório.
 */
export function randomKey(n, opt) {
  const letters = 'ABCDE'.slice(0, opt);
  return Array.from({ length: n }, () => letters[Math.floor(Math.random() * opt)]).join('');
}

/**
 * Abre janela de impressão com o canvas renderizado.
 * @param {HTMLCanvasElement} canvas
 * @param {'full'|'compact'} layout
 */
export function printCard(canvas, layout = 'full') {
  const dataUrl = canvas.toDataURL('image/png');
  const isCompact = layout === 'compact';

  // Para compacto: imprime em largura A4, altura proporcional (~94mm ≈ 1/3 de A4)
  const imgStyle = isCompact
    ? 'width:190mm; height:auto; display:block; margin:10mm auto;'
    : 'width:210mm; height:297mm; display:block;';

  const pageStyle = isCompact
    ? '@page { size: A4 portrait; margin: 0; }'
    : '@page { size: A4 portrait; margin: 0; }';

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Cartão-Resposta</title>
      <style>
        ${pageStyle}
        body { margin: 0; padding: 0; background: #fff; }
        img  { ${imgStyle} }
      </style>
    </head>
    <body>
      <img src="${dataUrl}" />
      <script>window.onload = () => { window.print(); }<\/script>
    </body>
    </html>
  `);
  win.document.close();
}
