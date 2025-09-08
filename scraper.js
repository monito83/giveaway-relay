// Node 18+
// Fuentes: sources.txt (local), SHEET_CSV_URL (Google Sheet CSV), SOURCES_TXT_URL (Gist/raw)
// Revisa Alphabot/Atlas/Subber públicos, detecta sorteos concretos y postea en Discord por Webhook.
// Con crawl suave (profundidad 1), logs de depuración y sin fallback a páginas genéricas.

import fs from "fs/promises";
import { existsSync } from "fs";
import { chromium } from "playwright";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK) {
  console.error("Falta DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const SOURCES_TXT_URL = process.env.SOURCES_TXT_URL || "";
const KEYWORDS = (process.env.KEYWORDS || "").trim();
const MENTION_ROLE_ID = process.env.MENTION_ROLE_ID || "";

const mentionContent = MENTION_ROLE_ID ? `<@&${MENTION_ROLE_ID}>` : "";

// ---------- lectura de fuentes ----------
async function readLocalTxt() {
  if (!existsSync("sources.txt")) return [];
  const raw = await fs.readFile("sources.txt", "utf8");
  return parseTxt(raw);
}
async function readRemoteTxt(url) {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) return [];
  const raw = await res.text();
  return parseTxt(raw);
}
function parseTxt(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
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
async function readSheetCsv(url) {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) return [];
  const csv = await res.text();
  return parseCsv(csv);
}
function parseCsv(csv) {
  const out = [];
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const hasHeader = /name\s*,\s*url/i.test(lines[0]) || /url/i.test(lines[0]);
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const url = parts.slice(1).join(",").trim();
      if (isUrl(url)) out.push({ name: name || url, url });
    } else {
      const url = parts[0].trim();
      if (isUrl(url)) out.push({ name: url, url });
    }
  }
  return out;
}
function isUrl(s) { try { new URL(s); return true; } catch { return false; } }
function dedupeSources(arr) {
  const seen = new Set(), out = [];
  for (const it of arr) {
    if (!seen.has(it.url)) { seen.add(it.url); out.push(it); }
  }
  return out;
}

// ---------- estado ----------
let state;
try { state = JSON.parse(await fs.readFile("state.json", "utf8")); }
catch { state = { seen: {} }; }

// ---------- detección de URLs de sorteo ----------
const isRaffleUrl = (raw) => {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    const p = u.pathname.toLowerCase();

    if (h.includes("alphabot.app")) {
      // SOLO sorteos concretos (evita /_/proyecto y otras rutas genéricas)
      return /(\/r\/|\/raffle\/|\/giveaway\/|\/claim\/|\/winners?\/)/i.test(p);
    }
    if (h.includes("atlas3.io")) {
      // project/<slug>/giveaway/<slug>
      return /\/project\/[^/]+\/giveaway\/[^/]+/i.test(p);
    }
    if (h.includes("subber.xyz")) {
      return /(allowlist|wallet-collection|posts|campaign|raffle|giveaway)/i.test(p);
    }
    return false;
  } catch { return false; }
};

const unique = (arr) => [...new Set(arr)];

async function pickMeta(page) {
  const title = (await page.title()) || "";
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => null);
  const ogDesc  = await page.locator('meta[property="og:description"]').getAttribute("content").catch(() => null);
  return {
    title: (ogTitle || title || "Nuevo sorteo").slice(0, 240),
    description: ogDesc ? ogDesc.slice(0, 1900) : ""
  };
}

async function postToDiscord({sourceName, url, meta}) {
  if (KEYWORDS) {
    const hay = (meta?.title || "") + " " + (meta?.description || "") + " " + url;
    const re = new RegExp(KEYWORDS, "i");
    if (!re.test(hay)) return; // filtrado por keywords
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
  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// ---------- helper: escaneo de una página ----------
async function scanCurrentPage(page) {
  // captura URLs desde respuestas de red (útil en SPAs)
  const respUrls = new Set();
  const onResp = (r) => { const u = r.url(); if (isRaffleUrl(u)) respUrls.add(u); };
  page.on("response", onResp);

  // navegación con fallback: DOMContentLoaded + intento de networkidle corto
  try { await page.waitForLoadState("domcontentloaded", { timeout: 45000 }); } catch {}
  try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {}

  // primera pasada de links
  let links = unique(await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map(a => a.href)));
  // espera por contenido dinámico y segunda pasada
  await page.waitForTimeout(3000);
  const linksAgain = unique(await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map(a => a.href)));
  // merge + respuestas de red
  links = unique([...links, ...linksAgain, ...respUrls]);

  page.off("response", onResp);
  return { links, respCount: respUrls.size };
}

