# Plano de Implementação — Corretor de Gabaritos (OMR)

---

## 1. Objetivo

Aplicativo **web, mobile-first**, que **corrige cartões-resposta de múltipla escolha por visão computacional (OMR — Optical Mark Recognition)**, usando a câmera do celular. O sistema também gera um cartão-resposta imprimível para testes.

O **foco do projeto é o corretor**. A geração do cartão deve ser simples, contanto que produza tudo que a correção precisa (marcadores de alinhamento, grade de bolhas e QR Code).

Premissas de produto:
- Acesso pelo navegador (mobile-first). Funciona offline depois de carregado (PWA).
- Processamento **no navegador** (client-side). Um backend é **opcional** e só entra se houver necessidade futura de lote/relatórios.
- Privacidade: as imagens não precisam sair do dispositivo no fluxo padrão.

---

## 2. Fluxo de uso (visão de produto)

O ponto central: **o QR e o cartão são lidos em momentos separados.**

1. **Identificar a prova** — o usuário aponta a câmera para o **QR Code** (impresso no cabeçalho do cartão ou em um cartão-mestre). O QR contém **ID da prova + gabarito**. O app decodifica e carrega a prova na memória.
2. **Corrigir o cartão** — o usuário fotografa o **cartão-resposta preenchido pelo aluno**. A leitura deve ser **automática**: ao detectar os 4 marcadores alinhados e a imagem estável/nítida, o app **dispara a captura sozinho**. Um **botão manual de captura** também deve existir, sempre disponível.
3. **Resultado** — o app compara as marcações detectadas com o gabarito carregado no passo 1 e mostra a nota, o detalhamento por questão e os casos especiais (em branco, marcação dupla).

Separar a leitura do QR da foto do cartão é intencional: a decodificação do QR pede um enquadramento fechado e nítido, enquanto a leitura OMR pede a folha inteira no quadro. Tratar as duas como etapas distintas aumenta a confiabilidade das duas.

---

## 3. Escopo

**Dentro do escopo (MVP):**
- Gerador simples de cartão-resposta em PDF (A4) com marcadores, grade de bolhas e QR.
- Leitura de QR (identificação de prova + gabarito).
- Captura por câmera com **disparo automático** + **disparo manual**.
- Pipeline OMR: alinhamento por marcadores, correção de perspectiva, leitura das bolhas, decisão por questão.
- Correção contra o gabarito e tela de resultado, com exportação (CSV/JSON).
- Múltiplas questões e 2–5 alternativas por questão (A–E).
- Detecção de **questão em branco** e **marcação dupla/ambígua**.



---

## 4. Arquitetura

```
[ Câmera (getUserMedia) ]
        │ frames
        ▼
[ Detector ao vivo ]  ── marcadores? nitidez? estável? ──► dispara captura (auto) ou botão (manual)
        │ still em alta resolução
        ▼
[ Pipeline OMR (OpenCV.js / WASM) ]
   detectar marcadores → warpPerspective (espaço canônico) → binarização adaptativa
   → amostrar bolhas nas coordenadas do template → decidir por questão
        │ marcações
        ▼
[ Correção ]  ◄── gabarito (carregado antes via QR)
        │
        ▼
[ Resultado + export ]
```

- **Front-end**: **React** (SPA mobile-first). Componentes funcionais + Hooks. Sugestão de ferramentas: **Vite** para build/dev server, **React Router** para navegação entre telas, e gerenciamento de estado leve (Context API ou Zustand) — Redux é desnecessário. TypeScript é recomendado.
  - *Integração com a câmera e o OpenCV.js (imperativos) dentro do React*: usar `useRef` para os elementos `<video>` e `<canvas>` e para o handle do OpenCV; o **loop de detecção ao vivo** roda via `requestAnimationFrame` dentro de um `useEffect` (com `cancelAnimationFrame` no cleanup), **fora** do ciclo de render do React — não disparar `setState` a cada frame, apenas quando o estado de UI mudar de fato (ex.: gate passou, dica de texto mudou). O OpenCV.js é um **global carregado por `<script>`/WASM**, não um módulo npm idiomático: carregá-lo sob demanda (lazy) e só renderizar as telas de câmera/correção após `onRuntimeInitialized`.
