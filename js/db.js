/**
 * db.js — Wrapper IndexedDB para persistência local.
 * Armazena provas carregadas e resultados de correção.
 */

const DB_NAME    = 'omr-corretor';
const DB_VERSION = 1;
const STORE_EXAMS    = 'exams';
const STORE_RESULTS  = 'results';

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_EXAMS)) {
        db.createObjectStore(STORE_EXAMS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_RESULTS)) {
        const rs = db.createObjectStore(STORE_RESULTS, { keyPath: 'capturedAt' });
        rs.createIndex('examId', 'examId', { unique: false });
      }
    };
    req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror    = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return _db.transaction([storeName], mode).objectStore(storeName);
}

// ─── Provas ───────────────────────────────────────────────

/**
 * Salva (insere ou substitui) uma prova.
 * @param {{ v, id, title, n, opt, k }} exam
 */
export async function saveExam(exam) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(STORE_EXAMS, 'readwrite').put(exam);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/** Retorna todas as provas salvas, ordenadas por id. */
export async function getExams() {
  await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(STORE_EXAMS).getAll();
    req.onsuccess = (e) => resolve(e.target.result.sort((a, b) => a.id.localeCompare(b.id)));
    req.onerror   = (e) => reject(e.target.error);
  });
}

/** Retorna uma prova por id. */
export async function getExam(id) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(STORE_EXAMS).get(id);
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/** Remove uma prova pelo id. */
export async function deleteExam(id) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(STORE_EXAMS, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ─── Resultados ───────────────────────────────────────────

/**
 * Salva um resultado de correção.
 * @param {{ examId, student, score, total, answers, capturedAt }} result
 */
export async function saveResult(result) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(STORE_RESULTS, 'readwrite').put(result);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/** Retorna todos os resultados de uma prova, do mais recente para o mais antigo. */
export async function getResultsByExam(examId) {
  await openDB();
  return new Promise((resolve, reject) => {
    const index = _db
      .transaction([STORE_RESULTS], 'readonly')
      .objectStore(STORE_RESULTS)
      .index('examId');
    const req = index.getAll(examId);
    req.onsuccess = (e) =>
      resolve(e.target.result.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)));
    req.onerror = (e) => reject(e.target.error);
  });
}

/** Retorna todos os resultados. */
export async function getAllResults() {
  await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(STORE_RESULTS).getAll();
    req.onsuccess = (e) =>
      resolve(e.target.result.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)));
    req.onerror = (e) => reject(e.target.error);
  });
}