// ---------- crawl suave (profundidad 1) ----------
const MAX_CHILD_PAGES = 8; // subir/bajar si querés
function sameHost(a, b) { try { return new URL(a).host === new URL(b).host; } catch { return false; } }
function looksPromisingPath(p) {
  const s = p.toLowerCase();
  return s.includes("/project/") || s.includes("/giveaway") || s.includes("/r/") || s.includes("/raffle") || s.includes("/_/");
}

async function collectCandidates(ctx, baseUrl) {
  const page = await ctx.newPage();
  const visited = new Set();
  const candidates = new Set();

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {}

    let { links, respCount } = await scanCurrentPage(page);
    const direct = links.filter(isRaffleUrl);
    direct.forEach(u => candidates.add(u));

    console.log(`[root] links:${links.length} resp:${respCount} candidatos:${direct.length}`);

    if (candidates.size === 0) {
      // explorar hijos del mismo host
      const children = unique(
        links.filter(u => sameHost(u, baseUrl))
             .filter(u => !isRaffleUrl(u))
             .filter(u => { try { const { pathname } = new URL(u); return looksPromisingPath(pathname); } catch { return false; } })
      ).slice(0, MAX_CHILD_PAGES);

      console.log(`[crawl] hijos a explorar: ${children.length}`);
      for (const child of children) {
        if (visited.has(child)) continue;
        visited.add(child);
        const p2 = await ctx.newPage();
        try {
          await p2.goto(child, { waitUntil: "domcontentloaded", timeout: 30000 });
          try { await p2.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
          const { links: cLinks, respCount: cResp } = await scanCurrentPage(p2);
          const hits = cLinks.filter(isRaffleUrl);
          console.log(`[child] ${child} -> links:${cLinks.length} resp:${cResp} cand:${hits.length}`);
          hits.forEach(u => candidates.add(u));
        } catch (e) {
          console.log(`[child] error ${child}: ${e.message}`);
        } finally {
          await p2.close();
        }
        if (candidates.size > 0) break; // con un hallazgo alcanza
      }
    }

  } catch (e) {
    console.log(`[root] error ${baseUrl}: ${e.message}`);
  } finally {
    await page.close();
  }

  return [...candidates];
}

// ---------- main ----------
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 GiveawayRelay" });

const sources = dedupeSources([
  ...(await readLocalTxt()),
  ...(await readRemoteTxt(SOURCES_TXT_URL)),
  ...(await readSheetCsv(SHEET_CSV_URL)),
  ...(existsSync("sources.json") ? JSON.parse(await fs.readFile("sources.json", "utf8")).map(it => ({ name: it.name || it.url, url: it.url })) : [])
]);

console.log(`Fuentes cargadas: ${sources.length}`);
sources.forEach((s, i) => console.log(`  [${i+1}] ${s.name} -> ${s.url}`));

let newCount = 0;

for (const src of sources) {
  console.log(`→ Abriendo: ${src.url}`);
  const urls = await collectCandidates(ctx, src.url);
  console.log(`[${src.name}] candidatos totales: ${urls.length}`);

  for (const url of urls) {
    if (state.seen[url]) continue;

    const firstRun = Object.keys(state.seen).length === 0;
    if (firstRun) { state.seen[url] = Date.now(); continue; }

    // obtener meta desde la propia URL concreta (más exacto)
    let meta = { title: "", description: "" };
    const p2 = await ctx.newPage();
    try {
      await p2.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      try { await p2.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
      meta = await pickMeta(p2);
    } catch {}
    await p2.close();

    await postToDiscord({ sourceName: src.name, url, meta });
    state.seen[url] = Date.now();
    newCount++;
    await new Promise(r => setTimeout(r, 800)); // anti-flood
  }
}

await browser.close();
await fs.writeFile("state.json", JSON.stringify(state, null, 2));
console.log(`Listo. Nuevos publicados: ${newCount}`);
