// Node 18+ / 20+
// Fuentes: sources.txt (local), SHEET_CSV_URL (CSV público), SOURCES_TXT_URL (txt/Gist)
// Detecta sorteos en Alphabot / Atlas3 / Subber y postea en Discord por Webhook.
// Incluye: re-escaneo, escucha de responses, auto-scroll, crawl suave (prof. 1),
//          click de "ENTER" en páginas de proyecto de Alphabot.
// Evita publicar páginas genéricas (solo URLs de sorteos reales) y
// restringe Atlas3 al mismo proyecto cuando la fuente es /project/<slug>.
// Logs de depuración para entender qué encontró.

import fs from "fs/promises";
import { existsSync } from "fs";
import { chromium } from "playwright";

// === ENV requeridos/opcionales ===
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK) { console.error("Falta DISCORD_WEBHOOK_URL"); process.exit(1); }

const SHEET_CSV_URL   = process.env.SHEET_CSV_URL || "";    // opcional (Google Sheet publicada como CSV)
const SOURCES_TXT_URL = process.env.SOURCES_TXT_URL || "";  // opcional (txt/Gist RAW)
const KEYWORDS        = (process.env.KEYWORDS || "").trim(); // opcional (p.ej. monad|giveaway|raffle|wl)
const MENTION_ROLE_ID = process.env.MENTION_ROLE_ID || "";   // opcional (rol a mencionar)
const SEED_ON_EMPTY   = (process.env.SEED_ON_EMPTY || "false").toLowerCase() === "true"; // default false

const mentionContent  = MENTION_ROLE_ID ? `<@&${MENTION_ROLE_ID}>` : "";
console.log(`Config → KEYWORDS="${KEYWORDS}" SEED_ON_EMPTY=${SEED_ON_EMPTY}`);

// ========== Lectura de fuentes ==========
async function readLocalTxt(){
  if (!existsSync("sources.txt")) return [];
  const raw = await fs.readFile("sources.txt", "utf8");
  return parseTxt(raw);
}
async function readRemoteTxt(url){
  if (!url) return [];
  const r = await fetch(url);
  if (!r.ok) return [];
  return parseTxt(await r.text());
}
function parseTxt(raw){
  const out = [];
  for (const line of raw.split(/\r?\n/)){
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    if (s.includes("|")) {
      const [name, url] = s.split("|").map(x => x.trim());
      if (isUrl(url)) out.push({ name: name || url, url });
    } else {
      if (isUrl(s)) out.push({ name: s, url: s });
    }
  }
  return out;
}
async function readSheetCsv(url){
  if (!url) return [];
  const r = await fetch(url);
  if (!r.ok) return [];
  const csv = await r.text();
  return parseCsv(csv);
}
function parseCsv(csv){
  const out = [];
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const hasHeader = /name\s*,\s*url/i.test(lines[0]) || /url/i.test(lines[0]);
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i++){
    const parts = lines[i].trim().split(",");
    if (!parts[0]) continue;
    if (parts.length >= 2){
      const name = parts[0].trim();
      const url  = parts.slice(1).join(",").trim();
      if (isUrl(url)) out.push({ name: name || url, url });
    } else {
      const url = parts[0].trim();
      if (isUrl(url)) out.push({ name: url, url });
    }
  }
  return out;
}
function isUrl(s){ try{ new URL(s); return true; }catch{ return false; } }
function dedupeSources(arr){
  const seen = new Set(), out = [];
  for (const it of arr){ if (!seen.has(it.url)){ seen.add(it.url); out.push(it); } }
  return out;
}

// ========== Estado ==========
let state;
try { state = JSON.parse(await fs.readFile("state.json","utf8")); }
catch { state = { seen: {} }; }

// ========== Detección de URLs de sorteo ==========
function hasFileExt(path){ return /\.[a-z0-9]{1,6}$/i.test(path); } // evita .png, .svg, .js, etc

const isRaffleUrl = (raw) => {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    const p = u.pathname.toLowerCase();

    if (h.includes("alphabot.app")) {
      // descartar rutas genéricas o con extensión de archivo
      if (p === "/" || p.startsWith("/_/") || p.startsWith("/login") || hasFileExt(p) ||
          /\/(tos|terms|privacy|status|support|about|contact|brand|api|pricing|blog)\b/i.test(p)) return false;
      // rutas clásicas de raffle
      if (/(\/r\/|\/raffle\/|\/giveaway\/|\/claim\/|\/winners?\/)/i.test(p)) return true;
      // slugs "planos" tipo /poply-otters-testnet-mint-33xye5
      if (/^\/[a-z0-9][a-z0-9-]{2,}$/.test(p)) return true;
      return false;
    }

    if (h.includes("atlas3.io")) {
      // acepta /project/<slug>/(giveaway|giveaways|raffle|campaign|campaigns)/<slug>
      if (/\/project\/[^/]+\/(giveaway|giveaways|raffle|campaign|campaigns)\/[^/]+/i.test(p)) return true;
      // directo a /giveaway/<slug>
      if (/^\/giveaway\/[^/]+/i.test(p)) return true;
      return false;
    }

    if (h.includes("subber.xyz")) {
      // /giveaway(s)/<slug> o /campaign(s)/<slug>
      if (/(\/giveaway\/|\/giveaways\/|\/campaign\/|\/campaigns\/)[^/]+/i.test(p) && !hasFileExt(p)) return true;
      return false;
    }

    return false;
  } catch {
    return false;
  }
};
const isAlphabotProject = (u) => {
  try { const x = new URL(u); return x.hostname.includes("alphabot.app") && x.pathname.startsWith("/_/"); }
  catch { return false; }
};

