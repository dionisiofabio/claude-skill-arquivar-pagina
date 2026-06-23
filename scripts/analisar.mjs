// analisar.mjs — diagnostica uma página e recomenda a estratégia de arquivamento.
// Uso:  node analisar.mjs <url> [--screenshot saida.png]
//
// Carrega a página num Chromium real (renderiza JS), inspeciona o que ela é de
// verdade e imprime um relatório JSON com os sinais que decidem a estratégia:
//   - o conteúdo está embutido no bundle JS ou vem de uma API/backend?
//   - o roteamento é por hash (#) — seguro em file:// — ou por history.pushState?
//   - quais fontes, imagens, CSS e arquivos para download a página usa?
//   - quantas abas/rotas e quantos expansíveis ("+") existem?
//
// Rode a partir de uma pasta de trabalho que tenha `playwright` instalado
// (veja o Passo 0 da SKILL.md). Best-effort: nunca derruba por causa de 1 fetch.

import { chromium } from 'playwright';

const TARGET = process.argv[2];
if (!TARGET) { console.error('uso: node analisar.mjs <url> [--screenshot arquivo.png]'); process.exit(1); }
const shotIdx = process.argv.indexOf('--screenshot');
const SHOT = shotIdx > -1 ? process.argv[shotIdx + 1] : null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function tryFetchText(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

const browser = await chromium.launch();
const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 900 } });

// captura toda a rede para classificar depois
const net = [];
page.on('request', req => net.push({ url: req.url(), type: req.resourceType(), method: req.method() }));
// ruído conhecido (telemetria/analytics): NÃO conta como "API de conteúdo"
const TELEMETRY = /cdn-cgi|cloudflareinsights|google-analytics|googletagmanager|doubleclick|\/beacon|\/rum\b|speculation|hotjar|segment\.io|mixpanel|facebook\.com\/tr|clarity\.ms|sentry|datadog/i;
const apiResponses = [];
page.on('response', async res => {
  const ct = (res.headers()['content-type'] || '');
  const rt = res.request().resourceType();
  if ((rt === 'xhr' || rt === 'fetch') && /json|text\/plain/.test(ct) && !TELEMETRY.test(res.url())) {
    apiResponses.push({ url: res.url(), status: res.status(), ct });
  }
});

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);

const origin = new URL(TARGET).origin;

// --- DOM / runtime ---
const dom = await page.evaluate(() => {
  const cls = el => (el.className || '').toString();
  return {
    title: document.title,
    bodyTextLen: document.body ? document.body.innerText.trim().length : 0,
    scripts: [...document.querySelectorAll('script')].map(s => ({
      src: s.src || null, type: s.type || null, inlineLen: s.src ? 0 : (s.textContent || '').length,
    })),
    stylesheets: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href),
    styleTags: document.querySelectorAll('style').length,
    images: [...document.querySelectorAll('img')].map(i => i.currentSrc || i.src).filter(Boolean).slice(0, 50),
    imgCount: document.querySelectorAll('img').length,
    // navegação / abas
    tabs: [...document.querySelectorAll('[role=tab], [class*=tab i], nav a, [class*=nav i] button')]
      .map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 40),
    hashLinks: [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href')).slice(0, 40),
    // expansíveis ("+")
    details: document.querySelectorAll('details').length,
    ariaExpanded: document.querySelectorAll('[aria-expanded]').length,
    suspectToggles: [...new Set([...document.querySelectorAll('*')].map(e => cls(e))
      .filter(c => /toggle|accordion|expand|faq|collaps|disclos|reveal/i.test(c)))].slice(0, 20),
    hasReactRoot: !!document.querySelector('#root, #app, [data-reactroot]'),
  };
});