- **Visão computacional**: **OpenCV.js** (build WASM) carregado sob demanda (lazy-load) com tela de carregamento, pois o WASM é grande (~8 MB).
- **Leitura de QR**: biblioteca dedicada (ex.: `jsQR` — leve; ou `zxing-js` — mais robusto). Rodando sobre frames da câmera.
- **Geração de PDF**: `pdf-lib` + gerador de QR. Em React, preferir o pacote `qrcode` (programático, retorna data URL — mais idiomático que o `qrcodejs` baseado em DOM). Alternativa aceitável para o cartão: layout HTML/CSS com `@media print`.
- **Persistência local**: IndexedDB para provas carregadas e resultados. (Não usar mecanismos que exijam servidor.)
- **PWA**: `manifest.json` + service worker para uso offline e cache do WASM.
- **Backend (opcional, fase futura)**: Python + FastAPI + OpenCV (ou o projeto open-source **OMRChecker**) para correção em lote e relatórios. Não é necessário para o MVP.

---

## 5. Estratégia técnica central — leitura **por template**, não cega

Como o cartão é **gerado pelo próprio sistema**, não é preciso "descobrir" onde estão as bolhas via detecção de contornos genérica (abordagem frágil em foto de celular). A abordagem correta é **baseada em template**: as coordenadas de cada bolha são **conhecidas de antemão** e a imagem é **alinhada por marcadores fiduciais** antes da leitura. É a mesma filosofia do projeto OMRChecker, que é a referência mais robusta da área.

**Regra de ouro:** o **gerador** e o **corretor** devem compartilhar **a mesma especificação de layout** (a mesma função/constantes que calculam as coordenadas). O gerador desenha nessas coordenadas; o corretor, após corrigir a perspectiva para o espaço canônico, **amostra exatamente nessas mesmas coordenadas**. Isso elimina a adivinhação e é o que torna a leitura confiável.

---

## 6. Layout canônico (fonte única de verdade)

Defina o layout em um **espaço canônico em pixels**, independente de resolução. Tanto o gerador (ao desenhar o PDF) quanto o corretor (ao fazer o `warpPerspective`) usam **estas mesmas coordenadas**.

**Constantes do espaço canônico** (proporção A4 retrato ≈ 1 : 1,414):

| Constante | Valor sugerido | Observação |
|---|---|---|
| `CANON_W` | 1000 px | largura canônica |
| `CANON_H` | 1414 px | altura canônica |
| `MARGIN` | 60 px | margem externa |
| `MARKER_SIZE` | 40 px | lado do quadrado do marcador |
| `MARKER_INSET` | 36 px | distância da borda da folha ao marcador |
| `HEADER_H` | 280 px | faixa de cabeçalho (título, ID, nome, QR) |
| `GRID_TOP` | 340 px | topo da área de bolhas |
| `GRID_BOTTOM` | `CANON_H - 90` | base da área de bolhas |
| `ROW_H` | 40 px | altura de cada linha de questão |
| `BUBBLE_R` | 11 px | raio do círculo |
| `LABEL_W` | 44 px | largura reservada ao número da questão |

**Posições dos 4 marcadores** (centros), em coordenadas canônicas (origem no topo-esquerda):
- `TL = (MARKER_INSET + MARKER_SIZE/2, MARKER_INSET + MARKER_SIZE/2)`
- `TR = (CANON_W - MARKER_INSET - MARKER_SIZE/2, mesmo y de TL)`
- `BL = (mesmo x de TL, CANON_H - MARKER_INSET - MARKER_SIZE/2)`
- `BR = (mesmo x de TR, mesmo y de BL)` → **marcador-âncora** (ver §9)

Esses 4 centros são os **pontos de destino** do `warpPerspective`.

