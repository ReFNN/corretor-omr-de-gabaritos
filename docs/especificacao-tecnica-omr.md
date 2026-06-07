# Corretor OMR — Especificação Técnica

> Versão do protótipo: **2.0** (corresponde ao código `?v=38`)
> Data: 2026-06-06
> Tecnologia principal: OpenCV.js 4.8.0 (WASM) + JavaScript Vanilla (ES Modules) + PWA

Este documento descreve **tudo** o que o protótipo usa: arquitetura, os dois layouts de cartão, todos os parâmetros, o pipeline de visão computacional, limites e persistência. Os valores aqui refletem o código-fonte atual.

---

## 1. Visão Geral

Leitor óptico de gabaritos (OMR — *Optical Mark Recognition*) que roda **inteiramente no navegador**, sem backend e offline (PWA). O usuário gera/imprime um cartão-resposta, o aluno preenche, e a câmera lê e corrige contra o gabarito.

### Fluxo geral

```
Câmera → frame de vídeo → detecção dos marcadores → (warp provisório)
→ orientação pelo furo da âncora (pós-warp) → warp final
→ binarização adaptativa → amostragem das bolhas → decisão por questão
→ correção contra gabarito → resultado (score + tabela + imagem anotada)
```

### Arquitetura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `js/layout.js` | Fonte de verdade do layout **página inteira (A4)** — constantes e coordenadas |
| `js/layout-compact.js` | Fonte de verdade do layout **compacto** (largura adaptativa) |
| `js/generator.js` | Renderização do cartão em canvas e impressão (despacha por `exam.layout`) |
| `js/omr.js` | Pipeline completo: detecção, orientação, warp, binarização, leitura, correção |
| `js/app.js` | Controlador de telas, câmera, captura ao vivo, limites por layout |
| `js/db.js` | Persistência IndexedDB (provas + resultados) |
| `index.html` | Telas: Home, Captura, Resultado, Editor de gabarito |
| `sw.js` / `manifest.json` | Service worker (cache offline) e manifesto PWA |

### Princípio do espaço canônico

Cada layout define um **espaço canônico de referência**. Gerador e leitor usam exatamente as mesmas funções (`getMarkerPositions`, `getBubbleCoords`, `getColMarkerPositions`) — assim as bolhas impressas caem precisamente onde o leitor as procura. **Nunca** duplicar constantes fora do módulo de layout.

---

## 2. Os Dois Layouts

| Aspecto | Página inteira (`full`) | Compacto (`compact`) |
|---|---|---|
| Módulo | `layout.js` | `layout-compact.js` |
| Orientação | Retrato (A4) | Paisagem |
| Espaço canônico | **1000 × 1414** (fixo) | **largura adaptativa × 460** |
| Cabeçalho | Sim (título, ID, aluno, data, instrução) | Não (só marcadores + grade) |
| Marcadores de coluna | **Sim** (`HAS_COL_MARKERS = true`) | Não (`false`) |
| Estratégia de warp | Pelos **4 marcadores** (`USE_BORDER_WARP = false`) | Pela **borda** do cartão (`true`) |
| Calibração de linha por coluna | Sim (`refineWithColMarkers`) | Não |
| Máx. de questões | 100–175 (depende das alternativas, ver §8) | **30** |
| `STABLE_FRAMES` (auto-disparo) | 6 (~0,2 s) | 15 (~0,5 s) |
| `LIVE_WIDTH` (frame ao vivo) | **800 px** | 420 px |
| Impressão | A4 retrato cheio | ~190 mm de largura, altura proporcional (~⅓ de página) |

Justificativas de design:
- **Warp pela borda só no compacto** porque sua borda é preta e nítida (cantos precisos); a borda do A4 é cinza-clara e fina (não confiável) → A4 usa os 4 marcadores.
- **`LIVE_WIDTH` maior no A4** porque o cartão retrato fica pequeno num quadro de câmera paisagem; a 420 px os marcadores ficavam ~7 px (indetectáveis); a 800 px ficam ~13 px.
- **`STABLE_FRAMES` maior no compacto** porque o cartão menor é mais sensível ao tremor.

