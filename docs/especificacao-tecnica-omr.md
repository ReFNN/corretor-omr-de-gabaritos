# Corretor OMR — Especificação Técnica

> Versão do protótipo: 1.0  
> Data: 2026-06-03  
> Tecnologia principal: OpenCV.js + Vanilla JS (ES Modules) + PWA

---

## 1. Visão Geral

O sistema é um **leitor óptico de gabaritos (OMR — Optical Mark Recognition)** que funciona inteiramente no navegador, sem backend. O usuário fotografa um cartão-resposta impresso com a câmera do celular; o sistema detecta os marcadores fiduciais nos cantos, corrige a perspectiva da imagem, lê o preenchimento de cada bolha e compara com o gabarito configurado.

### Fluxo geral

```
Câmera → Frame de vídeo → Detecção de marcadores → Warp de perspectiva
→ Binarização adaptativa → Amostragem de bolhas → Decisão por questão
→ Correção contra gabarito → Resultado (score + tabela + imagem anotada)
```

### Arquitetura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `js/layout.js` | **Fonte única de verdade** — todas as constantes de layout e coordenadas |
| `js/generator.js` | Geração do cartão-resposta em canvas (impressão) |
| `js/omr.js` | Pipeline completo de detecção, warp, leitura e correção |
| `js/app.js` | Controlador de telas, câmera, estado global |
| `js/db.js` | Persistência IndexedDB para resultados |
| `index.html` | SPA com 4 telas: Home, Captura, Resultado, Editor |

---

## 2. Espaço Canônico

O sistema trabalha com um **espaço canônico de referência** de dimensões fixas. Todos os cálculos de posição — geração e leitura — usam essas coordenadas. Isso garante que o gerador e o leitor nunca divirjam.

| Constante | Valor | Significado |
|---|---|---|
| `CANON_W` | **1000 u** | Largura canônica |
| `CANON_H` | **1414 u** | Altura canônica |
| Proporção | **1 : 1.414** | Equivale exatamente a A4 retrato (210 × 297 mm) |
| `MARGIN` | **60 u** | Margem interna mínima em todos os lados |

A escala canônica → física: `1 u = 210mm / 1000 = 0.21 mm`

---

## 3. Marcadores Fiduciais

Quatro marcadores pretos são impressos nos cantos do cartão. São usados para:
1. Detectar que o cartão está no enquadramento
2. Calcular a transformação de perspectiva para o espaço canônico
3. Identificar a orientação do cartão (portrait/landscape/invertido)

### Especificações físicas

| Parâmetro | Canônico | Físico (A4) |
|---|---|---|
| `MARKER_SIZE` | **40 u** | **8.4 mm** de lado |
| `MARKER_INSET` | **36 u** | **7.56 mm** da borda do papel |
| Centro do marcador | `INSET + SIZE/2 = 56 u` | **11.76 mm** da borda |
| Furo interno (âncora) | `40 × 0.40 = 16 u` | **3.36 mm** de lado |

### Posições dos centros (espaço canônico)

| Marcador | X | Y | Tipo |
|---|---|---|---|
| TL (topo-esquerda) | 56 | 56 | Quadrado sólido |
| TR (topo-direita) | 944 | 56 | Quadrado sólido |
| BL (base-esquerda) | 56 | 1358 | Quadrado sólido |
| **BR (base-direita)** | **944** | **1358** | **Âncora — quadrado com buraco interno** |

### Marcador âncora (BR)

O marcador BR possui um **quadrado branco interno** de 40% do seu tamanho (3.36 mm). No mapa de contornos do OpenCV (`RETR_TREE`), esse buraco aparece como contorno filho (`hasChild = true`), o que permite identificar unicamente esse canto e determinar a orientação do cartão.

**Por que o âncora é crítico:** Um cartão pode ser fotografado em 4 orientações (0°, 90°, 180°, 270°). O âncora no canto BR é o único marcador assimétrico — ele sempre identifica qual canto é qual.