**Cálculo das bolhas** (dado `n` questões e `opt` alternativas):
```
colunas   = max(1, ceil(n / floor((GRID_BOTTOM - GRID_TOP) / ROW_H)))
porColuna = ceil(n / colunas)
colW      = (CANON_W - 2*MARGIN) / colunas
optGap    = min(46, (colW - LABEL_W - 24) / opt)   // espaçamento horizontal entre bolhas
para a questão i (0-based):
  col       = floor(i / porColuna)
  linha     = i mod porColuna
  colX      = MARGIN + col*colW
  y         = GRID_TOP + linha*ROW_H + ROW_H/2
  startX    = colX + LABEL_W + BUBBLE_R + 6
  bolha j   = ( startX + j*optGap , y ), raio BUBBLE_R   // j = 0..opt-1 → A..E
  numero em ( colX + 4 , y )
```

> Os valores são pontos de partida. Mantenha-os como constantes nomeadas para facilitar ajuste. O importante é que **gerador e corretor leiam do mesmo módulo**.

---

## 7. Formatos de dados

### 7.1 Payload do QR Code
JSON compacto (mantenha curto para o QR não ficar denso). Contém **identificação + gabarito + parâmetros de layout**, de modo que o corretor reconstrói o template inteiro a partir do QR.

```json
{
  "v": 1,
  "id": "PROVA-01",
  "title": "Avaliação Teste — 1º Ano",
  "n": 40,
  "opt": 5,
  "k": "ABCDEABCDEABCDEABCDEABCDEABCDEABCDEABCDE"
}
```
- `v` versão do esquema · `id` identificador da prova · `title` título exibido · `n` nº de questões · `opt` nº de alternativas (2–5) · `k` gabarito, uma letra por questão (comprimento = `n`).
- Nível de correção de erro do QR: **M** (ou superior).

### 7.2 Template de leitura (derivado em runtime)
Não precisa ser persistido: o corretor recalcula via §6 a partir de `n` e `opt`. Estrutura em memória:
```json
{
  "canon": {"w":1000,"h":1414},
  "markers": {"tl":[x,y],"tr":[x,y],"bl":[x,y],"br":[x,y]},
  "questions": [
    {"n":1, "bubbles":[{"label":"A","x":..,"y":..,"r":11}, ...]},
    ...
  ]
}
```

### 7.3 Resultado da correção
```json
{
  "examId": "PROVA-01",
  "student": "(opcional, digitado)",
  "score": 33,
  "total": 40,
  "answers": [
    {"q":1, "marked":"B", "correct":"B", "status":"ok",    "right":true},
    {"q":2, "marked":null,"correct":"A", "status":"blank", "right":false},
    {"q":3, "marked":"AC","correct":"C", "status":"multi", "right":false}
  ],
  "capturedAt": "ISO-8601"
}
```
- `status ∈ {ok, blank, multi, low_conf}`.

---

## 8. Módulo A — Gerador de cartão (simples)

Tela única que recebe: título, ID, nº de questões, nº de alternativas e gabarito (com botão **"gabarito aleatório"** para gerar dados fictícios de teste). Produz:
- **PDF A4** contendo, nas coordenadas do layout canônico (§6) convertidas para a página:
  - 4 **marcadores fiduciais** nos cantos (3 quadrados sólidos + 1 âncora; ver §9);
  - **cabeçalho**: título, "ID:", linha "Aluno(a): ____", "Data: __/__/____" e instrução de preenchimento;
  - **QR Code** no canto superior do cabeçalho, com o payload da §7.1;
  - **grade de bolhas**: número da questão + círculos rotulados A–E.
- Pré-visualização em tela (canvas) e botões **Baixar PDF** / **Abrir PDF**.

Requisitos de impressão a documentar para o usuário: imprimir em **escala real (100%, A4, sem "ajustar à página")** e sem cortar bordas, para preservar a proporção dos marcadores.

---

## 9. Marcadores fiduciais (alinhamento)

São as marcas de referência que permitem corrigir perspectiva/rotação.