---

## 3. Espaço Canônico

### 3.1 Página inteira (`layout.js`)

| Constante | Valor | Físico (A4, 1 u = 0,21 mm) |
|---|---|---|
| `CANON_W` | 1000 u | 210 mm |
| `CANON_H` | 1414 u | 297 mm (proporção 1:1.414) |
| `MARGIN` | 60 u | 12,6 mm |

### 3.2 Compacto (`layout-compact.js`)

Altura fixa, **largura calculada a partir do conteúdo**:

| Constante | Valor |
|---|---|
| `CANON_H` | 460 u |
| `SIDE_MARGIN` | 68 u (margem lateral em cada lado) |
| `LABEL_W` | 36 u (largura do número da questão) |
| `OPT_GAP` | 38 u (distância centro-a-centro entre bolhas) |
| `COL_GAP` | 48 u (espaço extra entre colunas) |

Cálculo da largura (`getCanonW`):
```
larguraConteudoColuna(opt) = LABEL_W + 6 + BUBBLE_R + (opt-1)*OPT_GAP + BUBBLE_R
                           = 64 + (opt-1)*38
cols    = ceil(n / maxRows)              # maxRows = 10 (ver §5.2)
totalW  = cols*colW + (cols-1)*COL_GAP
canonW  = 2*SIDE_MARGIN + totalW
```
Exemplos (5 alternativas): 1 coluna → `canonW = 352`; 3 colunas (30 questões) → `canonW = 880`.

---

## 4. Marcadores Fiduciais

Quatro quadrados pretos nos cantos. **BR é a âncora** — tem um furo (quadrado branco interno de 40% do lado). O furo identifica unicamente o canto inferior-direito e, portanto, a orientação.

| Parâmetro | Página inteira | Compacto |
|---|---|---|
| `MARKER_SIZE` | 40 u (8,4 mm) | 32 u |
| `MARKER_INSET` | 36 u | 8 u |
| Centro (inset + size/2) | 56 u das bordas | 24 u das bordas |
| Furo da âncora (40%) | 16 u | ~13 u |

Posições dos centros (`getMarkerPositions`):
```
tl = (cx, cy)                 tr = (W - cx, cy)
bl = (cx, H - cy)             br = (W - cx, H - cy)   ← âncora
```
onde `cx = cy = MARKER_INSET + MARKER_SIZE/2`. Para o A4: TL(56,56) TR(944,56) BL(56,1358) BR(944,1358).

---

## 5. Grade de Bolhas

### 5.1 Página inteira

| Constante | Valor | Físico |
|---|---|---|
| `HEADER_H` | 264 u | região do cabeçalho |
| `GRID_TOP` | 285 u | início da grade |
| `GRID_BOTTOM` | `CANON_H - 90` = 1324 u | fim da grade |
| `ROW_H` | 40 u | 8,4 mm por linha |
| `BUBBLE_R` | 11 u | raio (Ø 4,62 mm) |
| `LABEL_W` | 44 u | coluna do número |

Linhas por coluna = `floor((1324 − 285) / 40) = 25`.
`optGap = min(46, (colW − LABEL_W − 24) / opt)`; `startX = colX + LABEL_W + BUBBLE_R + 6`.

### 5.2 Compacto

| Constante | Valor |
|---|---|
| `GRID_TOP` | 60 u |
| `GRID_BOTTOM` | 400 u |
| `ROW_H` | 34 u |
| `BUBBLE_R` | 11 u |

Linhas por coluna = `floor((400 − 60) / 34) = 10`.

### 5.3 Cabeçalho de alternativas
As letras A–E são impressas em negrito **acima** da primeira questão de cada coluna (`y = labelY − 22`). As bolhas são círculos vazios (sem letra dentro).

---

## 6. Marcadores de Coluna (só página inteira)

