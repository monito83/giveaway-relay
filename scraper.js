// Node 18+
// Lee fuentes desde: sources.txt (local), SHEET_CSV_URL (Google Sheet publicada), SOURCES_TXT_URL (Gist/raw)
// Visita Alphabot/Atlas/Subber públicos, detecta URLs de sorteos y las manda a Discord por Webhook.
// Evita repetidos con state.json

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
  // detección simple de encabezado
  const hasHeader = /name\s*,\s*url/i.test(lines[0]) || /url/i.test(lines[0]);
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // parse muy simple: name,url  (si solo hay 1 columna asumimos URL)
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

function isUrl(s) {
  try { new URL(s); return true; } catch { return false; }
}

function dedupeSources(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (!seen.has(it.url)) {
      seen.add(it.url);
      out.push(it);
    }
  }
  return out;
}

let state;
try { state = JSON.parse(await fs.readFile("state.json", "utf8")); }
catch { state = { seen: {} }; }

const isRaffleUrl = (raw) => {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    const p = u.pathname.toLowerCase();

    if (h.includes("alphabot.app")) {
      // Rutas típicas con sorteos en detalle o subpáginas
      if (p === "/" || p.startsWith("/login")) return false;
      return /(raffle|raffles|giveaway|claim|r\/|winner|winners)/i.test(p);
    }
    if (h.includes("atlas3.io")) {
      // project/<slug>/giveaway/<slug>
      return /\/project\/[^/]+\/giveaway\/[^/]+/i.test(p);
    }
    if (h.includes("subber.xyz")) {
      // páginas públicas comunes
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
  // filtro de keywords (si se setea)
  if (KEYWORDS) {
    const hay = (meta?.title || "") + " " + (meta?.description || "") + " " + url;
    const re = new RegExp(KEYWORDS, "i");
    if (!re.test(hay)) return; // skip si no matchea
  }

  const payload = {
    username: "Giveaways Relay",
    content: mentionContent || undefined,
    embeds: [{
      title: meta?.title || "Nuevo sorteo",
      url,
      description: (meta?.description ? meta.description + "\\n\\n" : "") + `📌 Fuente: **${sourceName}**`,
      timestamp: new Date().toISOString()
    }]
  };
  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function loadSources() {
  const bag = [];
  bag.push(...await readLocalTxt());
  bag.push(...await readRemoteTxt(SOURCES_TXT_URL));
  bag.push(...await readSheetCsv(SHEET_CSV_URL));

  // soporte opcional de sources.json (compatibilidad)
  if (existsSync("sources.json")) {
    try {
      const j = JSON.parse(await fs.readFile("sources.json", "utf8"));
      for (const it of j) if (isUrl(it.url)) bag.push({ name: it.name || it.url, url: it.url });
    } catch {}
  }
  return dedupeSources(bag);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 GiveawayRelay" });

const sources = await loadSources();
let newCount = 0;

for (const src of sources) {
  const page = await ctx.newPage();
  try {
    await page.goto(src.url, { waitUntil: "networkidle", timeout: 60000 });

    // Juntar links
    const links = unique(await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map(a => a.href)));

    // Filtrar candidatos
    const candidates = links.filter(isRaffleUrl).slice(0, 80);
    // Si la propia URL parece ser un giveaway y no hay links, usar self
    const fallbackSelf = candidates.length === 0 && isRaffleUrl(src.url) ? [src.url] : [];

    for (const url of unique([...candidates, ...fallbackSelf])) {
      if (state.seen[url]) continue;

      // Primera corrida: sembrar sin postear (evitar spam)
      const firstRun = Object.keys(state.seen).length === 0;
      if (firstRun) {
        state.seen[url] = Date.now();
        continue;
      }

      let meta = await pickMeta(page);
      if (!meta.title) {
        const p2 = await ctx.newPage();
        try { await p2.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); meta = await pickMeta(p2); }
        catch {}
        await p2.close();
      }

      await postToDiscord({ sourceName: src.name, url, meta });
      state.seen[url] = Date.now();
      newCount++;
      await new Promise(r => setTimeout(r, 800)); // anti-flood
    }

  } catch (e) {
    console.error(`Error en fuente ${src.name}:`, e.message);
  } finally {
    await page.close();
  }
}

await browser.close();
await fs.writeFile("state.json", JSON.stringify(state, null, 2));
console.log(`Listo. Nuevos publicados: ${newCount}`);