**Design (MVP):** **4 quadrados pretos sólidos**, um em cada canto. O marcador do **canto inferior direito é a âncora de orientação**: desenhado como **quadrado com furo** (quadrado preto com um quadrado branco menor no centro → um "anel quadrado"). Isso resolve a orientação sem ambiguidade e ainda fornece os **4 pontos** necessários para a homografia completa (perspectiva). Os outros três cantos são quadrados cheios.

**Detecção (no corretor):**
1. Escala de cinza → blur → threshold (Otsu) → `findContours`.
2. Filtrar candidatos a marcador por: área dentro de faixa esperada, **4 vértices** após `approxPolyDP`, razão de aspecto ≈ 1 e alta solidez.
3. Identificar a **âncora**: o candidato que possui **contorno-filho** (o furo) — em `findContours` com hierarquia, é o que tem buraco. Ela é o canto **inferior direito**.
4. A partir da âncora, ordenar os outros três por posição relativa (TL, TR, BL).
5. Pegar os **centros** dos 4 marcadores → 4 pontos de origem.

**Alternativa/robustez:** se a migração para um back-end ocorrer, considerar marcadores **ArUco** (via OpenCV contrib no Python, ou `js-aruco2` no navegador) — cada marcador carrega um ID e a detecção/pose vem pronta, sendo o estado da arte em tolerância a ângulo. Para o MVP client-side, os quadrados com âncora bastam e não dependem de biblioteca extra.

**Fallback:** se a detecção dos marcadores falhar em um frame, tentar detectar o **maior contorno quadrilátero** da folha (borda do papel) como aproximação e seguir; senão, sinalizar "não foi possível alinhar".

---

## 10. Módulo B — Corretor (núcleo do projeto)

### B1. Leitura do QR (identificação da prova)
- Tela de scanner: `<video>` ao vivo, decodificação contínua com `jsQR`/`zxing` sobre frames reduzidos.
- Ao decodificar: validar `v`, `id`, `n`, `opt`, `k` (e `len(k) == n`). Exibir título/ID/nº de questões para confirmação. Salvar a prova em IndexedDB.
- Tratar QR ilegível, payload inválido e versão desconhecida com mensagens claras.

### B2. Captura do cartão (auto + manual)
Roda um **detector ao vivo** em frames reduzidos (ex.: largura 360–480 px) a ~5–10 fps:
1. Detectar os 4 marcadores (§9) no frame.
2. **Quality gate** (todas as condições para auto-disparo):
   - os 4 marcadores presentes;
   - o quadrilátero formado está **dentro da margem** do quadro (não cortado);
   - **área do quadrilátero** dentro da faixa esperada (folha preenche o quadro o suficiente);
   - **nitidez** acima do limiar (variância do Laplaciano > `SHARP_MIN`);
   - **estabilidade**: condições mantidas por `STABLE_FRAMES` quadros consecutivos (ex.: 5).
3. Ao passar o gate → **capturar still em alta resolução** e seguir para o pipeline.
4. **Botão manual** sempre visível: ao tocar, captura o frame atual em alta resolução, ignorando o gate (mas ainda tentando alinhar).
5. **Overlay** de feedback: destacar marcadores/quadrilátero detectados e mostrar dica de estado ("alinhe os 4 cantos", "segure firme", "✓ capturando").

### B3. Pipeline OMR (sobre o still capturado)
1. **Detectar marcadores** no still em alta resolução (§9) → 4 pontos de origem.
2. **Homografia + warp**: `getPerspectiveTransform(origem → destino canônico)` + `warpPerspective` para `CANON_W × CANON_H`. A partir daqui, cada bolha está numa coordenada **conhecida**.
3. **Binarização adaptativa** sobre a imagem canônica em cinza: `adaptiveThreshold` (ou Otsu por região), com marcas em branco sobre fundo preto (invertido). Isso lida com **iluminação irregular** (problema clássico de foto: centro claro, bordas escuras).
4. **Amostragem das bolhas**: para cada questão, para cada alternativa, recortar o ROI (quadrado que envolve o círculo de raio `BUBBLE_R`, com pequena folga) e calcular `fillRatio = pixelsMarcados / pixelsTotaisDoROI`.
5. **Decisão por questão** (ver B-decisão).