// --- baixa e escaneia os JS e CSS do mesmo host ---
const sameHostScripts = dom.scripts.filter(s => s.src && s.src.startsWith(origin)).map(s => s.src);
const jsScan = { import_dyn: 0, import_meta: 0, fetch: 0, xhr: 0, pushState: 0, replaceState: 0, hashchange: 0, popstate: 0, assetPaths: new Set(), mediaRefs: new Set(), externalLinks: new Set() };
for (const src of sameHostScripts) {
  const code = await tryFetchText(src);
  if (!code) continue;
  const n = (re) => (code.match(re) || []).length;
  jsScan.import_dyn += n(/\bimport\(/g);
  jsScan.import_meta += n(/import\.meta/g);
  jsScan.fetch += n(/\bfetch\(/g);
  jsScan.xhr += n(/XMLHttpRequest/g);
  jsScan.pushState += n(/pushState/g);
  jsScan.replaceState += n(/replaceState/g);
  jsScan.hashchange += n(/hashchange/g);
  jsScan.popstate += n(/popstate/g);
  for (const m of code.matchAll(/["'`](\.?\/?assets\/[A-Za-z0-9._\-${}]+)["'`]/g)) jsScan.assetPaths.add(m[1]);
  // imagens/mídia referenciadas no JS — INCLUSIVE na raiz do site (ex.: "/foto.png"),
  // não só em /assets/. É o que o grep de /assets/ deixa passar (vide gotcha das imagens).
  for (const m of code.matchAll(/["'`]((?:\.?\/)?[\w.\-/]+\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm))["'`]/g)) {
    if (!m[1].startsWith('data:') && !/node_modules/.test(m[1])) jsScan.mediaRefs.add(m[1]);
  }
  for (const m of code.matchAll(/https?:\/\/[^"'`)\s]+/g)) {
    const u = m[0];
    if (!/w3\.org|reactjs\.org|schema\.org/.test(u) && !u.startsWith(origin)) jsScan.externalLinks.add(u.slice(0, 80));
  }
}

const cssImports = [];
for (const href of dom.stylesheets.filter(h => h.startsWith(origin))) {
  const css = await tryFetchText(href);
  if (!css) continue;
  for (const m of css.matchAll(/@import\s*(?:url\()?["']?([^"')]+)["']?\)?/g)) cssImports.push(m[1]);
}

// --- classifica a rede ---
const cats = { appJs: [], appCss: [], fonts: [], images: [], apiXhrFetch: [], thirdParty: [] };
for (const r of net) {
  if (/googleapis|gstatic|fonts/.test(r.url) || r.type === 'font') cats.fonts.push(r.url);
  else if (r.type === 'image') cats.images.push(r.url);
  else if (r.type === 'xhr' || r.type === 'fetch') cats.apiXhrFetch.push(r.url);
  else if (r.url.startsWith(origin) && r.type === 'script') cats.appJs.push(r.url);
  else if (r.url.startsWith(origin) && r.type === 'stylesheet') cats.appCss.push(r.url);
  else if (!r.url.startsWith(origin) && /document|script|xhr|fetch/.test(r.type)) cats.thirdParty.push(r.url);
}

if (SHOT) await page.screenshot({ path: SHOT, fullPage: true }).catch(() => {});
await browser.close();

// --- recomendação de estratégia ---
const contentInBundle = dom.bodyTextLen > 200 && sameHostScripts.length > 0;
const realApiCalls = apiResponses.length; // respostas JSON de XHR/fetch = provável backend
const usesPushState = jsScan.pushState > 0;
const usesHashRouting = jsScan.hashchange > 0 || dom.hashLinks.length > 0 || jsScan.popstate > 0;

let strategy, reason;
if (realApiCalls > 0) {
  strategy = 'B-incerto/A-captura';
  reason = `Detectadas ${realApiCalls} resposta(s) JSON de XHR/fetch → a página provavelmente depende de backend. Inlining do app pode não funcionar offline. Confirme se essas chamadas trazem CONTEÚDO (então use captura de DOM, Estratégia A) ou se são só telemetria (então Estratégia B serve).`;
} else if (contentInBundle && jsScan.import_dyn === 0) {
  strategy = 'B-inline-app';
  reason = `Conteúdo embutido no bundle, sem import() dinâmico, sem chamadas de API. ${usesPushState && !usesHashRouting ? 'ATENÇÃO: usa pushState — pode quebrar em file://; teste e, se quebrar, neutralize o history ou caia pra Estratégia A.' : usesHashRouting ? 'Roteamento por hash → seguro em file://.' : 'Sem roteamento de URL aparente (estado em JS) → seguro em file://.'}`;
} else if (contentInBundle && jsScan.import_dyn > 0) {
  strategy = 'B-inline-app (com cuidado)';
  reason = `Conteúdo no bundle, mas há ${jsScan.import_dyn} import() dinâmico(s) → há code-splitting (chunks separados). Ou baixe e embuta todos os chunks, ou caia pra Estratégia A (captura de DOM).`;
} else {
  strategy = 'A-captura-DOM ou página estática';
  reason = 'Pouco/nenhum conteúdo gerado por JS, ou bundle ausente. Se já vem renderizado no HTML, basta inline de CSS/imagens. Senão, capture o DOM renderizado.';
}

console.log(JSON.stringify({
  url: TARGET, origin,
  recommendation: { strategy, reason },
  signals: {
    bodyTextLen: dom.bodyTextLen, contentInBundle,
    realApiJsonResponses: realApiCalls, apiResponses: apiResponses.slice(0, 10),
    routing: { usesPushState, usesHashRouting, pushState: jsScan.pushState, replaceState: jsScan.replaceState, hashchange: jsScan.hashchange, popstate: jsScan.popstate },
    js: { sameHostScripts, import_dyn: jsScan.import_dyn, import_meta: jsScan.import_meta, fetch: jsScan.fetch, xhr: jsScan.xhr },
  },
  resources: {
    stylesheets: dom.stylesheets, cssImports,
    fonts: [...new Set(cats.fonts)].slice(0, 20),
    images: dom.images, imgCount: dom.imgCount,
    mediaRefsInJs: [...jsScan.mediaRefs],
    downloadableAssets: [...jsScan.assetPaths],
    externalContentLinks: [...jsScan.externalLinks].slice(0, 40),
    thirdPartyNoise: [...new Set(cats.thirdParty)].slice(0, 20),
  },
  structure: {
    title: dom.title, tabs: [...new Set(dom.tabs)], hashLinks: dom.hashLinks,
    details: dom.details, ariaExpanded: dom.ariaExpanded, suspectToggles: dom.suspectToggles,
    hasReactRoot: dom.hasReactRoot,
  },
  consoleErrors: consoleErrors.slice(0, 10),
}, null, 2));
