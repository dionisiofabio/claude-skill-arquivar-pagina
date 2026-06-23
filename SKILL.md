---
name: arquivar-pagina
description: >
  Arquiva uma página web num ÚNICO arquivo .html auto-suficiente, idêntico ao
  original e que funciona offline (duplo-clique) mesmo depois que a página sair
  do ar — capturando TODO o conteúdo, inclusive o que fica escondido atrás de
  "+", acordeões, abas, FAQ e seções recolhidas. Use SEMPRE que o usuário disser
  "arquiva essa página", "salva esse site/página como HTML", "converte essa
  página num HTML pra eu abrir depois", "quero abrir caso a página expire/saia
  do ar", "faz backup/snapshot dessa landing page", "baixa essa página offline",
  ou colar uma URL pedindo pra preservar o conteúdo. Funciona especialmente bem
  em páginas renderizadas por JavaScript (apps Vite/React/Vue/SPA) onde o
  conteúdo não está no HTML cru. NÃO confunda com extrair-curso (baixa VÍDEOS de
  cursos) nem com site2skill (gera uma skill cliente de API a partir de um HAR) —
  esta skill produz um HTML offline fiel da página em si.
---

# arquivar-pagina — página web → 1 HTML offline idêntico

O objetivo é entregar **um único arquivo `.html`** que, no duplo-clique, abre no
navegador **igualzinho** ao site original, **100% offline**, com **todo** o
conteúdo — inclusive o que só aparece ao clicar num "+", abrir um acordeão, trocar
de aba ou expandir um FAQ. Se a página sair do ar amanhã, o arquivo continua
perfeito.

## A ideia central (leia antes de tudo)

Páginas modernas quase nunca têm o conteúdo no HTML cru — um app JavaScript
(Vite/React/Vue/etc.) monta tudo no navegador. Então existem **duas estratégias**,
e o `analisar.mjs` te diz qual usar:

- **Estratégia B — embutir o app original (PREFERIDA).** Quando o conteúdo está
  dentro do bundle JS e a página **não depende de backend/API**, a gente embute o
  JS + CSS + fontes + downloads no próprio HTML. Resultado: o app roda offline
  *exatamente* como o original — abas, "+", acordeões, tudo funciona nativamente,
  porque é o mesmo código. É a cópia mais fiel possível e dá pouquíssimo trabalho.
- **Estratégia A — capturar o DOM renderizado (FALLBACK).** Quando o app busca
  conteúdo de uma API/backend (não funcionaria offline), ou usa code-splitting
  complicado, a gente renderiza cada estado (cada aba/rota, tudo expandido),
  captura o HTML já montado e remonta um arquivo estático com os recursos
  inlinados. Mais trabalho e exige recriar a navegação.

Na dúvida, **comece tentando a B** — ela é melhor quando dá. O verificador no fim
prova se ficou completo de qualquer jeito.

> **Princípio "idêntico":** preserve o comportamento original. Os "+" devem
> começar recolhidos e abrir no clique, como no site — o conteúdo já está todo no
> DOM, só visualmente recolhido (isso já satisfaz "não deixar passar nada"). Só
> pré-expanda tudo se o usuário pedir uma versão "tudo aberto" (boa pra ler/imprimir).

---

## Passo 0 — pré-requisitos e pasta de trabalho

Precisa de **Node** (com Playwright/Chromium) e **Python 3**. Monte uma pasta de
trabalho e instale o Playwright nela (os `.mjs` resolvem `playwright` a partir do
diretório de onde rodam, por isso copiamos os scripts pra lá):

```bash
mkdir -p _arquivo && cd _arquivo
npm init -y >/dev/null 2>&1 && npm i playwright >/dev/null 2>&1
npx playwright install chromium
cp "<DIR_DA_SKILL>/scripts/"*.mjs .      # analisar.mjs, verificar.mjs
# os .py (inline_fonts.py, montar_html.py) só usam stdlib — rode de onde quiser
```

(`<DIR_DA_SKILL>` é a pasta desta skill; no Claude Code costuma ser
`~/.claude/skills/arquivar-pagina`.)

---

## Passo 1 — diagnosticar a página (decide a estratégia)

```bash
node analisar.mjs "https://exemplo.com/" --screenshot original.png
```

Lê o JSON de saída. Os campos que importam:

- `recommendation.strategy` → **B-inline-app**, **A-captura-DOM**, ou variações.
- `signals.realApiJsonResponses` → **se > 0, a página puxa conteúdo de backend.**
  Confirme se essas respostas trazem o conteúdo de verdade (→ Estratégia A) ou se
  são só telemetria/analytics (→ pode usar B).
