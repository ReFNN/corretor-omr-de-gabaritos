# 📋 Corretor OMR de Gabaritos

Aplicativo web (PWA) que **corrige cartões-resposta de múltipla escolha pela câmera**, direto no navegador — sem servidor, sem upload, 100% offline. A visão computacional roda localmente com [OpenCV.js](https://docs.opencv.org/4.8.0/opencv.js).

---

## ✨ Funcionalidades

- **Geração de cartões-resposta** prontos para impressão (PDF/impressora), com marcadores fiduciais e bolhas.
- **Dois layouts:**
  - **Página inteira (A4):** cabeçalho completo, até **100 questões**.
  - **Compacto:** bloco que ocupa ~⅓ de uma página, para inserir dentro de uma prova, até **30 questões**.
- **Leitura por câmera com captura automática:** detecta o cartão, confere estabilidade/nitidez e dispara sozinho (também há captura manual).
- **Correção instantânea** contra o gabarito, com pontuação, percentual e detalhamento por questão.
- **Cartão corrigido anotado** (verde = certo, vermelho = errado).
- **Múltiplas provas** persistidas localmente (IndexedDB).
- **Exportação** dos resultados em **CSV** e **JSON**.
- **PWA:** instalável e funciona offline após o primeiro carregamento.

---

## 🚀 Como rodar

A câmera só funciona em **`localhost`** ou sob **HTTPS** (exigência dos navegadores). Basta servir os arquivos estáticos:

### Windows
```bat
serve.bat
```

### Qualquer sistema (Python)
```bash
python -m http.server 8000
```

### Node
```bash
npx serve -l 8000
```

Depois acesse **http://localhost:8000**.

> Para usar de um celular na mesma rede, sirva via HTTPS (ex.: `npx serve` com certificado, `ngrok`, ou hospede em qualquer host estático como GitHub Pages / Netlify).

---

## 📖 Como usar

1. **Nova Prova** → escolha o layout, informe título, ID, nº de questões, alternativas e o gabarito (ou gere um aleatório).
2. **Pré-visualizar** e **Imprimir** o cartão.
3. O aluno preenche as bolhas com caneta.
4. Na lista de provas, toque em **Corrigir** → enquadre o cartão na câmera.
5. A captura dispara automaticamente quando o cartão está estável e nítido.
6. Veja a **pontuação** e o **detalhamento**, e exporte se quiser.

---

## 🧠 Como funciona (pipeline)

1. **Detecção dos marcadores** fiduciais nos 4 cantos (contornos sólidos, seleção por extremos).
2. **Orientação** definida pelo furo do marcador-âncora (canto inferior-direito), robusta a rotação.
3. **Warp de perspectiva** (`warpPerspective`) para um espaço canônico fixo:
   - Página inteira → pelos 4 marcadores;
   - Compacto → pela **borda** do cartão (cantos mais precisos).
4. **Binarização adaptativa** e **amostragem** de cada bolha (razão de preenchimento).
5. **Decisão** por questão (marcada / branco / múltipla / baixa confiança) e **correção** contra o gabarito.

A geometria do cartão é definida em um **espaço canônico** compartilhado entre o gerador e o corretor — garantindo que as bolhas impressas caiam exatamente onde o leitor as procura.

---

## 🗂 Estrutura

```
├── index.html              # Shell do app e telas
├── css/style.css           # Estilos
├── js/
│   ├── app.js              # Controlador (navegação, câmera, captura ao vivo)
│   ├── layout.js           # Espaço canônico — layout página inteira (A4)
│   ├── layout-compact.js   # Espaço canônico — layout compacto
│   ├── generator.js        # Renderização e impressão dos cartões
│   ├── omr.js              # Pipeline de visão computacional (OpenCV.js)
│   └── db.js               # Persistência (IndexedDB)
├── manifest.json           # Manifesto PWA
├── sw.js                   # Service worker (cache offline)
├── serve.bat               # Servidor local (Windows)
└── docs/                   # Especificação e notas de implementação
```

---

## 🛠 Tecnologias

- HTML, CSS e **JavaScript (ES Modules)** — sem framework, sem build.
- **OpenCV.js** (WASM) para visão computacional.
- **IndexedDB** para armazenamento local.
- **PWA** (manifest + service worker).

---

## 📝 Licença

Projeto de uso próprio/educacional. Sinta-se à vontade para adaptar.
