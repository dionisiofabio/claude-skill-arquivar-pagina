// verificar.mjs — abre o HTML arquivado em file:// (o jeito REAL que o usuário
// vai abrir: duplo-clique) e prova que está completo e funcional offline.
//
// Uso:  node verificar.mjs <caminho-do-arquivo.html> [--assets-dir assets/] [--shots pasta/]
//
// O que faz:
//   1. Abre via file:// e coleta erros de console e requests que FALHARAM
//      (ignora favicon.ico, que todo navegador pede e é inofensivo).
//   2. Descobre as abas/rotas (role=tab, .header-fase-btn, nav, a[href^="#"]) e
//      clica em cada uma. Em cada estado, descobre sub-navegação (sidebar/blocos)
//      e percorre, e EXPANDE todos os "+": <details>, [aria-expanded=false],
//      .toggle/.accordion. Mede o texto visível e tira print.
//   3. Se houver window.__ASSETS__ (downloads embutidos), valida que são data:
//      URIs e, com --assets-dir, confere byte a byte (sha256) contra os originais.
//
// Ajuste os seletores em CONFIG se a página usar classes diferentes (use o
// relatório do analisar.mjs pra saber). Best-effort e tolerante a erros.

import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

const FILE = process.argv[2];
if (!FILE) { console.error('uso: node verificar.mjs <arquivo.html> [--assets-dir dir] [--shots dir]'); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const ASSETS_DIR = arg('--assets-dir', null);
const SHOTS = arg('--shots', 'verify-shots');
mkdirSync(SHOTS, { recursive: true });

const CONFIG = {
  tabSelectors: ['[role=tab]', '.header-fase-btn', 'nav a[href^="#"]', 'a[href^="#"]'],
  subNavSelectors: ['.sidebar-item', '[class*=block i] button', '.pagination button', '[class*=step i]'],
  expandSelectors: ['details:not([open])', '[aria-expanded=false]', '.toggle', '.accordion', '[class*=faq i]'],
  ignoreFailedUrl: /favicon\.ico$/i,
};

const url = pathToFileURL(path.resolve(FILE)).href;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [], failed = [];
page.on('console', m => { if (m.type() === 'error' && !CONFIG.ignoreFailedUrl.test(m.location()?.url || '')) consoleErrors.push(m.text()); });
page.on('requestfailed', r => { if (!CONFIG.ignoreFailedUrl.test(r.url())) failed.push({ url: r.url().slice(0, 120), err: r.failure()?.errorText }); });
page.on('response', r => { if (r.status() >= 400 && !CONFIG.ignoreFailedUrl.test(r.url())) failed.push({ url: r.url().slice(0, 120), status: r.status() }); });

console.error('abrindo', url);
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(800);

async function expandAll() {
  return await page.evaluate((sels) => {
    let opened = 0;
    document.querySelectorAll('details:not([open])').forEach(d => { d.open = true; opened++; });
    for (const sel of sels) {
      if (sel.includes('details')) continue;
      document.querySelectorAll(sel).forEach(el => {
        try { (el.querySelector('summary,button,[class*=header i]') || el).click(); opened++; } catch {}
      });
    }
    return opened;
  }, CONFIG.expandSelectors);
}
async function measure() {
  return await page.evaluate(() => {
    const main = document.querySelector('main, #app, #root, body');
    return {
      detailsOpen: document.querySelectorAll('details[open]').length,
      detailsTotal: document.querySelectorAll('details').length,
      textLen: main ? main.innerText.trim().length : 0,
    };
  });
}

// descobre as abas
const tabs = await page.evaluate((sels) => {
  const seen = new Set(), out = [];
  for (const sel of sels) for (const el of document.querySelectorAll(sel)) {
    const t = (el.textContent || '').trim();
    if (t && t.length < 40 && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out.slice(0, 20);
}, CONFIG.tabSelectors);

const report = { url, tabsFound: tabs, states: [], totals: { textLen: 0, detailsExpanded: 0, expandersClicked: 0 } };

async function walkSubAndExpand(tabName) {
  const subs = await page.evaluate((sels) => {
    for (const sel of sels) { const els = [...document.querySelectorAll(sel)]; if (els.length) return els.map(e => (e.textContent || '').trim().slice(0, 30)); }
    return [];
  }, CONFIG.subNavSelectors);
  const list = subs.length ? subs : ['(único)'];
  for (let i = 0; i < list.length; i++) {
    if (subs.length) {
      await page.evaluate(({ sels, idx }) => {
        for (const sel of sels) { const els = [...document.querySelectorAll(sel)]; if (els.length) { els[idx]?.click(); break; } }
      }, { sels: CONFIG.subNavSelectors, idx: i });
      await page.waitForTimeout(250);
    }
    const opened = await expandAll();
    await page.waitForTimeout(120);
    const m = await measure();
    report.states.push({ tab: tabName, sub: list[i], ...m, opened });
    report.totals.textLen += m.textLen;
    report.totals.detailsExpanded += m.detailsOpen;
    report.totals.expandersClicked += opened;   // <details> abertos + .toggle/accordion clicados
  }
}

if (tabs.length) {
  for (const t of tabs) {
    await page.evaluate(({ sels, name }) => {
      for (const sel of sels) { const el = [...document.querySelectorAll(sel)].find(e => (e.textContent || '').trim() === name); if (el) { el.click(); return; } }
    }, { sels: CONFIG.tabSelectors, name: t });
    await page.waitForTimeout(350);
    await walkSubAndExpand(t);
    await page.screenshot({ path: path.join(SHOTS, `tab-${t.replace(/[^A-Za-z0-9]/g, '_')}.png`), fullPage: true }).catch(() => {});
  }
} else {
  await walkSubAndExpand('(página única)');
  await page.screenshot({ path: path.join(SHOTS, 'page.png'), fullPage: true }).catch(() => {});
}

// valida downloads embutidos
const assets = await page.evaluate(() => {
  const a = window.__ASSETS__; if (!a) return null;
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, String(v).slice(0, 40)]));
});
let assetCheck = 'sem window.__ASSETS__';
if (assets) {
  const keys = Object.keys(assets);
  const bad = keys.filter(k => !assets[k].startsWith('data:'));
  assetCheck = { count: keys.length, bad };
  if (ASSETS_DIR && existsSync(ASSETS_DIR)) {
    const sha = b => createHash('sha256').update(b).digest('hex');
    const mismatches = [];
    for (const fn of readdirSync(ASSETS_DIR)) {
      const b64 = await page.evaluate(n => (window.__ASSETS__[n] || '').split(',')[1] || '', fn);
      if (!b64) { mismatches.push(`${fn}: ausente no mapa`); continue; }
      const dec = Buffer.from(b64, 'base64');
      const orig = readFileSync(path.join(ASSETS_DIR, fn));
      if (dec.length !== orig.length || sha(dec) !== sha(orig)) mismatches.push(`${fn}: difere`);
    }
    assetCheck.byteCompare = mismatches.length ? mismatches : 'todos byte-idênticos';
  }
}

await browser.close();

const ok = failed.length === 0;
console.log(JSON.stringify({
  ok,
  veredito: ok ? 'OK — nenhum recurso faltando offline' : 'ATENÇÃO — há recursos falhando (ver "failed")',
  failed, consoleErrors,
  tabsFound: report.tabsFound,
  totalStatesWalked: report.states.length,
  totalDetailsExpanded: report.totals.detailsExpanded,   // só <details> nativos (0 é normal se a página usa .toggle/estado React)
  totalExpandersClicked: report.totals.expandersClicked, // <details> + .toggle/accordion — se 0 mas a página tem "+", ajuste expandSelectors
  totalVisibleTextChars: report.totals.textLen,
  assets: assetCheck,
  states: report.states,
  screenshotsDir: SHOTS,
}, null, 2));
process.exit(ok ? 0 : 2);