- `signals.routing` → `usesHashRouting` (seguro em file://) vs `usesPushState`
  (pode quebrar em file:// — ver Armadilhas).
- `signals.js.import_dyn` → se > 0 há chunks separados (code-splitting): baixe
  todos ou use A.
- `resources` → folhas de estilo, `cssImports` (fontes!), `images` (as do 1º
  render), `mediaRefsInJs` (**imagens/mídia citadas no bundle — INCLUSIVE na raiz
  do site, ex.: `/foto.png`** — é o que aparece só em abas internas e o grep de
  `/assets/` deixa passar), `downloadableAssets` (arquivos pra baixar linkados no
  conteúdo), `externalContentLinks` (links do conteúdo — **mantenha apontando pro
  site real**), `thirdPartyNoise` (analytics/Cloudflare — **remova**).
- `structure` → `tabs`, `details`, `ariaExpanded`, `suspectToggles` → te diz
  quantas abas e quantos "+" existem (use pra conferir no fim que nada sumiu).

Compare a screenshot `original.png` com o resultado final lá no Passo 4.

---

## Passo 2 — baixar os recursos

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
curl -s -A "$UA" "https://exemplo.com/" -o index_raw.html
# baixe cada JS e CSS do mesmo host listados em signals.js.sameHostScripts e resources.stylesheets
curl -s -A "$UA" "https://exemplo.com/assets/index-XXXX.js"  -o app.js
curl -s -A "$UA" "https://exemplo.com/assets/index-YYYY.css" -o app.css
# baixe os downloadableAssets (skills, zips, pdfs…) e as imagens, se houver
mkdir -p assets && for f in <lista de downloadableAssets>; do curl -s -A "$UA" ".../assets/$f" -o "assets/$f"; done
```

**Não esqueça os `downloadableAssets`** — são arquivos linkados no conteúdo
(`.zip`, `.pdf`, `.skill`…). Se a página expirar, esses links morrem; por isso a
gente embute. Há também referências **templated** (ex.: ``href:`/assets/${x.name}` ``):
procure no JS o array que alimenta esse map pra achar TODOS os nomes (não só os
literais). Baixe tudo e confira HTTP 200.

---

## Passo 3 — montar o arquivo único

### Caminho B (embutir o app) — o caso comum

1. **Inline das fontes.** Se `resources.cssImports` aponta pra Google Fonts (ou
   qualquer `@import` http), resolva e embuta:
   ```bash
   python inline_fonts.py app.css app.inlined.css
   ```
   Isso gera um CSS com as `@font-face` em base64 e **sem** o `@import` (a
   tipografia fica idêntica offline).

2. **Patch dos caminhos de download no JS.** O bundle referencia os downloads por
   caminho absoluto (`/assets/x.zip`), que em file:// vira `file:///assets/...`
   (quebrado). Troque por um mapa embutido. Padrão dos apps Vite/React:
   - literais: `href:"/assets/NOME",download:!0` ou `href:"./assets/NOME",download:!0`
   - templated: ``href:`/assets/${a.name}`,download:!0``

   Substitua (com sed/python) por `href:window.__ASSETS__["NOME"],download:"NOME"`
   e ``href:window.__ASSETS__[a.name],download:a.name``. O `montar_html.py` cria o
   `window.__ASSETS__` a partir de `--assets-dir`. **Preserve o nome do arquivo no
   `download`** (senão baixa como "download" sem extensão).

3. **Remova o lixo de telemetria** (script inline da Cloudflare no `index_raw.html`,
   beacons, `cdn-cgi/...`). Não afeta conteúdo.

4. **Monte:**
   ```bash
   python montar_html.py --out "PAGINA.html" --title "Título exato da página" \
     --css app.inlined.css --js app.patched.js --assets-dir assets/
   ```
   (Por padrão inlina o JS como `<script type="module">`; use `--js-classic` se o
   bundle não for módulo ES. Ponha o CSS de fontes antes do CSS do app se forem
   arquivos separados.)

### Caminho A (capturar o DOM) — quando B não serve

Quando há backend de conteúdo / chunks: use Playwright pra, em cada aba/rota,
expandir todos os `<details>`/toggles e capturar `outerHTML`; junte os estados num
HTML estático, reimplemente um seletor de abas simples (mostrar/ocultar seções),
inline **todo** CSS, **fontes** (base64), e **imagens** (busque cada `img`/`url()`
e troque por `data:` URI). Mantenha os "+" funcionais (ou pré-expandidos). É mais
trabalhoso; só vá por aqui se o `analisar.mjs` indicar.

> **Imagens (não esqueça!):** se a página tiver `<img>` ou `background-image:url(...)`,
> embuta cada uma como `data:` URI base64 (vale pras duas estratégias). Olhe
> `mediaRefsInJs` do `analisar.mjs` — muitas vivem na **raiz do site** (`/foto.png`,
> não `/assets/foto.png`) e só aparecem em abas internas; em file:// um `src="/foto.png"`
> vira `file:///C:/foto.png` (quebrado). Baixe todas e troque o `src` pelo data: URI.
> Cuidado: extensão mente — um `.png` pode ser **JPEG** por dentro (cheque os magic
> bytes: `FFD8FF`=jpeg, `89504E47`=png) e use o MIME real no data: URI. SVG inline
> já vem no HTML/JS — não baixa. `xmlns="http://www.w3.org/2000/svg"` é namespace,
> **não** é chamada de rede. O `verificar.mjs` é a rede de segurança: ele acusa
> qualquer imagem que ficou faltando (`failed` com ERR_FILE_NOT_FOUND).

---

## Passo 4 — VERIFICAR (obrigatório, não pule)

É o que garante "não deixei passar nada". Rode sobre o arquivo final:

```bash
node verificar.mjs "PAGINA.html" --assets-dir assets/ --shots verify-shots
```

Confira no JSON:
- `ok: true` e `failed: []` → nenhum recurso falta offline (favicon é ignorado).
- `tabsFound` e `totalStatesWalked` batem com o nº de abas/blocos do `analisar.mjs`.
- `totalExpandersClicked` > 0 → os "+" abrem. **Nem toda página usa `<details>`**:
  algumas (vide T2 do próprio curso) usam `.toggle`/estado React, então
  `totalDetailsExpanded` pode ser 0 e ainda assim estar tudo certo — o que importa
  é `totalExpandersClicked`. Se a página tem "+" mas esse total vier 0, ajuste
  `expandSelectors` no `verificar.mjs` pro seletor que a página usa.
- `assets.byteCompare` = "todos byte-idênticos" → downloads embutidos corretos.
- Olhe 1–2 prints em `verify-shots/` e compare com `original.png`.

Se a página usa seletores fora do padrão, ajuste `CONFIG` no topo de
`verificar.mjs`. Se `failed` listar algo (que não favicon), aquele recurso não foi
inlinado — volte e embuta antes de declarar pronto.

---

## Armadilhas (o porquê — não tropece nelas)

- **Módulos ES não carregam de `file://` quando externos.** Por isso a gente
  **inlina** o JS dentro de `<script type="module">…</script>` (módulo inline roda
  liso em file://; o bloqueio de CORS é só pra `src` externo). Não tente apenas
  salvar o `.js` ao lado e referenciar — quebra no duplo-clique.
- **Roteamento: hash ✅ vs `pushState` ⚠️.** Hash routing (`#/rota`) funciona
  perfeito em file://. `history.pushState` pode lançar SecurityError em file:// —
  se o `analisar.mjs` acusar `usesPushState`, teste; se quebrar, neutralize
  (`history.pushState = ()=>{}`) ou vá de Estratégia A.
- **O `@import` de fontes tem `;` na URL.** `@import"...wght@400;500;600..."`.
  Um regex `@import[^;]*;` corta no primeiro `;` e deixa lixo que **quebra todo o
  CSS** (sintoma: só as `@font-face` parseiam, e `:root{}`/`.classes{}` somem →
  página sem estilo). O `inline_fonts.py` já casa a string entre aspas inteira.
- **`</script>` no bundle e `</style>` no CSS** quebram o inline. O `montar_html.py`
  escapa `</script>`→`<\/script>` e aborta se achar `</style>` no CSS.
- **Downloads com `download:!0`** (booleano) baixam sem nome certo. Ao trocar por
  `data:` URI, **defina `download:"nome.ext"`** pra preservar o nome.
- **`favicon.ico` dá 404 em file://** — é o navegador pedindo sozinho, inofensivo,
  não é conteúdo. O `verificar.mjs` ignora.
- **Links de conteúdo (GitHub, YouTube…) ficam como estão** — devem apontar pro
  site real mesmo. Só telemetria/Cloudflare é que sai.
- **Tamanho:** fontes em base64 incham o arquivo (~2 MB é normal e aceitável pra um
  arquivo auto-suficiente). Se os downloads forem muito grandes (vídeos), aí sim
  considere salvar numa pasta `assets/` ao lado em vez de embutir.

---

## Definição de pronto

1. `node verificar.mjs` retorna `ok: true`, `failed: []`.
2. Nº de abas/rotas e de "+" expandidos batem com o diagnóstico.
3. Prints do `verify-shots/` visualmente iguais ao `original.png` (fontes, cores,
   layout).
4. Downloads (se houver) embutidos e byte-idênticos.
5. Entregue **um** arquivo `.html` (nome sem acentos/espaços, ex.:
   `Nome-Da-Pagina.html`), e diga ao usuário onde está e que é só dar duplo-clique.
6. Limpe a pasta `_arquivo/` de trabalho no fim (deixe só o `.html`), salvo se o
   usuário quiser os intermediários.