// ========== Util UI ==========
const unique = (arr) => [...new Set(arr)];

async function pickMeta(page){
  const title = (await page.title()) || "";
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => null);
  const ogDesc  = await page.locator('meta[property="og:description"]').getAttribute("content").catch(() => null);
  return {
    title: (ogTitle || title || "Nuevo sorteo").slice(0, 240),
    description: ogDesc ? ogDesc.slice(0, 1900) : ""
  };
}

async function postToDiscord({sourceName, url, meta}){
  if (KEYWORDS){
    const hay = `${meta?.title||""} ${meta?.description||""} ${url}`;
    if (!(new RegExp(KEYWORDS,"i")).test(hay)) return; // filtrado por keywords
  }
  const payload = {
    username: "Giveaways Relay",
    content: mentionContent || undefined,
    embeds: [{
      title: meta?.title || "Nuevo sorteo",
      url,
      description: (meta?.description ? meta.description + "\n\n" : "") + `📌 Fuente: **${sourceName}**`,
      timestamp: new Date().toISOString()
    }]
  };
  await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

async function autoScroll(page, seconds=5){
  const end = Date.now() + seconds*1000;
  while (Date.now() < end){
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight*0.9)));
    await page.waitForTimeout(350);
  }
  await page.evaluate(() => window.scrollTo(0,0));
}

// ========== Escaneo de una página ==========
async function scanCurrentPage(page){
  // captura URLs desde respuestas de red (útil en SPAs)
  const respUrls = new Set();
  const onResp = (r) => { const u = r.url(); if (isRaffleUrl(u)) respUrls.add(u); };
  page.on("response", onResp);

  // DOM + selector + intento networkidle, y auto-scroll para hidratar cards
  try { await page.waitForLoadState("domcontentloaded", { timeout: 45000 }); } catch {}
  try { await page.waitForSelector('a[href]', { timeout: 12000 }); } catch {}
  try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {}
  await autoScroll(page, 4);

  // primera y segunda pasada de links
  let links = unique(await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map(a => a.href)));
  await page.waitForTimeout(1500);
  const linksAgain = unique(await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map(a => a.href)));

  // merge + responses
  links = unique([...links, ...linksAgain, ...respUrls]);

  page.off("response", onResp);
  return { links, respCount: respUrls.size };
}

