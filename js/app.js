/**
 * app.js — Controlador principal.
 * Fluxo: Home (lista de provas) → Editar Gabarito | Home → Capturar → Resultado
 * Múltiplos gabaritos persistidos no IndexedDB.
 */

import { saveExam, getExams, deleteExam, saveResult } from './db.js?v=37';
import { drawCard, randomKey, printCard }              from './generator.js?v=37';
import { runOMR, analyzeFrame }                        from './omr.js?v=37';
import { STABLE_FRAMES, LIVE_WIDTH }                   from './layout.js?v=37';
import * as LayoutFull    from './layout.js?v=37';
import * as LayoutCompact from './layout-compact.js?v=37';

// ─── Toast (notificação não-bloqueante) ────────────────────────────────────────
function showToast(msg, type = 'info') {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className   = `app-toast toast-${type} toast-show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('toast-show'), 3000);
}

// ─── Estado global ─────────────────────────────────────────────────────────────
const state = {
  cvReady:       false,
  currentExam:   null,   // prova selecionada para corrigir
  lastResult:    null,
  stream:        null,
  liveHandle:    null,
  stableCount:   0,
  captureMode:   null,
  editingExamId: null,   // ID da prova sendo editada (null = nova prova)
};

function getLayoutMod(exam) {
  return exam?.layout === 'compact' ? LayoutCompact : LayoutFull;
}

// ─── Navegação ─────────────────────────────────────────────────────────────────
const screens = document.querySelectorAll('.screen');

function showScreen(id) {
  screens.forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}

// ─── OpenCV ────────────────────────────────────────────────────────────────────
function onCvReady() {
  state.cvReady = true;
  document.getElementById('cv-loading').style.display = 'none';
  console.log('[OMR] OpenCV.js pronto.');
}

// ─── Câmera ────────────────────────────────────────────────────────────────────
async function startCamera(videoEl, facingMode = 'environment') {
  stopCamera();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    videoEl.srcObject = state.stream;
    await videoEl.play();
  } catch (err) {
    showToast(`Câmera indisponível: ${err.message}`, 'error');
    throw err;
  }
}

function stopCamera() {
  if (state.liveHandle) { cancelAnimationFrame(state.liveHandle); state.liveHandle = null; }
  if (state.stream)     { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
}

function captureHiRes(videoEl) {
  const canvas = document.createElement('canvas');
  canvas.width  = videoEl.videoWidth  || 1280;
  canvas.height = videoEl.videoHeight || 720;
  canvas.getContext('2d').drawImage(videoEl, 0, 0);
  return canvas;
}

// ─── TELA 1: Home ──────────────────────────────────────────────────────────────
async function initHome() {
  showScreen('screen-home');
  stopCamera();

  const listEl   = document.getElementById('exam-list');
  const emptyEl  = document.getElementById('no-exam-msg');
  listEl.innerHTML = '';

  let exams = [];
  try { exams = await getExams(); } catch (e) { console.error(e); }

  if (exams.length === 0) {
    emptyEl.style.display = '';
  } else {
    emptyEl.style.display = 'none';
    exams.forEach(exam => listEl.appendChild(buildExamItem(exam)));
  }
}

function buildExamItem(exam) {
  const isCompact  = exam.layout === 'compact';
  const badgeLabel = isCompact ? 'COMPACTO' : 'COMPLETO';
  const badgeClass = isCompact ? 'badge-compact' : 'badge-full';

  const el = document.createElement('div');
  el.className = 'exam-item';
  el.innerHTML = `
    <div class="exam-item-top">
      <div class="exam-item-info">
        <strong class="exam-item-title">${exam.title || exam.id}</strong>
        <span class="exam-item-meta">${exam.n} questões · ${exam.opt} alternativas</span>
        <span class="exam-item-id">ID: ${exam.id}</span>
      </div>
      <span class="badge ${badgeClass}">${badgeLabel}</span>
    </div>
    <div class="exam-item-actions">
      <button class="btn-ghost btn-sm btn-edit-exam">✏ Editar</button>
      <button class="btn-primary btn-sm btn-corrigir">📷 Corrigir</button>
      <button class="btn-danger btn-sm btn-delete-exam">🗑</button>
    </div>
  `;

  el.querySelector('.btn-corrigir').onclick = () => {
    state.currentExam = exam;
    initCapture();
  };

  el.querySelector('.btn-edit-exam').onclick = () => initEditor(exam);

  el.querySelector('.btn-delete-exam').onclick = async () => {
    if (!confirm(`Excluir a prova "${exam.title || exam.id}"?\nOs resultados já salvos serão mantidos.`)) return;
    try {
      await deleteExam(exam.id);
      if (state.currentExam?.id === exam.id) state.currentExam = null;
      initHome();
      showToast('Prova excluída.', 'info');
    } catch (e) { showToast('Erro ao excluir: ' + e.message, 'error'); }
  };

  return el;
}

// ─── TELA 2: Captura OMR ───────────────────────────────────────────────────────
const captureVideo   = document.getElementById('capture-video');
const captureOverlay = document.getElementById('capture-overlay');
const overlayCtx     = captureOverlay.getContext('2d');

async function initCapture() {
  if (!state.currentExam) { initHome(); return; }
  showScreen('screen-capture');
  state.captureMode = 'omr';
  state.stableCount = 0;

  const exam = state.currentExam;
  document.getElementById('capture-exam-title').textContent =
    `${exam.title || exam.id} · ${exam.layout === 'compact' ? 'Compacto' : 'Completo'}`;

  setCaptureHint('Enquadre o cartão-resposta no quadro', 'info');

  await startCamera(captureVideo);
  captureVideo.addEventListener('loadedmetadata', resizeOverlay, { once: true });
  resizeOverlay();
  liveDetectionLoop();
}

function resizeOverlay() {
  captureOverlay.width  = captureVideo.videoWidth  || captureVideo.clientWidth;
  captureOverlay.height = captureVideo.videoHeight || captureVideo.clientHeight;
}

function setCaptureHint(msg, type = 'info') {
  const el = document.getElementById('capture-hint');
  el.textContent = msg;
  el.className   = `capture-hint status-${type}`;
}

function liveDetectionLoop() {
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width  = LIVE_WIDTH;
  tmpCanvas.height = Math.round(LIVE_WIDTH * (9 / 16));
  const tmpCtx = tmpCanvas.getContext('2d');

  // Frames estáveis para auto-disparo: específico do layout da prova atual.
  // O compacto usa um limiar um pouco maior (cartão menor → mais sensível ao tremor).
  const stableFrames = getLayoutMod(state.currentExam).STABLE_FRAMES ?? STABLE_FRAMES;

  // Verificação de posição: marcadores devem estar no mesmo lugar entre frames.
  // Evita falsos positivos em baixa luz (ruído gera "marcadores" em posições diferentes a cada frame).
  let lastMarkers = null;
  let missCount   = 0;          // frames "transientes" consecutivos (pisca de detecção OU tremor)
  const MAX_DRIFT = 45;         // px no frame reduzido (420px) — tolerância ao tremor das mãos
  const MAX_MISS  = 12;         // transientes tolerados antes de resetar (~0.4s de tremor/pisca)

  function markersPositionOk(curr, prev) {
    if (!prev) return true;   // primeira detecção após perda: aceitar sem comparar posição
    return ['tl', 'tr', 'bl', 'br'].every(k => {
      const dx = curr[k][0] - prev[k][0];
      const dy = curr[k][1] - prev[k][1];
      return Math.hypot(dx, dy) < MAX_DRIFT;
    });
  }

  function loop() {
    if (state.captureMode !== 'omr' || !captureVideo.srcObject) return;

    if (captureVideo.readyState >= 2 && state.cvReady) {
      tmpCtx.drawImage(captureVideo, 0, 0, tmpCanvas.width, tmpCanvas.height);
      const frameData = tmpCtx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height);
      const { markersFound, quadOk, sharpOk, markers } = analyzeFrame(frameData);
      const validNow = markersFound && quadOk && markers;

      // Overlay: desenha os marcadores atuais; durante piscas curtas, mantém os
      // últimos conhecidos para a caixa verde não piscar.
      overlayCtx.clearRect(0, 0, captureOverlay.width, captureOverlay.height);
      if (validNow) {
        drawMarkerOverlay(markers, tmpCanvas.width, tmpCanvas.height);
      } else if (lastMarkers && missCount < MAX_MISS) {
        drawMarkerOverlay(lastMarkers, tmpCanvas.width, tmpCanvas.height);
      }

      if (validNow && markersPositionOk(markers, lastMarkers)) {
        // Posição estável (dentro da tolerância de tremor) → acumula o contador,
        // independente da nitidez (o foco oscila, mas não deve perder o progresso).
        missCount = 0;
        lastMarkers = markers;
        state.stableCount++;
        const remaining = stableFrames - state.stableCount;

        if (!sharpOk) {
          setCaptureHint(`🔀 Aguardando foco... (${Math.max(0, remaining)})`, 'warn');
        } else if (remaining > 0) {
          setCaptureHint(`✓ Segure firme... (${remaining})`, 'ok');
        } else {
          setCaptureHint('📸 Capturando...', 'ok');
          state.stableCount = 0;
          triggerCapture();
          return;
        }
      } else {
        // TRANSIENTE: pisca de detecção (threshold varia) OU pulo de tremor além da
        // tolerância. Não reseta de imediato — segura o progresso por até MAX_MISS
        // frames (mantendo lastMarkers como referência estável). Só reseta se o
        // movimento/perda for SUSTENTADO (reposicionamento real do cartão).
        missCount++;
        if (lastMarkers === null) {
          setCaptureHint('🔍 Procurando marcadores nos cantos...', 'info');
        } else if (missCount > MAX_MISS) {
          state.stableCount = 0;
          lastMarkers = null;
          if (!markersFound)   setCaptureHint('🔍 Procurando marcadores nos cantos...', 'info');
          else if (!quadOk)    setCaptureHint('↔ Afaste-se para ver os 4 cantos do cartão', 'warn');
          else                 setCaptureHint('📷 Mantenha o cartão parado...', 'warn');
        } else if (state.stableCount > 0) {
          // segura o countdown durante o transiente
          const remaining = stableFrames - state.stableCount;
          setCaptureHint(`✓ Segure firme... (${Math.max(0, remaining)})`, 'ok');
        } else {
          setCaptureHint('🔍 Procurando marcadores nos cantos...', 'info');
        }
      }
    }

    state.liveHandle = requestAnimationFrame(loop);
  }

  state.liveHandle = requestAnimationFrame(loop);
}

function drawMarkerOverlay(markers, srcW, srcH) {
  const scaleX = captureOverlay.width  / srcW;
  const scaleY = captureOverlay.height / srcH;
  const pts    = [markers.tl, markers.tr, markers.bl, markers.br];
  const spts   = pts.map(([x, y]) => [x * scaleX, y * scaleY]);

  overlayCtx.beginPath();
  overlayCtx.moveTo(...spts[0]);
  overlayCtx.lineTo(...spts[1]);
  overlayCtx.lineTo(...spts[3]);
  overlayCtx.lineTo(...spts[2]);
  overlayCtx.closePath();
  overlayCtx.strokeStyle = '#00e676';
  overlayCtx.lineWidth   = 3;
  overlayCtx.stroke();
  overlayCtx.fillStyle   = 'rgba(0,230,118,0.08)';
  overlayCtx.fill();

  spts.forEach(([x, y], i) => {
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 8, 0, 2 * Math.PI);
    overlayCtx.fillStyle = i === 3 ? '#ff6d00' : '#00e676';
    overlayCtx.fill();
  });
}

async function triggerCapture() {
  stopCamera();
  setCaptureHint('⚙ Processando...', 'info');
  processOMR(captureHiRes(captureVideo));
}

window.manualCapture = () => {
  if (!captureVideo.srcObject) return;
  const hiRes = captureHiRes(captureVideo);
  stopCamera();
  setCaptureHint('⚙ Processando captura manual...', 'info');
  processOMR(hiRes);
};

function processOMR(canvas) {
  if (!state.cvReady) {
    showToast('OpenCV ainda está carregando. Aguarde.', 'info');
    initCapture();
    return;
  }

  const student    = document.getElementById('student-name')?.value?.trim() || '';
  const layoutMod  = getLayoutMod(state.currentExam);

  setTimeout(() => {
    const { result, canonCanvas, error } = runOMR(canvas, state.currentExam, student, layoutMod);

    if (error) {
      showToast(`Erro: ${error}`, 'error');
      initCapture();
      return;
    }

    state.lastResult = result;
    saveResult(result).catch(console.error);
    showResult(result, canonCanvas);
  }, 50);
}

// ─── TELA 3: Resultado ─────────────────────────────────────────────────────────
function showResult(result, canonCanvas) {
  showScreen('screen-result');

  document.getElementById('result-score').textContent   = `${result.score} / ${result.total}`;
  document.getElementById('result-pct').textContent     = `${result.pct}%`;
  document.getElementById('result-exam-id').textContent = result.examId;
  document.getElementById('result-student').textContent = result.student || '—';
  document.getElementById('result-date').textContent    = new Date(result.capturedAt).toLocaleString('pt-BR');

  const imgContainer = document.getElementById('result-image');
  imgContainer.innerHTML = '';
  canonCanvas.style.maxWidth = '100%';
  canonCanvas.style.border   = '1px solid #ddd';
  imgContainer.appendChild(canonCanvas);

  const statusLabel = { ok: '✓', blank: '—', multi: '!!', low_conf: '?' };
  document.getElementById('result-table-body').innerHTML = result.answers.map(a => `
    <tr class="${a.right ? 'row-ok' : 'row-err'}">
      <td>${a.q}</td>
      <td>${a.marked ?? '—'}</td>
      <td>${a.correct}</td>
      <td>${statusLabel[a.status] ?? a.status}</td>
    </tr>
  `).join('');
}

function exportCSV() {
  if (!state.lastResult) return;
  const r = state.lastResult;
  const lines = [
    `Prova,${r.examId}`,
    `Aluno,${r.student}`,
    `Nota,${r.score}/${r.total} (${r.pct}%)`,
    `Data,${r.capturedAt}`,
    '',
    'Questão,Marcada,Correta,Status,Acerto',
    ...r.answers.map(a => `${a.q},${a.marked ?? ''},${a.correct},${a.status},${a.right ? 'S' : 'N'}`),
  ];
  downloadFile(`resultado-${r.examId}.csv`, lines.join('\n'), 'text/csv');
}

function exportJSON() {
  if (!state.lastResult) return;
  const r = state.lastResult;
  downloadFile(`resultado-${r.examId}.json`, JSON.stringify(r, null, 2), 'application/json');
}

function downloadFile(name, content, mime) {
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
}

// ─── TELA 4: Editor de Gabarito ────────────────────────────────────────────────
const genCanvas = document.getElementById('gen-canvas');

// ─── Limites de questões por layout ───────────────────────────────────────────

const COMPACT_MAX_Q = 30;

/**
 * Máximo de questões para o layout completo, dado o número de alternativas.
 * Baseado na geometria real: rowsPerCol=24, evita sobreposição de bolhas.
 * MIN_OPT_GAP = 2*BUBBLE_R + 2 = 24px (borda a borda mínima de 2px)
 */
function fullMaxQuestions(opt) {
  const rowsPerCol  = 25;          // floor((1340-340)/40) após GRID_BOTTOM = CANON_H - 74
  const availW      = 880;         // CANON_W - 2*MARGIN = 1000 - 120
  const minColW     = opt * 24 + 68; // opt*(2*r+2) + LABEL_W + 24
  const maxCols     = Math.floor(availW / minColW);
  return Math.max(1, maxCols) * rowsPerCol;
}

/** Atualiza o atributo max do campo de questões e mostra a dica ao usuário. */
function refreshQuestionsLimit() {
  const layout = document.getElementById('gen-layout').value;
  const opt    = parseInt(document.getElementById('gen-opt').value, 10) || 5;
  const max    = layout === 'compact' ? COMPACT_MAX_Q : fullMaxQuestions(opt);

  const input  = document.getElementById('gen-n');
  const hint   = document.getElementById('gen-n-hint');
  input.max    = max;
  if (hint) hint.textContent = `máx. ${max}`;

  // Clamp valor atual se exceder o novo máximo
  const cur = parseInt(input.value, 10);
  if (cur > max) input.value = max;
}

/**
 * @param {object|null} exam  prova para editar, ou null para nova prova
 */
function initEditor(exam = null) {
  showScreen('screen-editor');
  state.editingExamId = exam?.id ?? null;

  // Título do editor
  document.getElementById('editor-title').textContent =
    exam ? `Editar: ${exam.title || exam.id}` : 'Nova Prova';

  // Pré-preencher campos
  document.getElementById('gen-id').value    = exam?.id    ?? '';
  document.getElementById('gen-title').value = exam?.title ?? '';
  document.getElementById('gen-n').value     = exam?.n     ?? 20;
  document.getElementById('gen-opt').value   = String(exam?.opt ?? 5);
  document.getElementById('gen-key').value   = exam?.k     ?? '';

  // Sincronizar hidden input + radio buttons
  const layout = exam?.layout ?? 'full';
  document.getElementById('gen-layout').value = layout;
  const radio = document.querySelector(`input[name="gen-layout-radio"][value="${layout}"]`);
  if (radio) radio.checked = true;

  // Atualizar limite de questões
  refreshQuestionsLimit();

  document.getElementById('gen-preview-wrap').style.display = 'none';
  document.getElementById('gen-actions').style.display      = 'none';
}

function buildExamFromForm() {
  const id     = document.getElementById('gen-id').value.trim()    || 'PROVA-01';
  const title  = document.getElementById('gen-title').value.trim() || 'Avaliação';
  const opt    = parseInt(document.getElementById('gen-opt').value, 10) || 5;
  const layout = document.getElementById('gen-layout').value || 'full';
  const max    = layout === 'compact' ? COMPACT_MAX_Q : fullMaxQuestions(opt);
  const n      = Math.min(parseInt(document.getElementById('gen-n').value, 10) || 20, max);
  const k      = document.getElementById('gen-key').value.trim().toUpperCase();
  return { id, title, n, opt, k, layout };
}

window.genRandom = () => {
  const n   = parseInt(document.getElementById('gen-n').value, 10)   || 20;
  const opt = parseInt(document.getElementById('gen-opt').value, 10) || 5;
  document.getElementById('gen-key').value = randomKey(n, opt);
};

window.genSaveExam = async () => {
  const exam = buildExamFromForm();
  if (exam.k.length !== exam.n) {
    showToast(`O gabarito deve ter ${exam.n} letras (tem ${exam.k.length}).`, 'error');
    return;
  }
  try {
    await saveExam(exam);
    initHome();
    showToast(`Prova "${exam.title || exam.id}" salva com sucesso!`, 'ok');
  } catch (e) {
    showToast('Erro ao salvar: ' + e.message, 'error');
  }
};

window.genPreview = () => {
  const exam = buildExamFromForm();
  if (exam.k.length !== exam.n) {
    showToast(`O gabarito deve ter ${exam.n} letras (tem ${exam.k.length}).`, 'error');
    return;
  }

  document.getElementById('gen-preview-wrap').style.display = 'flex';

  const PRINT_W = 2079;  // ~250 DPI em largura A4

  if (exam.layout === 'compact') {
    // Compacto: largura adaptativa ao conteúdo, altura fixa proporcional
    const canonW = LayoutCompact.getCanonW(exam.n, exam.opt);
    const canonH = LayoutCompact.CANON_H;
    // Escalar mantendo DPI equivalente (referência: A4 = 1000 canônico → 2079px)
    const scale  = PRINT_W / 1000;
    genCanvas.width  = Math.round(canonW * scale);
    genCanvas.height = Math.round(canonH * scale);
  } else {
    // Completo: A4 portrait
    genCanvas.width  = PRINT_W;
    genCanvas.height = Math.round(PRINT_W * (297 / 210));
  }

  const availW = genCanvas.parentElement.clientWidth || 400;
  genCanvas.style.width  = `${Math.min(availW - 16, 520)}px`;
  genCanvas.style.height = 'auto';

  drawCard(genCanvas, exam);
  document.getElementById('gen-actions').style.display = 'flex';
};

window.genPrint = () => {
  const layout = document.getElementById('gen-layout').value || 'full';
  printCard(genCanvas, layout);
};

// ─── Inicialização ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Home
  document.getElementById('btn-new-exam').onclick          = () => initEditor(null);
  document.getElementById('btn-back-home-cap').onclick     = () => { stopCamera(); initHome(); };
  document.getElementById('btn-back-home-result').onclick  = initHome;
  document.getElementById('btn-back-home-ed').onclick      = initHome;
  document.getElementById('btn-retry').onclick             = initCapture;
  document.getElementById('btn-export-csv').onclick        = exportCSV;
  document.getElementById('btn-export-json').onclick       = exportJSON;
  document.getElementById('btn-manual-capture').onclick    = () => window.manualCapture();

  // Editor
  document.getElementById('btn-gen-random').onclick  = window.genRandom;
  document.getElementById('btn-gen-preview').onclick = window.genPreview;
  document.getElementById('btn-gen-print').onclick   = window.genPrint;
  document.getElementById('btn-gen-save').onclick    = window.genSaveExam;

  // Atualizar limite de questões quando alternativas ou layout mudam
  document.getElementById('gen-opt').addEventListener('change', refreshQuestionsLimit);
  document.querySelectorAll('input[name="gen-layout-radio"]').forEach(r =>
    r.addEventListener('change', refreshQuestionsLimit)
  );

  initHome();
});

window.onOpenCvReady = onCvReady;