Pequenos quadrados pretos acima da primeira e abaixo da última questão de **cada coluna**. Servem para **calibrar o espaçamento vertical de cada coluna** após o warp (corrige distorções residuais).

| Constante | Valor |
|---|---|
| `COL_MARKER_SIZE` | 14 u |
| `COL_MARKER_GAP` | 6 u (do marcador à borda da grade) |

Posições por `getColMarkerPositions(n, opt)` (centro em `colX + COL_MARKER_SIZE/2`, topo/base deslocados de `ROW_H/2 + GAP + SIZE/2`).

> ⚠️ Estes marcadores **não** são usados para o warp. A detecção dos 4 cantos os ignora por construção (ver §9.3). No compacto eles foram removidos por interferirem e por não caberem bem.

---

## 7. Borda do Cartão (warp do compacto)

O compacto imprime uma **borda preta** (`strokeRect`, 1,5 px) rente à borda canônica. O leitor a detecta e usa seus 4 cantos para o warp — pontos grandes e distantes dão uma homografia bem mais estável que os 4 quadradinhos. Ver §9.5.

---

## 8. Limites de Questões

### Compacto
`COMPACT_MAX_Q = 30` (3 colunas × 10 linhas).

### Página inteira (`fullMaxQuestions(opt)` em `app.js`)
```
rowsPerCol = 25
availW     = 880                  # CANON_W - 2*MARGIN
minColW    = opt*24 + 68          # opt*(2*BUBBLE_R+2) + LABEL_W + 24
maxCols    = floor(availW / minColW)
máximo     = maxCols * 25
```

| Alternativas | `minColW` | Colunas | **Máx. questões** |
|---|---|---|---|
| 5 | 188 | 4 | **100** |
| 4 | 164 | 5 | **125** |
| 3 | 140 | 6 | **150** |
| 2 | 116 | 7 | **175** |

O campo de questões no editor ajusta o `max` dinamicamente conforme layout e alternativas (`refreshQuestionsLimit`).

---

## 9. Pipeline OMR — Detalhado

### 9.1 Captura de imagem
- `getUserMedia`: `facingMode: environment`, `width: 1920`, `height: 1080` (ideais).
- **Frame ao vivo:** reduzido a `LIVE_WIDTH` (800 full / 420 compacto), proporção 16:9; `getImageData` com `willReadFrequently: true`.
- **Captura final:** resolução nativa (`videoWidth × videoHeight`).

### 9.2 Detecção de candidatos (`detectMarkers`)
```
1. RGBA → cinza
2. GaussianBlur 5×5 (BLUR_K)
3. threshold Otsu (THRESH_BINARY_INV)   → tinta preta vira branco (255)
4. findContours (RETR_TREE, CHAIN_APPROX_SIMPLE)
```
Filtro por contorno:

| Critério | Condição |
|---|---|
| Área | `imgArea*0.0001 ≤ area ≤ imgArea*0.04` |
| Forma | `approxPolyDP(0.05*perímetro)` → 4 vértices |
| Proporção | `0.6 < w/h < 1.6` |
| **Solidez** | `area / (w*h) > 0.80` → distingue **quadrado sólido** (marcador) de **anel** (bolha vazia) |
| Âncora (`hasChild`) | filho presente **e** `0.02*area < áreaDoFilho < 0.35*area` → furo pequeno/centrado (não anel de bolha) |

A solidez e o critério de tamanho do furo eliminam as bolhas (que são anéis com furo grande) — antes elas viravam falsas âncoras.

### 9.3 Seleção dos 4 cantos (`identifyMarkers`)
1. **Primário — extremos:** os 4 pontos extremos da nuvem (`tl=min(x+y)`, `br=max(x+y)`, `tr=max(x−y)`, `bl=min(x−y)`). Como o cartão preenche o quadro, os cantos são os extremos; marcadores de coluna/bolhas (interiores) são ignorados por construção.
2. **Fallback — ancorado:** para cada candidato com furo, filtra candidatos de tamanho semelhante (±4× área) e faz força-bruta entre eles.
3. **Fallback — força-bruta** sobre os maiores quadrados (até 16, C(16,4)=1820 combinações).