### B-decisão (regra por questão)
Dado o vetor de `fillRatio` das alternativas da questão, com `max` e `segundo` maiores valores:
- `marked = argmax(fillRatio)` **se** `max >= FILL_MIN` **e** `(max - segundo) >= MARGIN_MIN` → `status = ok`.
- Se `max < FILL_MIN` → `status = blank`, `marked = null`.
- Se duas ou mais alternativas têm `fillRatio >= FILL_MIN` e ficam dentro de `MARGIN_MIN` entre si → `status = multi` (anulada/ambígua), `marked` = letras envolvidas.
- Caso intermediário (marca fraca, perto do limiar) → `status = low_conf` para revisão manual.

### B4. Correção e resultado
- Comparar `marked` de cada questão com `k[q]` do gabarito.
- Computar nota (definir política para `multi`/`blank` — por padrão, contam como erro; deixar configurável).
- Tela de resultado: nota, lista por questão (marcada × correta, com cores para certo/errado/branco/dupla), e a **imagem canônica anotada** (círculos verdes/vermelhos sobre as bolhas) para conferência.
- Exportar **CSV** e **JSON** (§7.3). Botão **"refazer foto"**.

---

## 11. Telas (mobile-first)

1. **Início** — lista de provas já carregadas (de IndexedDB) + botão "Identificar prova (QR)".
2. **Scanner de QR** — câmera + decodificação ao vivo → confirmação da prova.
3. **Câmera de correção** — vídeo + overlay de marcadores + dica de estado + **botão manual**; auto-dispara ao alinhar.
4. **Resultado** — nota, detalhamento por questão, imagem anotada, exportar, refazer.
5. **(Opcional) Gerador** — Módulo A.

Diretrizes: alvos de toque grandes, permissões de câmera tratadas com mensagem clara, estados de carregamento (especialmente o WASM do OpenCV), e funcionamento em **Chrome/Android** e **Safari/iOS** (atenção às particularidades de `getUserMedia` no iOS — exige HTTPS e gesto do usuário).

---

## 12. Parâmetros de ajuste (expor como constantes)

| Parâmetro | Função | Valor inicial |
|---|---|---|
| `FILL_MIN` | preenchimento mínimo para considerar uma bolha marcada | 0.35 |
| `MARGIN_MIN` | diferença mínima entre 1ª e 2ª bolha para confiança | 0.15 |
| `ROI_FACTOR` | folga do ROI sobre o raio da bolha | 1.1 |
| `ADAPT_BLOCK` | `blockSize` do adaptiveThreshold (ímpar) | 25 |
| `ADAPT_C` | constante C do adaptiveThreshold | 7 |
| `BLUR_K` | kernel do GaussianBlur | 5 |
| `SHARP_MIN` | nitidez mínima (variância do Laplaciano) | calibrar em campo |
| `STABLE_FRAMES` | quadros estáveis para auto-disparo | 5 |
| `LIVE_WIDTH` | largura do frame para detecção ao vivo | 420 px |

Todos devem ser facilmente ajustáveis; idealmente, expor uma tela de "modo debug" que mostre a imagem binarizada e os `fillRatio` para calibração.

---

## 13. Casos de borda e tratamento

- **Iluminação irregular / sombra** → binarização adaptativa; orientar o usuário a evitar reflexo.
- **Foto borrada** → gate de nitidez bloqueia auto-disparo; aviso "imagem borrada".
- **Folha cortada / marcador fora do quadro** → gate detecta e não dispara; dica de reenquadramento.
- **Marcadores não detectados** → fallback de contorno do papel; senão, erro "não foi possível alinhar".
- **QR ilegível ou de outra versão** → mensagem específica; não prosseguir.
- **Gabarito com tamanho ≠ nº de questões** → bloquear no carregamento da prova.
- **Marcação dupla / rasura** → `status = multi`/`low_conf`, destacado no resultado.
- **Marca fraca a lápis** → calibrar `FILL_MIN`; recomendar caneta no cartão.
- **Inclinação/rotação (até ~20°)** → resolvida pela homografia, desde que os 4 marcadores apareçam.
- **WASM grande** → lazy-load + tela de progresso + cache via service worker.

