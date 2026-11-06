// Lighthouse for every active site in sites.json, on a phone and a desktop, the way PageSpeed Insights runs it
// (simulated throttling): the home page and, up to the site's maxPages, more pages from its sitemap. Writes
// results/latest.json in the shape the weekly Site Health agent reads, and a dated copy in results/history/.
//
//   sites.{id}.{mobile|desktop}.scores   the lowest score of any page checked, per category (0-100)
//   sites.{id}.{mobile|desktop}.metrics  the home page's lab metrics (ms; CLS unitless)
//   sites.{id}.{mobile|desktop}.perPage  every page's scores and metrics
//   sites.{id}.{mobile|desktop}.issues   every audit below 0.9 on any page: {id, title, category, score, displayValue, pages}
//   sites.{id}.{mobile|desktop}.axe      axe-core after scrolling each page, every reveal in, which Lighthouse's accessibility
//                                        score skips: {count, issues: [{id, impact, nodes, example, pages}]}
import fs from 'node:fs';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const METRICS = {
  lcp: 'largest-contentful-paint',
  fcp: 'first-contentful-paint',
  tbt: 'total-blocking-time',
  cls: 'cumulative-layout-shift',
  si: 'speed-index',
};
const FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--lang=en-US'];

/** The pages to check: the home page first, then pages of the same site from its sitemap (one level of index). */
async function pagesOf(site) {
  const home = new URL(site.url);
  const found = [home.href];
  const get = async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      return res.ok ? await res.text() : '';
    } catch {
      return '';
    }
  };
  const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const max = Math.max(1, site.maxPages || 1);
  let urls = locs(await get(new URL('/sitemap.xml', home)));
  for (const index of urls.filter((u) => /\.xml(\?|$)/.test(u)).slice(0, 3)) urls = urls.concat(locs(await get(index)));
  for (const u of urls) {
    if (found.length >= max) break;
    let url;
    try { url = new URL(u); } catch { continue; }
    if (url.host !== home.host || /\.(xml|pdf|jpe?g|png|webp|gif|svg)(\?|$)/i.test(url.pathname)) continue;
    url.hash = '';
    if (!found.includes(url.href)) found.push(url.href);
  }
  return found;
}

async function run(url, device) {
  const chrome = await chromeLauncher.launch({ chromeFlags: FLAGS });
  try {
    const options = { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: CATEGORIES };
    const result = await lighthouse(url, options, device === 'desktop' ? desktopConfig : undefined);
    return result.lhr;
  } finally {
    await chrome.kill();
  }
}

const AXE = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
// a client's analytics and forms are left alone: nothing is sent to them by a scan
const STOP = /googletagmanager|google-analytics|facebook|doubleclick|formsubmit/;
const VIEW = { mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, desktop: { width: 1440, height: 900 } };

/** axe-core on a page scrolled from top to bottom: text inside reveal-on-scroll sections is opacity 0 for Lighthouse. */
async function scrolledAxe(url, device) {
  const chrome = await chromeLauncher.launch({ chromeFlags: FLAGS });
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: VIEW[device] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => (STOP.test(r.url()) ? r.abort() : r.continue()));
    // Hostinger's bot protection answers a browser calling itself headless with a "checking your browser" page
    await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
    const res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (res && res.status() >= 400) throw new Error(`answered ${res.status()}`);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(1200);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += Math.round(VIEW[device].height * 0.7)) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await wait(220);
    }
    await wait(1500);
    await page.evaluate(AXE);
    return await page.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ['violations'], runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, example: (v.nodes[0]?.any[0]?.message || v.nodes[0]?.target.join(' ') || '').slice(0, 200) }));
    });
  } finally {
    await browser.disconnect();
    await chrome.kill();
  }
}

function summarise(lhr) {
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, Math.round((lhr.categories[c]?.score ?? 0) * 100)]));
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([k, id]) => {
    const v = lhr.audits[id]?.numericValue;
    return [k, v == null ? null : k === 'cls' ? Number(v.toFixed(3)) : Math.round(v)];
  }));
  const issues = [];
  for (const category of CATEGORIES) {
    for (const ref of lhr.categories[category]?.auditRefs ?? []) {
      const audit = lhr.audits[ref.id];
      if (!audit || audit.score == null || audit.score >= 0.9) continue;
      if (!['numeric', 'binary', 'metricSavings'].includes(audit.scoreDisplayMode)) continue;
      issues.push({ id: ref.id, title: audit.title, category, score: Math.round(audit.score * 100), displayValue: audit.displayValue ?? '' });
    }
  }
  return { scores, metrics, issues };
}

async function scanSite(site) {
  const pages = await pagesOf(site);
  const out = { url: site.url, scannedAt: new Date().toISOString(), pages };
  for (const device of ['mobile', 'desktop']) {
    const perPage = [];
    const issues = new Map();
    const axe = new Map();
    for (const page of pages) {
      try {
        for (const found of await scrolledAxe(page, device)) {
          const seen = axe.get(found.id);
          if (!seen) axe.set(found.id, { ...found, pages: [page] });
          else { seen.pages.push(page); seen.nodes += found.nodes; }
        }
      } catch (error) {
        console.log(`${site.id} ${device} ${page} axe failed: ${error?.message ?? error}`);
      }
      try {
        const { scores, metrics, issues: found } = summarise(await run(page, device));
        perPage.push({ url: page, scores, metrics });
        for (const issue of found) {
          const seen = issues.get(issue.id);
          if (!seen) issues.set(issue.id, { ...issue, pages: [page] });
          else {
            seen.pages.push(page);
            if (issue.score < seen.score) Object.assign(seen, { score: issue.score, displayValue: issue.displayValue });
          }
        }
        console.log(`${site.id} ${device} ${page} ${JSON.stringify(scores)}`);
      } catch (error) {
        perPage.push({ url: page, error: String(error?.message ?? error).slice(0, 300) });
        console.log(`${site.id} ${device} ${page} failed: ${error?.message ?? error}`);
      }
    }
    const ok = perPage.filter((p) => p.scores);
    if (!ok.length) {
      out.error = `no page could be measured on ${device}`;
      continue;
    }
    out[device] = {
      scores: Object.fromEntries(CATEGORIES.map((c) => [c, Math.min(...ok.map((p) => p.scores[c]))])),
      metrics: ok[0].metrics,
      pagesChecked: ok.length,
      perPage,
      issues: [...issues.values()].sort((a, b) => a.score - b.score),
      axe: { count: [...axe.values()].reduce((n, i) => n + i.nodes, 0), issues: [...axe.values()] },
    };
  }
  return out;
}

const sites = JSON.parse(fs.readFileSync('sites.json', 'utf8')).filter((s) => s.active !== false);
const only = process.argv[2]; // `npm run scan -- <id>`: one site, for trying it out
const results = { generatedAt: null, sites: {} };
for (const site of sites) if (!only || site.id === only) results.sites[site.id] = await scanSite(site);
results.generatedAt = new Date().toISOString();

if (only) {
  console.log(JSON.stringify(results, null, 2).slice(0, 4000));
} else {
  fs.mkdirSync('results/history', { recursive: true });
  fs.writeFileSync('results/latest.json', JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(`results/history/${results.generatedAt.slice(0, 10)}.json`, JSON.stringify(results) + '\n');
  console.log(`wrote results for ${Object.keys(results.sites).length} sites`);
}