---

## 4. Layout do Cabeçalho

| Parâmetro | Valor canônico |
|---|---|
| `HEADER_H` | **280 u** (primeiros 280 pixels de altura) |
| Conteúdo | Título, ID, nº questões/alternativas, linha Aluno, linha Data, instrução |

O cabeçalho ocupa a região Y: 0 → 280 u. A área de bolhas começa em `GRID_TOP = 340 u` (após uma margem de separação de 60 u abaixo do cabeçalho).

---

## 5. Grade de Bolhas

### Parâmetros

| Constante | Valor | Físico |
|---|---|---|
| `GRID_TOP` | **340 u** | Início da grade (Y) |
| `GRID_BOTTOM` | **1324 u** | `CANON_H - 90` |
| `ROW_H` | **40 u** | Altura por linha de questão = **8.4 mm** |
| `BUBBLE_R` | **11 u** | Raio da bolha = **2.31 mm** (diâmetro **4.62 mm**) |
| `LABEL_W` | **44 u** | Largura da coluna do número da questão |

### Capacidade por coluna

```
Área disponível = GRID_BOTTOM - GRID_TOP = 1324 - 340 = 984 u
Questões por coluna = floor(984 / ROW_H) = floor(984 / 40) = 24 questões
```

### Número de colunas

O layout distribui automaticamente as questões em múltiplas colunas quando necessário:

```
colunas = ceil(n / 24)
questões por coluna = ceil(n / colunas)
largura por coluna = (CANON_W - 2 × MARGIN) / colunas = 880 / colunas
```

Exemplos:

| Questões | Colunas | Questões/coluna |
|---|---|---|
| 1 – 24 | 1 | até 24 |
| 25 – 48 | 2 | até 24 |
| 49 – 72 | 3 | até 24 |
| 73 – 100 | 5 | até 20 |

### Posicionamento das bolhas (1 coluna, 5 alternativas)

```
optGap = min(46, (880 - 44 - 24) / 5) = min(46, 162.4) = 46 u = 9.66 mm entre centros
startX = MARGIN + LABEL_W + BUBBLE_R + 6 = 60 + 44 + 11 + 6 = 121 u

A: x = 121 u  (25.4 mm do esquerdo)
B: x = 167 u  (35.1 mm)
C: x = 213 u  (44.7 mm)
D: x = 259 u  (54.4 mm)
E: x = 305 u  (64.1 mm)
```

### Cabeçalho de colunas

As letras A, B, C, D, E são impressas em negrito **acima** da primeira questão de cada coluna (`y = primeiraQuestão.labelY - 22 u`). Não há letras dentro das bolhas — as bolhas são círculos vazios limpos.

---

## 6. Qualidade de Impressão

| Parâmetro | Valor |
|---|---|
| Resolução do canvas | **2079 × 2940 px** |
| DPI equivalente | **~250 DPI** para A4 (210 mm) |
| Exibição na tela | CSS `width: 520px` (escalonado via CSS; `toDataURL` usa resolução real) |
| Formato de saída | PNG via `canvas.toDataURL('image/png')` |
| Instrução de impressão | "Tamanho 100%, sem ajustar à página" (crucial para escala correta) |

> **Atenção:** Se a impressora escalar o cartão (opção "ajustar à página" ativada), os marcadores ficam em posições físicas ligeiramente erradas e o warp de perspectiva perde precisão.

---

## 7. Pipeline OMR — Detalhamento Completo

### 7.1 Captura de imagem

- **Resolução solicitada:** `width: 1920, height: 1080` (via `getUserMedia`)
- **Detecção ao vivo:** frame reduzido a `LIVE_WIDTH = 420 px` (largura), proporção 16:9 → 420 × 236 px para processamento em tempo real
- **Captura final:** resolução nativa da câmera (`videoWidth × videoHeight`)