---

## 14. Critérios de aceitação

1. **Identificação por QR**: ao apontar para um QR válido, a prova (id, título, n, gabarito) é carregada e confirmada em tela.
2. **Auto-captura**: com a folha bem enquadrada, nítida e estável, o app dispara sozinho em ≤ ~2 s; o botão manual também funciona a qualquer momento.
3. **Alinhamento**: cartões fotografados com inclinação de até ~20° e iluminação normal são corrigidos para o espaço canônico sem erro perceptível de posição das bolhas.
4. **Acurácia**: em cartão impresso (100%, A4) e preenchido a caneta, fotografado em condições normais, a leitura por bolha atinge **≥ 95%** de acerto.
5. **Casos especiais**: questões em branco e marcações duplas são detectadas e sinalizadas (não atribuídas a uma alternativa indevidamente).
6. **Resultado**: nota correta, detalhamento por questão e imagem anotada; exportação CSV/JSON funcionando.
7. **Offline**: após o primeiro carregamento, o app abre e corrige sem rede (PWA).
8. **Compatibilidade**: funciona em Chrome/Android e Safari/iOS recentes, via HTTPS.

---

## 15. Roadmap sugerido (fases)

- **M0 — Esqueleto**: SPA + PWA shell, permissão de câmera, carregamento (lazy) do OpenCV.js com tela de progresso.
- **M1 — Gerador simples**: PDF com marcadores + grade + QR (Módulo A), alinhado ao layout da §6.
- **M2 — Identificação por QR**: scanner de QR e carregamento da prova (B1) + IndexedDB.
- **M3 — Alinhamento**: detecção de marcadores + `warpPerspective` sobre um still capturado manualmente (B3.1–B3.2), com modo debug mostrando a imagem canônica.
- **M4 — Leitura e correção**: binarização, amostragem das bolhas e regra de decisão (B3.3–B4); tela de resultado.
- **M5 — Auto-captura**: detector ao vivo + quality gate + overlay (B2).
- **M6 — Robustez e ajuste fino**: casos de borda, calibração de parâmetros (§12), exportação, polimento de UX.

Cada fase deve ser entregável e testável isoladamente. M3 e M4 são o coração do corretor e merecem o maior esforço de validação (idealmente com um conjunto de fotos reais de cartões preenchidos para regressão).

---

## 16. Referências técnicas

- **OMRChecker** (Udayraj Deshmukh) — OMR robusto por template + marcadores; referência de arquitetura. `github.com/Udayraj123/OMRChecker`
- **PyImageSearch** — "Bubble sheet multiple choice scanner and test grader using OMR, Python, and OpenCV" — pipeline clássico (perspectiva, threshold, contagem de pixels).
- **OpenCV.js** — documentação oficial (perspectiva, threshold, contornos) e exemplos com câmera. `docs.opencv.org`
- **Dynamsoft** — "How to Build a Browser Document Scanner with OpenCV.js and JavaScript" — detecção de documento e correção de perspectiva no navegador.
- **jsQR** / **zxing-js** — decodificação de QR no navegador.
- **pdf-lib** + **qrcode/qrcodejs** — geração de PDF e QR no cliente.

---

## 17. Notas para o agente

- Mantenha **uma única fonte de verdade do layout** (§6) importada pelo gerador e pelo corretor. Divergência aqui é a principal causa de leitura errada.
- Trabalhe sempre no **espaço canônico** após o warp; nunca leia bolhas direto da foto crua.
- Comece o corretor por **still capturado manualmente** (M3/M4) e só depois adicione o **auto-disparo** (M5) — é mais fácil depurar o pipeline com uma imagem fixa.