Validação geométrica (`validateGroup`, só geometria):
- razão de áreas dos 4 ≤ 4;
- **não colinear:** bbox dos 4 pontos com `min(largura,altura)/max ≥ 0.30`;
- proporção (lados) ≥ 0.30 (aceita retrato e paisagem);
- diagonal do quad ≥ 25% da diagonal da imagem.

### 9.4 Orientação pela âncora (pós-warp — `detectAnchorCornerInWarp`)
A seleção dos cantos não depende do furo (a 420 px ele some). A orientação é decidida **depois de um warp provisório**, onde o furo aparece grande (~13 px):
```
1. warp provisório (orientação por extremos)
2. amostra o CENTRO dos 4 cantos canônicos na imagem retificada
3. âncora = canto de centro mais claro (furo branco), exigindo margem ≥ 40 (0–255)
4. se a âncora não caiu em BR → reatribui papéis por orientByAnchorPoint
   (BR = âncora; TL = mais distante; TR/BL pelo lado da diagonal, via produto vetorial)
   e refaz o warp
```
Robusto a qualquer rotação (0/90/180/270 e intermediárias).

### 9.5 Warp de perspectiva
- **Página inteira (`warpToCanonical`):** `getPerspectiveTransform(marcadores → getMarkerPositions)`, saída 1000×1414.
- **Compacto (`warpByBorder`):** detecta a borda (`detectCardBorder`) e mapeia seus cantos → retângulo canônico `(0,0)–(canonW,canonH)`.
  - `detectCardBorder`: contornos `RETR_LIST`, `area ≥ 3% da imagem`, `approxPolyDP(0.02*perímetro)` convexo de 4 lados; aceita só o quad cujos 4 cantos **abraçam** os marcadores (cada canto a ≤ 20% da diagonal dos marcadores). Se nenhum casar → cai no warp por marcadores.

### 9.6 Binarização (`binarize`)
```
GaussianBlur 5×5 → adaptiveThreshold(GAUSSIAN_C, BINARY_INV, block=25, C=7)
```
Tinta escura → 255; papel → 0. Adaptativa para tolerar iluminação desigual.

### 9.7 Calibração por coluna (`refineWithColMarkers`, só página inteira)
Para cada coluna, procura os marcadores de coluna (±22 u em torno da posição nominal, exigindo `minWhite = SIZE²*0.25`) e recalcula o espaçamento vertical das linhas.
**Trava de sanidade:** se o espaçamento calibrado sair de `0.7×–1.3× ROW_H`, descarta (mantém o nominal). Só roda se `layoutMod.HAS_COL_MARKERS`.

### 9.8 Amostragem das bolhas (`sampleBubbles`)
```
ROI = quadrado de lado 2*ceil(BUBBLE_R * ROI_FACTOR) = 2*ceil(11*0.65)=16 px, centrado na bolha
fillRatio = countNonZero(ROI) / área
```
`ROI_FACTOR = 0.65` amostra só o interior (evita a borda impressa do círculo).

### 9.9 Decisão por questão (`decideAnswers`)

| Status | Condição |
|---|---|
| `ok` | 1 bolha ≥ `FILL_MIN` **e** (1ª − 2ª) ≥ `MARGIN_MIN` |
| `low_conf` | 1 bolha ≥ `FILL_MIN` mas margem < `MARGIN_MIN`; ou nenhuma ≥ `FILL_MIN` mas `max ≥ FILL_MIN*0.7` |
| `blank` | nenhuma ≥ `FILL_MIN` **e** `max < FILL_MIN*0.7` (= 0.28) |
| `multi` | 2+ bolhas ≥ `FILL_MIN` |

`FILL_MIN = 0.40`, `MARGIN_MIN = 0.10`.