// ========== Click de "ENTER" en Alphabot (cards) ==========
async function alphabotClickEnterButtons(page, max = 8){
  const found = new Set();
  const selectors = [
    'button:has-text("ENTER")',
    'a:has-text("ENTER")',
    '[role="button"]:has-text("ENTER")',
    'button:has-text("Enter")',
    'a:has-text("Enter")'
  ];
  let count = 0; for (const sel of selectors){ const c = await page.locator(sel).count().catch(() => 0); count = Math.max(count, c); }
  const total = Math.min(count, max);

  for (let i = 0; i < total; i++){
    let loc = null;
    for (const sel of selectors){ const l = page.locator(sel).nth(i); if (await l.count().catch(() => 0)) { loc = l; break; } }
    if (!loc) continue;

    try {
      const [ok] = await Promise.all([
        page.waitForURL(/\/(r|raffle|giveaway|[a-z0-9-]{3,})\//, { timeout: 8000 }).then(() => true).catch(() => false),
        loc.click({ timeout: 2000 })
      ]);
      if (ok){
        const u = page.url(); if (isRaffleUrl(u)) found.add(u);
        await page.goBack({ waitUntil: "domcontentloaded" });
        try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch {}
      } else {
        await loc.evaluate(el => el.closest('a,button,div,article')?.click());
        const ok2 = await page.waitForURL(/\/(r|raffle|giveaway|[a-z0-9-]{3,})\//, { timeout: 8000 }).then(() => true).catch(() => false);
        if (ok2){
          const u = page.url(); if (isRaffleUrl(u)) found.add(u);
          await page.goBack({ waitUntil: "domcontentloaded" });
          try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch {}
        }
      }
    } catch {}
  }
  return [...found];
}

// ========== Crawl suave (profundidad 1) ==========
const MAX_CHILD_PAGES = 8;
function sameHost(a,b){ try { return new URL(a).host === new URL(b).host; } catch { return false; } }
function looksPromisingPath(p){
  const s = p.toLowerCase();
  return s.includes("/project/") || s.includes("/giveaway") || s.includes("/r/") || s.includes("/raffle") || s.startsWith("/_/");
}
function atlasProjectSlug(url){
  try{
    const u = new URL(url);
    if (!u.hostname.includes("atlas3.io")) return null;
    const m = u.pathname.match(/^\/project\/([^/]+)/i);
    return m ? m[1].toLowerCase() : null;
  }catch{ return null; }
}

async function collectCandidates(ctx, baseUrl){
  const page = await ctx.newPage();
  const candidates = new Set();
  const visited = new Set();
  const atlasSlug = atlasProjectSlug(baseUrl);

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {}
    await autoScroll(page, 4);

    let { links, respCount } = await scanCurrentPage(page);

    // DIRECT: filtrar por patrón + (si Atlas) mismo proyecto
    let direct = links.filter(isRaffleUrl);
    if (atlasSlug) direct = direct.filter(u => u.toLowerCase().includes(`/project/${atlasSlug}/`));
    direct.forEach(u => candidates.add(u));
    console.log(`[root] links:${links.length} resp:${respCount} cand:${direct.length}`);

    // Si es Alphabot /_/proyecto y no hay candidatos, intentar clickear ENTER
    if (candidates.size === 0 && isAlphabotProject(baseUrl)){
      const byClick = await alphabotClickEnterButtons(page, 8);
      byClick.forEach(u => candidates.add(u));
      console.log(`[alphabot ENTER] hallados:${byClick.length}`);
    }

    // Si aún no hay nada, explorar hijos del mismo host (acotado)
    if (candidates.size === 0){
      let children = unique(
        links
          .filter(u => sameHost(u, baseUrl))
          .filter(u => !isRaffleUrl(u))
          .filter(u => { try { const { pathname } = new URL(u); return looksPromisingPath(pathname) && !hasFileExt(pathname); } catch { return false; } })
      );
      // En Atlas, priorizar páginas del mismo proyecto
      if (atlasSlug) children = children.filter(u => u.toLowerCase().includes(`/project/${atlasSlug}`));
      children = children.slice(0, MAX_CHILD_PAGES);

      console.log(`[crawl] hijos a explorar: ${children.length}`);
      for (const child of children){
        if (visited.has(child)) continue;
        visited.add(child);
        const p2 = await ctx.newPage();
        try{
          await p2.goto(child, { waitUntil: "domcontentloaded", timeout: 30000 });
          try { await p2.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
          await autoScroll(p2, 3);
          const { links: cLinks, respCount: cResp } = await scanCurrentPage(p2);
          let hits = cLinks.filter(isRaffleUrl);
          if (atlasSlug) hits = hits.filter(u => u.toLowerCase().includes(`/project/${atlasSlug}/`));
          console.log(`[child] ${child} -> links:${cLinks.length} resp:${cResp} cand:${hits.length}`);
          hits.forEach(u => candidates.add(u));

          if (hits.length === 0 && isAlphabotProject(child)){
            const more = await alphabotClickEnterButtons(p2, 6);
            console.log(`[alphabot ENTER child] ${child} -> ${more.length}`);
            more.forEach(u => candidates.add(u));
          }
        }catch(e){
          console.log(`[child] error ${child}: ${e.message}`);
        }finally{
          await p2.close();
        }
        if (candidates.size > 0) break; // con 1 hallazgo alcanza
      }
    }
  } catch (e) {
    console.log(`[root] error ${baseUrl}: ${e.message}`);
  } finally {
    await page.close();
  }

  return [...candidates];
}

// ========== Main ==========
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
});

const sources = dedupeSources([
  ...(await readLocalTxt()),
  ...(await readRemoteTxt(SOURCES_TXT_URL)),
  ...(await readSheetCsv(SHEET_CSV_URL)),
  ...(existsSync("sources.json") ? JSON.parse(await fs.readFile("sources.json","utf8")).map(it => ({ name: it.name || it.url, url: it.url })) : [])
]);

console.log(`Fuentes cargadas: ${sources.length}`);
sources.forEach((s,i) => console.log(`  [${i+1}] ${s.name} -> ${s.url}`));

let newCount = 0;

for (const src of sources){
  console.log(`→ Abriendo: ${src.url}`);
  const urls = await collectCandidates(ctx, src.url);
  console.log(`[${src.name}] candidatos totales: ${urls.length}`);
  if (urls.length) {
    console.log(`[${src.name}] primeros URLs:\n - ` + urls.slice(0,10).join('\n - '));
  }

  for (const url of urls){
    if (state.seen[url]) continue;

    const firstRun = Object.keys(state.seen).length === 0;
    if (firstRun && SEED_ON_EMPTY){ state.seen[url] = Date.now(); continue; }

    // Abrir la URL concreta para sacar buen título/descr
    let meta = { title: "", description: "" };
    const p2 = await ctx.newPage();
    try{
      await p2.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      try { await p2.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
      meta = await pickMeta(p2);
    }catch{}
    await p2.close();

    await postToDiscord({ sourceName: src.name, url, meta });
    state.seen[url] = Date.now();
    newCount++;
    await new Promise(r => setTimeout(r, 800)); // anti-flood
  }
}

await browser.close();
await fs.writeFile("state.json", JSON.stringify(state,null,2));
console.log(`Listo. Nuevos publicados: ${newCount}`);