### 7.2 Detecção de Marcadores (`detectMarkers`)

**Pré-processamento:**
```
1. Converter para escala de cinza (RGBA → GRAY)
2. GaussianBlur kernel 5×5 (BLUR_K = 5)
3. Threshold de Otsu (THRESH_BINARY_INV)
   → Papel branco: 0 (preto)
   → Tinta preta: 255 (branco)
4. findContours (RETR_TREE, CHAIN_APPROX_SIMPLE)
```

**Filtro de candidatos:** Para cada contorno encontrado:

| Critério | Condição | Motivo |
|---|---|---|
| Área mínima | `area ≥ imgArea × 0.0001` | Elimina ruído sub-pixel |
| Área máxima | `area ≤ imgArea × 0.04` | Elimina grandes regiões de fundo |
| Forma | `approxPolyDP(5% × perímetro) = 4 vértices` | Seleciona apenas quadriláteros |
| Proporção | `0.6 < width/height < 1.6` | Garante forma aproximadamente quadrada |
| `hasChild` | Registrado para cada candidato | Indica buraco interno (âncora) |

**Busca por combinações (`identifyMarkers`):**

Para evitar falsos positivos (bordas da mesa, padrões do fundo), o algoritmo não simplesmente pega os 4 maiores candidatos. Em vez disso:

```
1. Ordenar candidatos por área CRESCENTE
   (marcadores do cartão tendem a ser menores que features grandes do fundo)

2. Testar todas as combinações C(min(N,15), 4) — máximo 1365 iterações
   Poda: se maior/menor área do grupo > 4×, interrompe (marcadores têm tamanho similar)

3. Para cada grupo de 4, executar checkGroupAsMarkers():
   a. Rejeitar se 2+ candidatos têm hasChild = true
      (bolhas vazias também têm hasChild; o grupo válido tem exatamente 0 ou 1 âncora)
   b. Calcular centróide dos 4 pontos
   c. Classificar em 4 quadrantes: TL, TR, BL, BR
   d. Rejeitar se algum quadrante tem ≠ 1 candidato
   e. Se âncora encontrado (hasChild=1): testar 4 rotações para colocar âncora no slot BR
   f. Validar proporção: min(largura,altura)/max(largura,altura) ≥ 0.35
      (aceita portrait, landscape e 180° invertido)
   g. Validar cobertura: diagonal do quad ≥ 30% da diagonal da imagem
      (rejeita detecções em objetos pequenos distantes)

4. Retornar o primeiro grupo válido encontrado (menor conjunto de marcadores válido)
```

### 7.3 Detecção de Orientação

| Situação | Ação |
|---|---|
| Âncora detectado, já no slot BR | Sem rotação — orientação padrão portrait |
| Âncora no slot BL (card landscape CCW) | Rotação 90° CCW no mapeamento |
| Âncora no slot TL (card invertido 180°) | Rotação 180° no mapeamento |
| Âncora no slot TR (card landscape CW) | Rotação 90° CW no mapeamento |
| Sem âncora detectado | Fallback por posição (assume portrait) |

As 4 rotações testadas no mapeamento canônico:

```js
rot0 (0°):   { tl, tr, bl, br }
rot1 (90°CW):  { tl: bl, tr: tl, bl: br, br: tr }
rot2 (180°):   { tl: br, tr: bl, bl: tr, br: tl }
rot3 (90°CCW): { tl: tr, tr: br, bl: tl, br: bl }
```

### 7.4 Warp de Perspectiva (`warpToCanonical`)

```
srcPts = [detected_TL, detected_TR, detected_BL, detected_BR]
dstPts = [canonical_TL=(56,56), canonical_TR=(944,56),
          canonical_BL=(56,1358), canonical_BR=(944,1358)]

M = getPerspectiveTransform(srcPts, dstPts)
warped = warpPerspective(src, M, size=(1000, 1414))
```