### 9.10 Correção (`gradeAnswers`)
```
right = (status === 'ok') && (marked === gabarito[q-1].toUpperCase())
score = nº de right;  pct = round(score/total*100)
```
Só `ok` conta como acerto; `blank`/`multi`/`low_conf` são erro.

### 9.11 Anotação (`annotateCanvas`)
Círculo grosso na bolha marcada (verde = certo, vermelho = errado, cinza = branco-mas-marcado); círculo fino verde na alternativa correta quando o aluno errou.

---

## 10. Quality Gate — Captura ao Vivo (`liveDetectionLoop`)

Acumula um contador de estabilidade; dispara ao atingir `STABLE_FRAMES`. Tolerante a tremor e a piscas de detecção:

| Parâmetro | Valor | Papel |
|---|---|---|
| `STABLE_FRAMES` | 6 (full) / 15 (compacto) | frames estáveis para auto-disparo |
| `MAX_DRIFT` | 45 px | tolerância de tremor entre frames (no frame reduzido) |
| `MAX_MISS` | 12 | transientes (pisca/tremor) tolerados antes de resetar (~0,4 s) |
| `SHARP_MIN` | 80 | variância mínima do Laplaciano (nitidez) |

Lógica:
- **Estável** (marcadores válidos + dentro de `MAX_DRIFT`): incrementa o contador; se borrado (`< SHARP_MIN`) segura o contador e aguarda foco; ao zerar o restante, **dispara**.
- **Transiente** (pisca de detecção **ou** pulo de tremor além de `MAX_DRIFT`): **não reseta** — segura o progresso por até `MAX_MISS` frames (mantendo a referência) e continua desenhando os marcadores (sem blink). Só reseta se a perda/movimento for **sustentado**.
- **Captura manual:** botão "📸 Capturar" ignora o gate.

Nitidez: `Laplacian(cinza)` → `stdDev²`; `< 80` = borrado.

---

## 11. Geração / Impressão

| Parâmetro | Valor |
|---|---|
| `PRINT_W` | 2079 px (~250 DPI em 210 mm) |
| Página inteira | 2079 × 2940 px (A4 retrato) |
| Compacto | `canonW*2.079 × 460*2.079` (largura adaptativa) |
| Exibição na tela | CSS `width ≤ 520px` (resolução real preservada no `toDataURL`) |
| Saída | PNG (`toDataURL('image/png')`) |
| Impressão compacto | `width: 190mm`, altura automática, margem 10 mm |
| Impressão A4 | `210mm × 297mm`, `@page margin 0` |

> ⚠️ Imprimir a **100% (sem "ajustar à página")** — escalonamento desloca os marcadores e degrada o warp.

---

## 12. Parâmetros Completos (referência)

### 12.1 `layout.js` (página inteira)
`CANON_W=1000`, `CANON_H=1414`, `MARGIN=60`, `MARKER_SIZE=40`, `MARKER_INSET=36`, `HEADER_H=264`, `GRID_TOP=285`, `GRID_BOTTOM=1324`, `ROW_H=40`, `BUBBLE_R=11`, `LABEL_W=44`, `USE_BORDER_WARP=false`, `HAS_COL_MARKERS=true`, `COL_MARKER_SIZE=14`, `COL_MARKER_GAP=6`, `STABLE_FRAMES=6`, `LIVE_WIDTH=800`.

### 12.2 `layout-compact.js` (compacto)
`CANON_H=460`, `SIDE_MARGIN=68`, `MARKER_SIZE=32`, `MARKER_INSET=8`, `GRID_TOP=60`, `GRID_BOTTOM=400`, `ROW_H=34`, `BUBBLE_R=11`, `LABEL_W=36`, `OPT_GAP=38`, `COL_GAP=48`, `COL_MARKER_SIZE=12`, `COL_MARKER_GAP=4`, `USE_BORDER_WARP=true`, `HAS_COL_MARKERS=false`, `STABLE_FRAMES=15`, `LIVE_WIDTH=420`.

### 12.3 OMR (compartilhados, ambos os layouts)
`FILL_MIN=0.40`, `MARGIN_MIN=0.10`, `ROI_FACTOR=0.65`, `ADAPT_BLOCK=25`, `ADAPT_C=7`, `BLUR_K=5`, `SHARP_MIN=80`.

### 12.4 Detecção (constantes no `omr.js`)
minArea `0.0001*img`, maxArea `0.04*img`, approx `0.05*peri`, aspect `0.6–1.6`, solidez `>0.80`, furo da âncora `0.02–0.35` da área; bbox não-colinear `≥0.30`, proporção `≥0.30`, diagonal `≥0.25*imgDiag`; borda: area `≥0.03*img`, approx `0.02*peri`, cantos `≤0.20*markerDiag`; orientação pós-warp: margem de brilho `≥40`.

### 12.5 Captura ao vivo (`app.js`)
`MAX_DRIFT=45`, `MAX_MISS=12`, `COMPACT_MAX_Q=30`.

---

## 13. Persistência (IndexedDB)

Banco `omr-corretor` (v1), dois object stores:

**`exams`** — `keyPath: 'id'`
```json
{ "layout": "full|compact", "id": "...", "title": "...", "n": 20, "opt": 5, "k": "ABCDE..." }
```

**`results`** — `keyPath: 'capturedAt'`, índice `examId`
```json
{
  "examId": "AVA01-INT", "student": "", "score": 17, "total": 20, "pct": 85,
  "capturedAt": "2026-06-06T12:34:56.000Z",
  "answers": [
    { "q": 1, "marked": "B", "correct": "A", "status": "ok", "right": false,
      "ratios": [0.03, 0.77, 0.02, 0.04, 0.29] }
  ]
}
```
Exportação disponível em **CSV** e **JSON** na tela de resultado.

---

## 14. Stack e Dependências

| Tecnologia | Uso |
|---|---|
| **OpenCV.js 4.8.0 (WASM ~8 MB)** | threshold, findContours, getPerspectiveTransform, warpPerspective, adaptiveThreshold, Laplacian, moments |
| JavaScript ES2022 (modules) | lógica da aplicação |
| Canvas API | captura, render, anotação |
| getUserMedia | câmera traseira |
| IndexedDB | provas + resultados |
| Service Worker + Manifest | PWA offline/instalável |

OpenCV é a **única dependência externa**, carregada *lazy* de `docs.opencv.org/4.8.0/opencv.js` ~300 ms após `DOMContentLoaded`. Cache versionado via `?v=N` nos imports (atual: `v=38`).

---

## 15. Limitações Conhecidas e Recomendações

| Situação | Recomendação / causa |
|---|---|
| Cartão ao longe | enquadrar até preencher o quadro (especialmente o A4 retrato) |
| Sombra sobre os marcadores | luz uniforme; a binarização adaptativa ajuda mas não resolve tudo |
| Impressão escalonada | imprimir sempre a 100% |
| Caneta de ponta fina | pode gerar `fillRatio < FILL_MIN`; preferir esferográfica |
| Frame ao vivo a 800 px (A4) | mais CPU; se houver lentidão, reduzir `LIVE_WIDTH` para ~640 |
| Marcadores de coluna no A4 | não usados no warp; só calibração (com trava de sanidade) |

---

## 16. Fórmulas de Referência Rápida

```
# físico (A4): mm = (u / 1000) * 210
# linhas por coluna:        floor((GRID_BOTTOM - GRID_TOP) / ROW_H)
#   full = 25 ; compacto = 10
# máx. questões (full):     floor(880 / (opt*24+68)) * 25
# largura compacto:         2*68 + cols*(64+(opt-1)*38) + (cols-1)*48
# ROI da bolha:             lado = 2*ceil(BUBBLE_R*0.65) = 16 px ; fillRatio = nonZero/área
# diagonal mínima de quad:  sqrt(imgW²+imgH²) * 0.25
```

---

*Documento gerado a partir de `layout.js`, `layout-compact.js`, `omr.js`, `app.js`, `generator.js` e `db.js` (código `?v=38`).*