Resultado: imagem canônica de **1000 × 1414 px**, retrato, sem distorção de perspectiva. A partir daqui, todas as coordenadas são diretas (sem conversão de escala).

### 7.5 Binarização Adaptativa (`binarize`)

```
1. GaussianBlur 5×5 sobre a imagem canônica em cinza
2. adaptiveThreshold:
   - Método: ADAPTIVE_THRESH_GAUSSIAN_C
   - Tipo: THRESH_BINARY_INV
   - Block size: 25 px (ADAPT_BLOCK)
   - Constante C: 7 (ADAPT_C)
```

**Resultado:**
- Papel branco → `0` (preto)
- Tinta/marcação escura → `255` (branco)

A binarização adaptativa (vs. global) é essencial para lidar com iluminação desigual — sombras e variações de luz que são inevitáveis em fotografias com celular.

### 7.6 Amostragem das Bolhas (`sampleBubbles`)

Para cada bolha em cada questão, calculada com `getBubbleCoords(n, opt)`:

```
ROI_radius = ceil(BUBBLE_R × ROI_FACTOR) = ceil(11 × 0.65) = ceil(7.15) = 8 px
ROI = quadrado de (2 × 8) = 16 × 16 = 256 pixels centrado em (b.x, b.y)

fillRatio = countNonZero(patch) / 256
           = pixels brancos (tinta) / área total
```

**Por que ROI_FACTOR = 0.65 e não 1.0?**

Com `ROI_FACTOR = 1.0`, o ROI abrangeria a borda impressa do círculo (linha preta). Essa borda, após binarização, gera pixels brancos que inflam o `fillRatio` de bolhas vazias. Com `0.65`, o ROI captura **apenas o interior** da bolha — onde está (ou não está) a marcação do aluno:

```
Bolha vazia    → interior = papel branco → 0 na binária → fillRatio ≈ 0.00 – 0.05
Bolha marcada  → interior = tinta escura → 255 na binária → fillRatio ≈ 0.65 – 0.90
```

### 7.7 Decisão por Questão (`decideAnswers`)

| Status | Condição | Significado |
|---|---|---|
| `ok` | 1 bolha ≥ 0.40 E (1ª − 2ª) ≥ 0.10 | Resposta clara e única |
| `low_conf` | 1 bolha ≥ 0.40 mas margem < 0.10 | Marcação limítrofe |
| `blank` | Nenhuma bolha ≥ 0.40 E max < 0.28 | Questão em branco |
| `low_conf` | Nenhuma ≥ 0.40 mas max ≥ 0.28 | Traço fraco / indefinido |
| `multi` | 2+ bolhas ≥ 0.40 | Múltiplas marcações |

Parâmetros de decisão:

| Constante | Valor | Papel |
|---|---|---|
| `FILL_MIN` | **0.40** | Limiar mínimo para considerar bolha marcada |
| `MARGIN_MIN` | **0.10** | Diferença mínima 1ª → 2ª para status `ok` |

**Faixa de segurança observada empiricamente:**

```
Bolha vazia (fundo/letra âncora): 0.00 – 0.31
Zona de ambiguidade:              0.31 – 0.40  ← FILL_MIN fica aqui
Bolha marcada (caneta):           0.65 – 0.90
```

### 7.8 Correção contra Gabarito (`gradeAnswers`)

```
Para cada questão q (1 a n):
  correct = gabarito[q-1].toUpperCase()
  right   = (status === 'ok') AND (marked === correct)

score = count(answers where right = true)
pct   = round(score / total × 100)
```

Apenas respostas com status `ok` são contadas como acertos. Respostas `blank`, `multi` e `low_conf` são sempre erros.

---

## 8. Quality Gate — Detecção ao Vivo

Antes do auto-disparo, o sistema verifica 4 condições em sequência. Todas devem ser satisfeitas por `STABLE_FRAMES = 5` frames consecutivos:

| Gate | Condição | Mensagem ao usuário |
|---|---|---|
| 1. Marcadores | 4 marcadores detectados e válidos | "🔍 Procurando marcadores nos cantos…" |
| 2. Enquadramento | Todos os 4 marcadores dentro de 5% das bordas | "↔ Afaste-se para ver os 4 cantos" |
| 3. Nitidez | Variância do Laplaciano ≥ `SHARP_MIN = 80` | "🔀 Imagem borrada — segure firme!" |
| 4. Estabilidade | 5 frames passando gates 1+2+3 | "✓ Segure firme… (N)" |

**Captura manual:** O botão "📸 Capturar" permite forçar a captura independente do quality gate — útil quando a detecção ao vivo falha mas o usuário sabe que o cartão está posicionado.

**Cálculo de nitidez (sharpness):**
```
Laplacian(gray_frame) → stdDev² = variância
Se variância < 80 → imagem borrada (motion blur ou foco ruim)
```

---

## 9. Parâmetros Completos

### 9.1 Layout (layout.js)

| Constante | Valor | Unidade |
|---|---|---|
| `CANON_W` | 1000 | px canônico |
| `CANON_H` | 1414 | px canônico |
| `MARGIN` | 60 | px canônico |
| `MARKER_SIZE` | 40 | px canônico |
| `MARKER_INSET` | 36 | px canônico |
| `HEADER_H` | 280 | px canônico |
| `GRID_TOP` | 340 | px canônico |
| `GRID_BOTTOM` | 1324 | px canônico |
| `ROW_H` | 40 | px canônico |
| `BUBBLE_R` | 11 | px canônico |
| `LABEL_W` | 44 | px canônico |

### 9.2 OMR (layout.js)

| Constante | Valor | Efeito ao aumentar | Efeito ao diminuir |
|---|---|---|---|
| `FILL_MIN` | 0.40 | Mais exigente → mais brancos | Mais sensível → mais falsos positivos |
| `MARGIN_MIN` | 0.10 | Mais exigente → mais `low_conf` | Mais permissivo → menos `low_conf` |
| `ROI_FACTOR` | 0.65 | Evita menos borda | Amostra interior menor → mais limpo mas pode perder marca leve |
| `ADAPT_BLOCK` | 25 | Threshold mais global | Threshold mais local (sensível a variações micro) |
| `ADAPT_C` | 7 | Mais conservador (menos falsos branco) | Mais agressivo (detecta marcas mais claras) |
| `BLUR_K` | 5 | Mais suavização (menos ruído) | Menos suavização (mais detalhe, mais ruído) |

### 9.3 Câmera / Live (layout.js)

| Constante | Valor | Justificativa |
|---|---|---|
| `SHARP_MIN` | 80 | Variância do Laplaciano mínima para imagem nítida |
| `STABLE_FRAMES` | 5 | Frames @~30fps = ~0.17s de estabilidade |
| `LIVE_WIDTH` | 420 | Balanceia performance vs. precisão na detecção ao vivo |

---

## 10. Stack Tecnológica

| Tecnologia | Versão | Uso |
|---|---|---|
| **OpenCV.js** | 4.8.0 (WASM) | Processamento de imagem (threshold, warpPerspective, findContours, Laplacian) |
| JavaScript | ES2022 (modules) | Lógica de aplicação |
| Canvas API | Nativa | Captura, renderização, anotação |
| getUserMedia | Nativa | Câmera traseira (`facingMode: 'environment'`) |
| IndexedDB | Nativa | Persistência de resultados de correção |
| localStorage | Nativa | Gabarito único configurado |
| Service Worker | Nativa | PWA offline |
| CSS3 | Nativa | Layout mobile-first, max-width 600px |

---

## 11. Dependências Externas

O protótipo simplificado tem **zero dependências de CDN** em runtime. A única dependência carregada dinamicamente é:

| Biblioteca | URL | Tamanho | Quando |
|---|---|---|---|
| OpenCV.js | `docs.opencv.org/4.8.0/opencv.js` | ~8 MB (WASM) | Lazy — carregado 300ms após DOMContentLoaded |

> O OpenCV é carregado em background. O spinner "Carregando motor de visão computacional…" é exibido até o WASM estar pronto (`cv.Mat` disponível ou `cv.onRuntimeInitialized` disparado).

---

## 12. Persistência de Dados

### localStorage
- Chave: `omr-exam`
- Formato: `{ id, title, n, opt, k }`
- Conteúdo: gabarito único configurado

### IndexedDB — banco `omr-corretor` (versão 1)

**Object store `results`**
- Chave: `capturedAt` (ISO 8601)
- Índice: `examId`
- Campos: `{ examId, student, score, total, pct, answers[], capturedAt }`

**Cada item em `answers[]`:**
```json
{
  "q": 1,
  "marked": "B",
  "correct": "A",
  "status": "ok",
  "right": false,
  "ratios": [0.03, 0.77, 0.02, 0.04, 0.29]
}
```

---

## 13. Limitações Conhecidas e Recomendações

### Para o usuário

| Situação | Recomendação |
|---|---|
| Cartão ao longe / marcadores pequenos | Aproximar até o cartão ocupar ≥ 60% do frame |
| Sombra sobre os marcadores | Usar iluminação uniforme (luz natural difusa ideal) |
| Foto borrada | O auto-disparo aguarda nitidez; usar "Capturar" só quando estável |
| Impressão com "Ajustar à página" | Sempre imprimir a 100%, sem escalonamento |
| Caneta de ponta muito fina | Pode gerar fillRatio < 0.40; usar caneta esferográfica |

### Limitações técnicas

| Limitação | Causa | Mitigação futura |
|---|---|---|
| Cartão com fundo texturizado pode confundir detector | minArea pequena detecta features do fundo | Aumentar `MARKER_SIZE` para 60–80 u |
| Marcadores muito pequenos em fotos distantes | `approxPolyDP` não gera quadrilátero para círculos sub-pixel | Aumentar tamanho físico dos marcadores |
| `FILL_MIN` fixo para qualquer instrumento | Caneta vs. lápis têm densidades diferentes | Calibração por auto-normalização local |
| Detecção ao vivo limitada a 420px | Performance no WASM em dispositivos antigos | Reduzir para 320px se necessário |

---

## 14. Métricas de Desempenho Típicas

Medidas em dispositivo Android mid-range (2023):

| Etapa | Tempo típico |
|---|---|
| Carregamento OpenCV.js | 2–5 s (WASM, primeira vez) |
| Detecção ao vivo por frame | 15–40 ms |
| Warp de perspectiva (1920×1080) | 20–60 ms |
| Binarização adaptativa | 10–30 ms |
| Amostragem 20 questões × 5 alternativas | < 5 ms |
| Pipeline completo (captura → resultado) | **100–200 ms** |

---

## 15. Fórmulas de Referência Rápida

```
# Tamanho físico de qualquer elemento (mm)
fisico_mm = (valor_canonico / CANON_W) × 210

# Número máximo de questões suportadas
max_questoes = floor((GRID_BOTTOM - GRID_TOP) / ROW_H) × max_colunas
             = 24 × floor(CANON_W / colW_minima)

# fillRatio de uma bolha
ROI_lado = 2 × ceil(BUBBLE_R × ROI_FACTOR) = 2 × ceil(11 × 0.65) = 16 px
fillRatio = countNonZero(ROI_16x16) / 256

# Diagonal mínima de detecção
quadDiag_minima = sqrt(imgW² + imgH²) × 0.30
```

---

*Documento gerado a partir do código-fonte do protótipo em `js/layout.js`, `js/omr.js` e `js/generator.js`.*
