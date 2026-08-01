#!/usr/bin/env node
// Infra Status Dashboard — two layers:
//   1. APPS  — scans your local project folders and lists every app by name,
//              showing which backend each is wired to (Supabase / Netlify /
//              Vercel / Resend / Stripe). Needs NO tokens — reads the code.
//   2. PLATFORMS — live status from Netlify / Supabase / Resend if you add
//              read-only tokens to .env (optional enrichment).
//
//   node sync.mjs        → rewrites dashboard.html
//
// No npm install — uses Node built-ins only (Node 18+).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { homedir } from "node:os";

const DIR = dirname(fileURLToPath(import.meta.url));
const now = new Date();

// ── config + env ─────────────────────────────────────────────────────
function loadEnv() {
  const p = join(DIR, ".env"); const env = {};
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
function loadConfig() {
  const p = join(DIR, "config.json");
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return {};
}
function loadExpenses() {
  for (const f of ["expenses.json", "expenses.example.json"]) {
    const p = join(DIR, f);
    if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  }
  return { currency: "GBP", services: [] };
}
function loadMeta() {
  const p = join(DIR, "apps-meta.json");
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")).projects || {}; } catch {} }
  return {};
}
const env = loadEnv();
const cfg = loadConfig();
const expenses = loadExpenses();
const meta = loadMeta();

// ── integration signatures: what external services an app connects to ──
const SERVICE_SIGS = [
  { s: "Supabase", cat: "database", env: /SUPABASE/, dep: /@supabase/, src: /supabase\.co|createClient\(/ },
  { s: "Stripe", cat: "payments", env: /STRIPE/, dep: /stripe/, src: /js\.stripe\.com|stripe\(/ },
  { s: "Resend", cat: "email", env: /RESEND/, dep: /^resend$/, src: /api\.resend\.com/ },
  { s: "Brevo", cat: "email", env: /BREVO|SENDINBLUE/, dep: /sib-api|getbrevo|brevo/, src: /brevo|sendinblue/ },
  { s: "SendGrid", cat: "email", env: /SENDGRID/, dep: /sendgrid/ },
  { s: "Google Maps", cat: "maps", env: /GOOGLE_MAPS|MAPS_API|MAPS_KEY/, dep: /@googlemaps|google-map/, src: /maps\.googleapis\.com|GOOGLE_MAPS_KEY/ },
  { s: "OpenAI", cat: "ai", env: /OPENAI/, dep: /^openai$/, src: /api\.openai\.com|sk-proj-/ },
  { s: "Anthropic", cat: "ai", env: /ANTHROPIC/, dep: /@anthropic/, src: /api\.anthropic\.com|sk-ant-/ },
  { s: "Gemini", cat: "ai", env: /GEMINI|GOOGLE_AI|GENERATIVE/, dep: /generative-ai/, src: /generativelanguage\.googleapis/ },
  { s: "Hunter", cat: "enrichment", env: /HUNTER/, src: /api\.hunter\.io/ },
  { s: "GA4", cat: "analytics", env: /VITE_GA|GA_MEASUREMENT/, src: /G-[A-Z0-9]{10}|googletagmanager\.com\/gtag/ },
  { s: "Meta Pixel", cat: "analytics", src: /fbq\(|connect\.facebook\.net/ },
  { s: "GTM", cat: "analytics", src: /GTM-[A-Z0-9]{5,}/ },
  { s: "Plausible", cat: "analytics", src: /plausible\.io/ },
  { s: "PostHog", cat: "analytics", dep: /posthog/, src: /posthog/ },
  { s: "Twilio", cat: "sms", env: /TWILIO/, dep: /twilio/ },
  { s: "Netlify Functions", cat: "backend", file: "netlify/functions" },
  { s: "Cron/Webhook", cat: "webhook", env: /CRON_SECRET|WEBHOOK/ },
];
function detectIntegrations(appDir, envText, depNames) {
  // one bounded scan of source, then test every signature against it
  const src = scanFiles(appDir, "(supabase\\.co|js\\.stripe\\.com|api\\.resend\\.com|maps\\.googleapis\\.com|api\\.openai\\.com|api\\.anthropic\\.com|generativelanguage|api\\.hunter\\.io|googletagmanager|G-[A-Z0-9]{10}|GTM-[A-Z0-9]{5,}|plausible\\.io|posthog|fbq\\(|connect\\.facebook|brevo|sendinblue|createClient\\(|GOOGLE_MAPS_KEY|sk-ant-|sk-proj-)",
    { exts: [".js", ".ts", ".tsx", ".jsx", ".html", ".json", ".env", ".example"], cap: 250 }).join(" ");
  const deps = (depNames || []).join(" ");
  const out = [];
  for (const sig of SERVICE_SIGS) {
    let hit = false;
    if (sig.env && sig.env.test(envText)) hit = true;
    if (!hit && sig.dep && (depNames || []).some((d) => sig.dep.test(d))) hit = true;
    if (!hit && sig.src && sig.src.test(src)) hit = true;
    if (!hit && sig.file && existsSync(join(appDir, sig.file))) hit = true;
    if (hit) out.push({ service: sig.s, category: sig.cat });
  }
  return out;
}

// Where your apps live. Default: the folder two levels above /dashboard's parent
// (…/ClaudeCodes). Override with APPS_DIR in .env or "appsDir" in config.json.
const APPS_DIR = env.APPS_DIR || cfg.appsDir || resolve(DIR, "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "Plugins", "dashboard"]);

// =====================================================================
//  LAYER 1 — LOCAL APP SCAN (no tokens)
// =====================================================================
function readJSON(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

// bounded recursive text scan for a regex, skipping heavy dirs
function scanFiles(root, regex, { exts, cap = 300 } = {}) {
  const hits = new Set(); let seen = 0; const stack = [root];
  while (stack.length && seen < cap) {
    const cur = stack.pop();
    let entries; try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".git")) stack.push(full); continue; }
      if (exts && !exts.some((x) => e.name.endsWith(x))) continue;
      seen++; if (seen > cap) break;
      let txt; try { txt = readFileSync(full, "utf8"); } catch { continue; }
      let m; const re = new RegExp(regex, "g");
      while ((m = re.exec(txt))) hits.add(m[1] || m[0]);
    }
  }
  return [...hits];
}

// env files at shallow depth
function readEnvFiles(appDir) {
  const out = [];
  for (const name of [".env", ".env.local", ".env.production"]) {
    const p = join(appDir, name);
    if (existsSync(p)) { try { out.push(readFileSync(p, "utf8")); } catch {} }
  }
  return out.join("\n");
}

function scanApp(name, appDir) {
  const pkg = readJSON(join(appDir, "package.json"));
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  const depNames = Object.keys(deps);
  const has = (re) => depNames.some((d) => re.test(d));
  const envText = readEnvFiles(appDir);

  // Supabase project refs (host subdomain only — never keys)
  let refs = [...new Set((envText.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/g) || [])
    .map((u) => u.replace(/https:\/\/|\.supabase\.co/g, "")))];
  const usesSupabase = has(/@supabase\/supabase-js|supabase/) || refs.length > 0 || /SUPABASE_URL/.test(envText);
  if (usesSupabase && refs.length === 0) {
    refs = scanFiles(appDir, "https://([a-z0-9]{20})\\.supabase\\.co",
      { exts: [".ts", ".tsx", ".js", ".jsx", ".html", ".env", ".local", ".production"], cap: 200 });
  }
  // In Vite the LAST VITE_SUPABASE_URL wins; earlier duplicates are stale. Surface the active one first.
  const viteRefs = [...envText.matchAll(/VITE_SUPABASE_URL=https:\/\/([a-z0-9]{20})/g)].map((m) => m[1]);
  const activeRef = viteRefs.length ? viteRefs[viteRefs.length - 1] : refs[0];
  if (activeRef) refs = [activeRef, ...refs.filter((r) => r !== activeRef)];

  // git remote — verified hosting/repo identity
  let repo = null, repoOwner = null;
  const gitCfg = join(appDir, ".git", "config");
  if (existsSync(gitCfg)) {
    try {
      const m = readFileSync(gitCfg, "utf8").match(/url\s*=\s*.*github\.com[:/]([^/]+)\/([^\s.]+)/i);
      if (m) { repoOwner = m[1]; repo = `${m[1]}/${m[2]}`; }
    } catch {}
  }
  const thirdParty = repoOwner ? !/seckin|curious/i.test(repoOwner) : false;
  const hasGit = existsSync(gitCfg);
  const noRemote = hasGit && !repo;

  // analytics: real GA4 id vs placeholder vs plausible vs none
  const anyGA = scanFiles(appDir, "(G-[A-Z0-9]{10})", { exts: [".html", ".ts", ".tsx", ".js", ".jsx", ".env"], cap: 200 });
  const realGA = anyGA.filter((id) => !/X{6,}/.test(id));
  const plausible = scanFiles(appDir, "(plausible\\.io)", { exts: [".html", ".ts", ".tsx", ".js"], cap: 100 }).length > 0;
  const analytics = realGA.length ? { kind: "ga4", id: realGA[0] } : anyGA.length ? { kind: "placeholder" } : plausible ? { kind: "plausible" } : { kind: "none" };

  // Netlify link state (real deployed site id) confirms it IS live on Netlify
  let netlifySiteId = null;
  const nlState = join(appDir, ".netlify", "state.json");
  if (existsSync(nlState)) { try { netlifySiteId = readJSON(nlState)?.siteId || null; } catch {} }

  const deploy =
    netlifySiteId || existsSync(join(appDir, "netlify.toml")) || existsSync(join(appDir, "netlify")) ? "Netlify" :
    existsSync(join(appDir, "vercel.json")) ? "Vercel" :
    repo ? "git → ?" : null; // has a repo but no local deploy cfg: likely git-integration deploy, target unknown

  const usesResend = has(/resend/) || /RESEND_API_KEY|RESEND_TOKEN/.test(envText);
  const usesStripe = has(/stripe/) || /STRIPE_/.test(envText);
  const isStatic = !pkg && existsSync(join(appDir, "index.html"));
  const isApp = existsSync(join(appDir, "index.html")) || !!pkg;
  if (!isApp) return null; // not a web app folder

  return {
    name,
    kind: usesSupabase ? "Dynamic" : isStatic ? "Static" : "App",
    supabase: usesSupabase,
    supabaseRefs: refs,
    supabaseConflict: refs.length > 1,
    deploy,
    resend: usesResend,
    stripe: usesStripe,
    repo,
    thirdParty,
    hasGit,
    noRemote,
    analytics,
    netlifySiteId,
    integrations: detectIntegrations(appDir, envText, depNames),
    type: meta[name]?.type || (usesSupabase ? "app" : isStatic ? "website" : "app"),
    label: meta[name]?.label || name,
    purpose: meta[name]?.purpose || "",
    url: meta[name]?.url || "",
    issues: meta[name]?.issues || [],
    path: appDir,
  };
}

function scanApps() {
  let entries; try { entries = readdirSync(APPS_DIR, { withFileTypes: true }); } catch { return { dir: APPS_DIR, apps: [], error: "cannot read apps dir" }; }
  const apps = [];
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    try { const a = scanApp(e.name, join(APPS_DIR, e.name)); if (a) apps.push(a); } catch {}
  }
  apps.sort((a, b) => (b.supabase - a.supabase) || a.name.localeCompare(b.name));
  return { dir: APPS_DIR, apps };
}

// =====================================================================
//  LAYER 2 — LIVE PLATFORM STATUS (optional tokens)
// =====================================================================
async function api(url, token, extra = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extra }, signal: ctl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) { return { error: e.name === "AbortError" ? "timeout" : e.message }; }
  finally { clearTimeout(t); }
}
const numv = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const bytesToGB = (b) => (numv(b) == null ? null : b / 1e9);

async function netlify() {
  const token = env.NETLIFY_TOKEN; if (!token) return { connected: false };
  const accounts = await api("https://api.netlify.com/api/v1/accounts", token);
  if (accounts.error) return { connected: false, error: accounts.error };
  const acct = (accounts.data || [])[0] || {};
  const sitesR = await api("https://api.netlify.com/api/v1/sites?per_page=100", token);
  const sites = (sitesR.data || []).map((s) => ({ name: s.name, url: s.ssl_url || s.url, state: s.published_deploy?.state || s.state || "unknown" }));
  let bandwidth = null;
  if (acct.id) { const bw = await api(`https://api.netlify.com/api/v1/accounts/${acct.id}/bandwidth`, token);
    if (!bw.error && bw.data) bandwidth = { usedGB: bytesToGB(bw.data.used), includedGB: bytesToGB(bw.data.included) }; }
  return { connected: true, sites, upCount: sites.filter((s) => s.state === "ready" || s.state === "current").length, bandwidth };
}
async function supabaseLive() {
  const token = env.SUPABASE_TOKEN; if (!token) return { connected: false };
  const projR = await api("https://api.supabase.com/v1/projects", token);
  if (projR.error) return { connected: false, error: projR.error };
  const projects = (projR.data || []).map((p) => ({ name: p.name, region: p.region, status: p.status, ref: p.id || p.ref }));
  return { connected: true, projects, healthy: projects.filter((p) => p.status === "ACTIVE_HEALTHY").length };
}
async function resendLive() {
  const token = env.RESEND_TOKEN; if (!token) return { connected: false };
  const domR = await api("https://api.resend.com/domains", token);
  if (domR.error) return { connected: false, error: domR.error };
  const list = domR.data?.data || domR.data || [];
  const domains = (Array.isArray(list) ? list : []).map((d) => ({ name: d.name, status: d.status }));
  return { connected: true, domains, verified: domains.filter((d) => d.status === "verified").length };
}

// ── live Supabase reachability (no token — public /auth/v1/health) ────
async function pingRef(ref) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { await fetch(`https://${ref}.supabase.co/auth/v1/health`, { signal: ctl.signal }); return true; } // any HTTP reply = project exists & serving
  catch { return false; } // DNS/connection failure = paused or deleted
  finally { clearTimeout(t); }
}
async function pingSupabase(apps) {
  await Promise.all(apps.filter((a) => a.supabase && a.supabaseRefs[0]).map(async (a) => {
    a.supabaseAlive = await pingRef(a.supabaseRefs[0]);
    if (a.supabaseConflict) {
      a.staleChecks = [];
      for (const r of a.supabaseRefs.slice(1)) a.staleChecks.push({ ref: r, alive: await pingRef(r) });
    }
  }));
}

// ── SEO audit: fetch each live site and grade on-page SEO ────────────
async function fetchText(url, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const res = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": "CuriousOps-SEO/1.0" } }); return { ok: res.ok, status: res.status, text: await res.text() }; }
  catch { return { ok: false, status: 0, text: "" }; }
  finally { clearTimeout(t); }
}
async function auditSite(url) {
  const r = await fetchText(url);
  if (!r.ok) return { url, up: false, status: r.status };
  const h = r.text; const has = (re) => re.test(h);
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, " ").trim() || "";
  const desc = (h.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || h.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1]?.trim() || "";
  let origin; try { origin = new URL(url).origin; } catch { origin = url; }
  const [robots, sitemap] = await Promise.all([fetchText(origin + "/robots.txt", 6000), fetchText(origin + "/sitemap.xml", 6000)]);
  return {
    url, up: true, status: r.status,
    title, titleLen: title.length,
    desc, descLen: desc.length,
    h1: has(/<h1[\s>]/i),
    canonical: has(/<link[^>]+rel=["']canonical["']/i),
    indexable: !/<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(h),
    og: has(/property=["']og:(title|image|description)["']/i),
    viewport: has(/name=["']viewport["']/i),
    lang: has(/<html[^>]+lang=/i),
    favicon: has(/rel=["'][^"']*icon["']/i),
    jsonld: has(/application\/ld\+json/i),
    robotsTxt: robots.ok && /user-agent/i.test(robots.text),
    sitemap: sitemap.ok && /<(urlset|sitemapindex)/i.test(sitemap.text),
  };
}
function seoScore(a) {
  if (!a.up) return { n: 0, of: 11 };
  let n = 0;
  if (a.title && a.titleLen >= 10 && a.titleLen <= 65) n++;
  if (a.desc && a.descLen >= 50 && a.descLen <= 165) n++;
  if (a.h1) n++; if (a.canonical) n++; if (a.indexable) n++; if (a.og) n++;
  if (a.viewport) n++; if (a.lang) n++; if (a.favicon) n++; if (a.robotsTxt) n++; if (a.sitemap) n++;
  return { n, of: 11 };
}
async function seoAudit(urls) {
  const uniq = [...new Set(urls.filter(Boolean))];
  return Promise.all(uniq.map(async (u) => { const a = await auditSite(u); return { ...a, score: seoScore(a) }; }));
}

// ── Claude Code usage from local logs (~/.claude/projects) ───────────
// Est. cost = Anthropic API list price. cacheWrite=1.25x input, cacheRead=0.1x input.
const CLAUDE_PRICE = { opus: { in: 15, out: 75, cw: 18.75, cr: 1.5 }, sonnet: { in: 3, out: 15, cw: 3.75, cr: 0.3 }, haiku: { in: 1, out: 5, cw: 1.25, cr: 0.1 } };
const cTier = (m = "") => (/opus/.test(m) ? "opus" : /sonnet/.test(m) ? "sonnet" : /haiku/.test(m) ? "haiku" : "opus");
function projName(p) {
  const i = p.lastIndexOf("ClaudeCodes");
  let tail = i >= 0 ? p.slice(i + 11).replace(/^-+/, "") : p;
  if (!tail) return "General (mixed)";
  const flat = tail.replace(/-/g, "").toLowerCase();
  for (const k of ["BSHNewsletter", "FutureReadyTest", "curious-prospector", "Cimadam", "pilates-finder"])
    if (flat.includes(k.replace(/-/g, "").toLowerCase())) return k;
  if (/quiz/.test(flat)) return "Brief Quiz";
  if (/leadmagnet|factory|dashboard|plugins/.test(flat)) return "Ops Dashboard";
  if (/promptschat|promptchat/.test(flat)) return "prompts.chat";
  return tail.split("-").filter(Boolean).slice(0, 2).join(" ");
}

async function claudeUsage() {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return { available: false };
  const NOW = Date.now();
  const files = [];
  for (const p of readdirSync(root)) { try { for (const f of readdirSync(join(root, p))) if (f.endsWith(".jsonl")) files.push({ file: join(root, p, f), proj: p }); } catch {} }
  const byTier = {}, byMonth = {}, byProject = {};
  const week = Array.from({ length: 12 }, () => ({ cost: 0, tok: 0 }));
  const day = Array.from({ length: 7 }, () => ({ cost: 0, tok: 0 }));
  let msgs = 0, cost = 0, tokens = 0, minMo = "9999", maxMo = "0000";
  for (const { file, proj } of files) {
    await new Promise((res) => {
      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.includes("usage")) return;
        let j; try { j = JSON.parse(line); } catch { return; }
        const u = j?.message?.usage; if (!u) return;
        const t = cTier(j?.message?.model);
        const r = byTier[t] ||= { in: 0, out: 0, cw: 0, cr: 0, msgs: 0 };
        const iv = u.input_tokens || 0, ov = u.output_tokens || 0, cwv = u.cache_creation_input_tokens || 0, crv = u.cache_read_input_tokens || 0;
        const tok = iv + ov + cwv + crv;
        r.in += iv; r.out += ov; r.cw += cwv; r.cr += crv; r.msgs++; msgs++;
        const pr = CLAUDE_PRICE[t];
        const c = (iv * pr.in + ov * pr.out + cwv * pr.cw + crv * pr.cr) / 1e6;
        cost += c; tokens += tok;
        const P = byProject[proj] ||= { name: projName(proj), cost: 0, tok: 0, msgs: 0, last: "" };
        P.cost += c; P.tok += tok; P.msgs++; if ((j.timestamp || "") > P.last) P.last = j.timestamp || "";
        const mo = (j.timestamp || "").slice(0, 7); if (/^\d{4}-\d{2}$/.test(mo)) { const m = byMonth[mo] ||= { cost: 0, tok: 0 }; m.cost += c; m.tok += tok; if (mo < minMo) minMo = mo; if (mo > maxMo) maxMo = mo; }
        const ts = Date.parse(j.timestamp || ""); if (ts) { const da = Math.floor((NOW - ts) / 86400000); const wi = Math.floor(da / 7); if (wi >= 0 && wi < 12) { week[wi].cost += c; week[wi].tok += tok; } if (da >= 0 && da < 7) { day[da].cost += c; day[da].tok += tok; } }
      });
      rl.on("close", res);
    });
  }
  // merge project folders that map to the same display name
  const agg = {};
  for (const p of Object.values(byProject)) { const a = agg[p.name] ||= { name: p.name, cost: 0, tok: 0, msgs: 0, last: "" }; a.cost += p.cost; a.tok += p.tok; a.msgs += p.msgs; if (p.last > a.last) a.last = p.last; }
  return { available: true, msgs, cost, tokens, byTier, byMonth, projects: Object.values(agg).sort((a, b) => b.cost - a.cost), week, day, thisWeek: week[0], minMo, maxMo, sessions: files.length };
}

// ── Hunter.io account credits ────────────────────────────────────────
async function hunter() {
  const key = env.HUNTER_API_KEY; if (!key) return { connected: false };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(`https://api.hunter.io/v2/account?api_key=${key}`, { signal: ctl.signal });
    if (!res.ok) return { connected: false, error: `HTTP ${res.status}` };
    const j = (await res.json()).data || {};
    return { connected: true, plan: j.plan_name, reset: j.reset_date, searches: j.requests?.searches, verifications: j.requests?.verifications };
  } catch (e) { return { connected: false, error: e.name === "AbortError" ? "timeout" : e.message }; }
  finally { clearTimeout(t); }
}

// ── run ──────────────────────────────────────────────────────────────
const scan = scanApps();
await pingSupabase(scan.apps);
const claude = await claudeUsage();
const [nf, sb, rs, hunt] = await Promise.all([netlify(), supabaseLive(), resendLive(), hunter()]);
// SEO targets: live Netlify sites (prefer custom domains) + any extras in config
const seo = await seoAudit([
  ...(nf.sites || []).map((s) => s.url).filter(Boolean),
  ...(cfg.seoExtraSites || ["https://curiouslabs.co.uk"]),
]);
console.log("SEO audited:", seo.length, "sites ·", seo.filter((s) => s.up).length, "up");

console.log("App scan:", scan.dir);
for (const a of scan.apps) console.log(`  ${a.supabase ? "◆" : "○"} ${a.name} — ${a.kind}${a.supabase ? " · supabase " + (a.supabaseRefs[0] || "?") : ""}${a.deploy ? " · " + a.deploy : ""}${a.resend ? " · resend" : ""}${a.stripe ? " · stripe" : ""}`);
const tag = (r) => (r.connected ? "live" : r.error || "no token");
console.log("Platforms: netlify", tag(nf), "| supabase", tag(sb), "| resend", tag(rs));

if (claude.available) console.log(`Claude usage: ${claude.msgs.toLocaleString()} msgs · est. $${claude.cost.toFixed(0)} API-equivalent (${claude.minMo}→${claude.maxMo})`);
writeFileSync(join(DIR, "dashboard.html"), renderHTML({ scan, nf, sb, rs, hunt, cfg, expenses, claude, seo, now }));
console.log("→ wrote dashboard.html");

// =====================================================================
//  RENDER
// =====================================================================
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function money(v, cur = "USD") { if (numv(v) == null) return "—"; const s = cur === "GBP" ? "£" : cur === "EUR" ? "€" : "$"; return s + v.toLocaleString("en-GB", { maximumFractionDigits: 0 }); }
function gb(v) { return numv(v) == null ? "—" : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1); }
function pct(u, l) { if (numv(u) == null || numv(l) == null || l === 0) return null; return Math.min(100, Math.max(0, (u / l) * 100)); }
function bar(p, tone = "") { if (p == null) return `<div class="bar"><span style="width:0%"></span></div>`; const t = p >= 90 ? "crit" : p >= 75 ? "warn" : tone || "good"; return `<div class="bar ${t}"><span style="width:${p.toFixed(1)}%"></span></div>`; }
function htag(cls, label) { return `<span class="tag ${cls}">${esc(label)}</span>`; }

// ── expenses section: chart + totals + upcoming renewals ─────────────
function renderExpenses(expenses, now) {
  const cur = expenses.currency || "GBP";
  const svcs = (expenses.services || []).map((s) => {
    const monthly = numv(s.cost) == null ? null : (s.cycle === "yearly" ? s.cost / 12 : s.cost);
    let daysToRenew = null;
    if (s.renews) { const d = new Date(s.renews + "T00:00:00"); if (!isNaN(d)) daysToRenew = Math.round((d - now) / 86400000); }
    return { ...s, monthly, daysToRenew };
  });
  const known = svcs.filter((s) => s.monthly != null);
  const monthlyTotal = known.reduce((a, s) => a + s.monthly, 0);
  const filledIn = known.length, total = svcs.length;
  const maxM = Math.max(1, ...known.map((s) => s.monthly));

  // bar chart (monthly cost per service)
  const chart = svcs.map((s) => {
    const w = s.monthly != null ? (s.monthly / maxM) * 100 : 0;
    const val = s.monthly != null ? money(s.monthly, cur) + "/mo" : "not set";
    return `<div class="xrow">
      <div class="xname">${esc(s.name)}${s.plan ? ` <span>${esc(s.plan)}</span>` : ""}</div>
      <div class="xbar"><div class="xfill ${s.monthly == null ? "empty" : ""}" style="width:${w.toFixed(1)}%"></div></div>
      <div class="xval ${s.monthly == null ? "dim" : ""}">${val}</div>
    </div>`;
  }).join("");

  // upcoming renewals (soonest first)
  const upcoming = svcs.filter((s) => s.daysToRenew != null).sort((a, b) => a.daysToRenew - b.daysToRenew);
  const renewHTML = upcoming.length ? upcoming.map((s) => {
    const soon = s.daysToRenew <= 7, over = s.daysToRenew < 0;
    const label = over ? `${Math.abs(s.daysToRenew)}d ago` : s.daysToRenew === 0 ? "today" : `in ${s.daysToRenew}d`;
    return `<div class="renew ${over ? "over" : soon ? "soon" : ""}">
      <div class="r-when">${esc(label)}</div>
      <div class="r-name">${esc(s.name)}${s.monthly != null ? ` · ${money(s.cycle === "yearly" ? s.cost : s.monthly, cur)}${s.cycle === "yearly" ? "/yr" : "/mo"}` : ""}</div>
      <div class="r-date">${esc(s.renews)}</div></div>`;
  }).join("") : `<div class="pc-line dim">No renewal dates set. Add "renews":"YYYY-MM-DD" per service in expenses.json — Claude's especially, to get the countdown you asked for.</div>`;

  return `
  <div class="section-label"><h2>Spend</h2><div class="rule"></div>
    <span class="count">${filledIn}/${total} costs entered</span></div>
  <div class="spend">
    <div class="panel">
      <div class="spend-head">
        <div><div class="k-label">Monthly</div><div class="big">${filledIn ? money(monthlyTotal, cur) : "—"}</div></div>
        <div><div class="k-label">Yearly</div><div class="big">${filledIn ? money(monthlyTotal * 12, cur) : "—"}</div></div>
        <div class="spend-note">${filledIn < total ? `${total - filledIn} service${total - filledIn > 1 ? "s" : ""} still need a figure — totals are partial` : "all services costed"}</div>
      </div>
      <div class="xchart">${chart}</div>
    </div>
    <div class="panel renews">
      <div class="k-label" style="margin-bottom:10px">Upcoming charges</div>
      ${renewHTML}
    </div>
  </div>`;
}

function renderClaude(claude, con, max) {
  if (!claude?.available && !con) return "";
  const usd = (n) => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US");
  const usd0 = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const M = (n) => (n / 1e6 >= 1000 ? (n / 1e9).toFixed(1) + "B" : (n / 1e6).toFixed(1) + "M");
  const maxCost = max && numv(max.cost) != null ? max.cost : null;
  const roi = maxCost && claude?.available ? Math.round(claude.cost / maxCost) : null;

  // Max subscription panel (the flat fee that covers Claude Code)
  const maxPanel = max ? `
    <div class="panel">
      <div class="spend-head">
        <div><div class="k-label">Claude Max subscription</div><div class="big">${maxCost != null ? usd0(maxCost) + "/mo" : "Max"}</div></div>
        ${roi ? `<div><div class="k-label">Usage vs fee</div><div class="big" style="color:var(--good)">${roi}×</div></div>` : ""}
        <div class="spend-note">Flat fee — <b>covers all Claude Code usage</b>${maxCost == null ? " · " + esc(max.note || "") : ""}</div>
      </div>
      <div class="pc-line">powers Claude Code · ${claude?.available ? claude.msgs.toLocaleString() + " messages" : ""}</div>
      <div class="pc-line dim">${roi ? `You consume ~${usd0(claude.cost)} of list-price value for ${usd0(maxCost)}/mo.` : "Add your Max price to expenses.json to see the ROI multiple."}</div>
    </div>` : "";

  // REAL panel from the Anthropic console (ground truth)
  const realPanel = con ? `
    <div class="panel">
      <div class="spend-head">
        <div><div class="k-label">Actual spend this month</div><div class="big">${usd(con.spentThisMonth)}</div></div>
        <div><div class="k-label">Credit balance</div><div class="big">${usd(con.balance)}</div></div>
        <div class="spend-note">${esc(con.model || "Pay-as-you-go")} · resets ${esc(con.resets || "")}</div>
      </div>
      <div class="pc-line">last top-up <b>${usd0(con.lastTopUp)}</b> <span class="dim">($50 + VAT)</span></div>
      <div class="pc-line">auto-reload <b style="color:${con.autoReload ? "var(--good)" : "var(--warn)"}">${con.autoReload ? "ON" : "OFF"}</b> ${con.autoReload ? "" : `<span class="dim">← no safety net if balance hits $0</span>`}</div>
      <div class="pc-line dim" style="margin-top:6px">Source: platform.claude.com — this is your real bill.</div>
    </div>` : "";

  // estimate panel (clearly demoted / caveated)
  const months = claude?.available ? Object.keys(claude.byMonth).sort() : [];
  const maxC = Math.max(1, ...months.map((m) => claude.byMonth[m].cost));
  const monthBars = months.map((m) => {
    const c = claude.byMonth[m].cost;
    const label = new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
    return `<div class="xrow"><div class="xname">${esc(label)}</div>
      <div class="xbar"><div class="xfill empty" style="width:${((c / maxC) * 100).toFixed(1)}%"></div></div>
      <div class="xval dim">${usd0(c)}</div></div>`;
  }).join("");
  const estPanel = claude?.available ? `
    <div class="panel">
      <div class="k-label">Local token logs · list-price valuation</div>
      <div class="note info" style="margin:8px 0 12px"><span class="ic">i</span><span><b>Not a bill.</b> ${usd0(claude.cost)} is the API list-price of ${claude.msgs.toLocaleString()} logged messages — <b>covered by your flat Max subscription</b>, not charged per-token. Shown only to gauge usage volume &amp; value.</span></div>
      <div class="xchart">${monthBars}</div>
    </div>` : "";

  return `
  ${secHead("Claude / Anthropic", "Your real Anthropic spend vs the usage value your flat Max plan delivers.", "Max subscription + API credits")}
  <div class="spend">${maxPanel}${realPanel}</div>
  ${estPanel}`;
}

function renderSEO(seo) {
  if (!seo?.length) return "";
  const host = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };
  const chip = (ok, label, warn) => `<span class="seochip ${ok ? "y" : warn ? "w" : "n"}">${ok ? "✓" : "✗"} ${label}</span>`;
  const avg = Math.round(seo.filter((s) => s.up).reduce((a, s) => a + s.score.n, 0) / Math.max(1, seo.filter((s) => s.up).length));
  const rows = seo.slice().sort((a, b) => (b.up - a.up) || (b.score.n - a.score.n)).map((s) => {
    if (!s.up) return `<div class="seo"><div class="seo-h"><b>${esc(host(s.url))}</b><span class="pill crit">unreachable</span></div></div>`;
    const grade = s.score.n >= 9 ? "y" : s.score.n >= 6 ? "w" : "n";
    return `<div class="seo">
      <div class="seo-h">
        <b>${esc(host(s.url))}</b>
        <span class="seo-score ${grade}">${s.score.n}/${s.score.of}</span>
      </div>
      <div class="seo-title">${s.title ? esc(s.title.slice(0, 70)) : '<span class="miss">no &lt;title&gt;</span>'}</div>
      <div class="seo-desc">${s.desc ? esc(s.desc.slice(0, 110)) + (s.desc.length > 110 ? "…" : "") : '<span class="miss">no meta description</span>'}</div>
      <div class="seo-chips">
        ${chip(s.title && s.titleLen <= 65, `title ${s.titleLen}`, s.title)}
        ${chip(s.desc && s.descLen >= 50 && s.descLen <= 165, `desc ${s.descLen}`, s.desc)}
        ${chip(s.h1, "H1")}${chip(s.canonical, "canonical")}${chip(s.indexable, "indexable")}
        ${chip(s.og, "OG tags")}${chip(s.viewport, "mobile")}${chip(s.lang, "lang")}
        ${chip(s.favicon, "favicon")}${chip(s.robotsTxt, "robots.txt")}${chip(s.sitemap, "sitemap")}${chip(s.jsonld, "schema")}
      </div>
    </div>`;
  }).join("");
  return `
  ${secHead("SEO health", "On-page SEO per live site — titles, meta, sitemaps, indexability.", `live audit · avg ${avg}/11`)}
  <div class="seogrid">${rows}</div>
  <div class="note info" style="margin-top:12px"><span class="ic">i</span><span><b>SEM (paid ads)</b> — Google Ads / Meta Ads spend &amp; performance need those ad-account connectors, which aren't linked here. Add campaign spend to <code>expenses.json</code> to track cost, or connect the ad platforms later for live metrics.</span></div>`;
}

// ── token usage over time: this week + weekly + all-time ─────────────
function renderUsage(claude) {
  if (!claude?.available) return "";
  const T = (n) => (n / 1e9 >= 1 ? (n / 1e9).toFixed(2) + "B" : (n / 1e6).toFixed(0) + "M");
  const usd0 = (n) => "$" + Math.round(n).toLocaleString("en-US");
  // weekly: index 0 = this week … reverse to oldest→newest, drop empty tail
  const weeks = claude.week.map((w, i) => ({ i, ...w })).filter((w) => w.tok > 0).reverse();
  const maxW = Math.max(1, ...weeks.map((w) => w.tok));
  const weekBars = weeks.map((w) => {
    const label = w.i === 0 ? "now" : w.i + "w";
    return `<div class="ubar" title="${T(w.tok)} tok · ${usd0(w.cost)}">
      <div class="ucol"><div class="ufill" style="height:${Math.max(3, (w.tok / maxW) * 100).toFixed(1)}%"></div></div>
      <div class="ulab">${label}</div></div>`;
  }).join("");
  const months = Object.keys(claude.byMonth).sort();
  const maxM = Math.max(1, ...months.map((m) => claude.byMonth[m].tok));
  const monthBars = months.map((m) => {
    const mm = claude.byMonth[m]; const lab = new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "short" });
    return `<div class="ubar" title="${T(mm.tok)} tok · ${usd0(mm.cost)}">
      <div class="ucol"><div class="ufill alt" style="height:${Math.max(3, (mm.tok / maxM) * 100).toFixed(1)}%"></div></div>
      <div class="ulab">${lab}</div></div>`;
  }).join("");
  return `
  ${secHead("Token usage over time", "How much you've run through Claude Code — this week and all-time.", "list-price value in tooltips")}
  <div class="spend">
    <div class="panel">
      <div class="spend-head">
        <div><div class="k-label">This week</div><div class="big">${T(claude.thisWeek.tok)}<span style="font-size:14px;color:var(--muted)"> tok</span></div></div>
        <div><div class="k-label">All time</div><div class="big">${T(claude.tokens)}</div></div>
        <div class="spend-note">${claude.msgs.toLocaleString()} messages across ${claude.sessions} sessions</div>
      </div>
      <div class="k-label" style="margin-bottom:6px">Weekly (last 12 weeks)</div>
      <div class="uchart">${weekBars || '<span class="pc-line dim">no recent activity</span>'}</div>
    </div>
    <div class="panel">
      <div class="k-label" style="margin-bottom:6px">Monthly (whole time)</div>
      <div class="uchart">${monthBars}</div>
    </div>
  </div>`;
}

// ── per-app token usage (from Claude Code project logs) ──────────────
function renderAppUsage(claude) {
  if (!claude?.available || !claude.projects?.length) return "";
  const T = (n) => (n / 1e9 >= 1 ? (n / 1e9).toFixed(2) + "B" : (n / 1e6).toFixed(0) + "M");
  const usd0 = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const max = Math.max(1, ...claude.projects.map((p) => p.cost));
  const rows = claude.projects.map((p) => `
    <div class="xrow">
      <div class="xname">${esc(p.name)} <span>${p.msgs.toLocaleString()} msgs</span></div>
      <div class="xbar"><div class="xfill" style="width:${((p.cost / max) * 100).toFixed(1)}%"></div></div>
      <div class="xval">${T(p.tok)}<span class="dim"> · ${usd0(p.cost)}</span></div>
    </div>`).join("");
  return `
  ${secHead("Usage by app", "Which projects consumed the most Claude Code work.", "from our build sessions")}
  <div class="panel"><div class="xchart">${rows}</div>
    <div class="pc-line dim" style="margin-top:10px">Tokens &amp; list-price value of Claude Code work per project. "General (mixed)" = sessions run from a parent folder spanning several apps.</div>
  </div>`;
}

// ── external tool credits (Hunter, Resend, + keys present) ───────────
function renderTools(hunt, rs, expenses) {
  const bar2 = (used, avail) => { const p = avail ? Math.min(100, (used / avail) * 100) : 0; const t = p >= 90 ? "crit" : p >= 75 ? "warn" : "good"; return `<div class="bar ${t}"><span style="width:${p.toFixed(1)}%"></span></div>`; };
  const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
  const hunterCard = hunt?.connected ? `
    <div class="pcard">
      <div class="pc-head"><div class="svc"><div class="glyph" style="background:#ff5a3c">Hu</div><div><div class="p-name">Hunter.io</div><div class="p-kind">Email finder</div></div></div><span class="pill ok">Live</span></div>
      <div class="pc-body">
        <div class="pc-plan">${esc(hunt.plan || "")} · resets ${esc(hunt.reset || "")}</div>
        <div class="m-wide"><div class="m-top"><span>Searches</span><b>${num(hunt.searches?.used)} / ${num(hunt.searches?.available)}</b></div>${bar2(hunt.searches?.used, hunt.searches?.available)}</div>
        <div class="m-wide" style="margin-top:8px"><div class="m-top"><span>Verifications</span><b>${num(hunt.verifications?.used)} / ${num(hunt.verifications?.available)}</b></div>${bar2(hunt.verifications?.used, hunt.verifications?.available)}</div>
      </div>
    </div>` : `
    <div class="pcard muted"><div class="pc-head"><div class="svc"><div class="glyph" style="background:#ff5a3c">Hu</div><div><div class="p-name">Hunter.io</div><div class="p-kind">Email finder</div></div></div><span class="pill idle">${hunt?.error ? esc(hunt.error) : "No key"}</span></div></div>`;
  const resendCard = rs?.connected ? `
    <div class="pcard">
      <div class="pc-head"><div class="svc"><div class="glyph" style="background:#5b5bd6">Rs</div><div><div class="p-name">Resend</div><div class="p-kind">Email API</div></div></div><span class="pill ok">Live</span></div>
      <div class="pc-body"><div class="pc-line">${rs.domains?.length ?? 0} domains · ${rs.verified ?? 0} verified</div>
        ${(rs.domains || []).map((d) => `<div class="pc-line dim">${esc(d.name)} — ${esc(d.status)}</div>`).join("")}</div>
    </div>` : `
    <div class="pcard muted"><div class="pc-head"><div class="svc"><div class="glyph" style="background:#5b5bd6">Rs</div><div><div class="p-name">Resend</div><div class="p-kind">Email API</div></div></div><span class="pill idle">${rs?.error ? esc(rs.error) : "No key"}</span></div></div>`;
  // other keys present but no live usage endpoint
  const others = [];
  if (env.OPENAI_API_KEY) others.push("OpenAI");
  if (env.GEMINI_API_KEY) others.push("Gemini");
  const otherCard = others.length ? `
    <div class="pcard muted"><div class="pc-head"><div class="svc"><div class="glyph" style="background:#10a37f">Ai</div><div><div class="p-name">${esc(others.join(" · "))}</div><div class="p-kind">LLM keys</div></div></div><span class="pill idle">key present</span></div>
      <div class="pc-body"><div class="pc-line dim">No usage API — check each provider's console for spend.</div></div></div>` : "";
  return `
  ${secHead("Tools & credits", "Live credit balances for the external APIs your apps use.", "live where the API allows")}
  <div class="pcards">${hunterCard}${resendCard}${otherCard}</div>`;
}

// section heading with a one-line description underneath
function secHead(title, desc, count) {
  return `<div class="section-label"><h2>${esc(title)}</h2><div class="rule"></div>${count ? `<span class="count">${esc(count)}</span>` : ""}</div>${desc ? `<p class="sec-desc">${esc(desc)}</p>` : ""}`;
}

// ── health signals → traffic lights + action items ──────────────────
function computeSignals({ nf, sb, seo, apps, expenses, dashPath }) {
  const sig = []; const add = (sev, system, msg, action = "", path = "") => sig.push({ sev, system, msg, action, path });
  add("green", "Dashboard", "HTTPS enforced · encrypted gate");
  if (nf?.connected) { const down = (nf.sites || []).filter((s) => !(s.state === "ready" || s.state === "current")).length;
    add(down ? "amber" : "green", "Netlify", down ? `${down} site not ready` : `${nf.sites?.length || 0} sites live`, down ? "Check failing deploys" : "");
  } else add("amber", "Netlify", "not connected", "Add NETLIFY_TOKEN");
  const sbApps = apps.filter((a) => a.supabase); const dead = sbApps.filter((a) => a.supabaseAlive === false);
  add(dead.length ? "red" : "green", "Supabase", dead.length ? `${dead.length} project unreachable` : `${sbApps.length} projects healthy`, dead.length ? "Investigate the dead project" : "");
  const appType = apps.filter((a) => a.type === "app"); const noGA = appType.filter((a) => a.analytics?.kind !== "ga4");
  add(noGA.length ? "amber" : "green", "Analytics", noGA.length ? `${noGA.length}/${appType.length} apps without GA4` : "all apps on GA4", noGA.length ? "Add GA4 to " + noGA.map((a) => a.label).join(", ") : "");
  if (apps.some((a) => a.integrations?.some((i) => i.service === "Google Maps"))) add("amber", "Google Maps", "key may be unrestricted", "Lock the Maps key to *.curiousbrand.co.uk in Google Cloud Console");
  if (expenses?.anthropicConsole?.autoReload === false) add("amber", "Anthropic API", "auto-reload OFF", "Turn on auto-reload so credits can't hit $0 mid-session");
  const noRemote = apps.filter((a) => a.noRemote);
  add(noRemote.length ? "amber" : "green", "Backups", noRemote.length ? `${noRemote.length} app not on GitHub` : "all apps backed up", noRemote.length ? "Push " + noRemote.map((a) => a.label).join(", ") : "");
  if (seo?.length) { const up = seo.filter((s) => s.up); const avg = Math.round(up.reduce((a, s) => a + s.score.n, 0) / Math.max(1, up.length));
    add(avg < 7 ? "amber" : "green", "SEO", `avg ${avg}/11 across sites`, avg < 7 ? "Improve titles, meta descriptions, sitemaps" : ""); }
  const chest = apps.find((a) => (a.integrations || []).filter((i) => i.category === "ai").length >= 2);
  if (chest) add("amber", "Secrets", `${chest.label} .env holds many live keys`, "It's gitignored — keep it that way; consider rotating if ever shared");
  // verified per-app issues from the deep audit (apps-meta.json) — these carry a project path → fix button
  for (const a of apps) for (const iss of (a.issues || [])) add(iss.sev, a.label, iss.title, iss.action || "", a.path || "");
  return sig;
}
function sevRank(s) { return ({ red: 0, amber: 1, green: 2 })[s] ?? 3; }

function renderLights(sig) {
  const order = sig.slice().sort((a, b) => sevRank(a.sev) - sevRank(b.sev));
  const reds = sig.filter((s) => s.sev === "red").length, ambers = sig.filter((s) => s.sev === "amber").length;
  const head = reds ? `${reds} need attention` : ambers ? `${ambers} to check` : "all systems healthy";
  return `
  ${secHead("System health", "Traffic lights across every system. Red = act now, amber = worth a look, green = healthy.", head)}
  <div class="lights">${order.map((s) => `
    <div class="light ${s.sev}">
      <div class="lamp"></div>
      <div><div class="l-sys">${esc(s.system)}</div><div class="l-msg">${esc(s.msg)}</div></div>
    </div>`).join("")}</div>`;
}

function renderActions(sig) {
  const items = sig.filter((s) => s.sev !== "green" && s.action).sort((a, b) => sevRank(a.sev) - sevRank(b.sev));
  const desc = "Everything flagged amber or red, most urgent first. Hit “Fix in Claude Code” to open that project here with the fix already typed in.";
  if (!items.length) return `
  ${secHead("To check & act on", desc)}
  <div class="panel"><div class="pc-line">Nothing needs action — all green. 🎉</div></div>`;
  return `
  ${secHead("To check & act on", desc, `${items.length} item${items.length > 1 ? "s" : ""}`)}
  <div class="acts">${items.map((s) => {
    const prompt = `Fix this issue in ${s.system}: ${s.msg}. ${s.action}`.replace(/\s+/g, " ").trim();
    const href = s.path ? `claude-cli://open?cwd=${encodeURIComponent(s.path)}&q=${encodeURIComponent(prompt)}` : "";
    return `
    <div class="act ${s.sev}">
      <div class="act-dot"></div>
      <div class="act-body"><div class="act-t">${esc(s.system)} — ${esc(s.msg)}</div><div class="act-a">${esc(s.action)}</div></div>
      ${href ? `<a class="fixbtn" href="${esc(href)}" title="Opens Claude Code in this project with the fix pre-filled">⚡ Fix in Claude Code</a>` : `<span class="fixbtn na" title="No single project to open">manual</span>`}
    </div>`;
  }).join("")}</div>`;
}

function catColor(c) { return ({ database: "#3ecf8e", payments: "#635bff", email: "#5b5bd6", maps: "#ea4335", ai: "#10a37f", analytics: "#e0a93f", enrichment: "#ff5a3c", backend: "#00c7b7", webhook: "#8a9ba8", sms: "#25d366", other: "#8a9ba8" })[c] || "#8a9ba8"; }
function intBadges(ints) {
  if (!ints?.length) return `<span class="intb none">no integrations</span>`;
  return ints.map((i) => `<span class="intb" style="--c:${catColor(i.category)}">${esc(i.service)}</span>`).join("");
}

function renderDatabases(apps, sb, nf) {
  const dbApps = apps.filter((a) => a.supabase && a.supabaseRefs?.length);
  const rows = dbApps.map((a) => `
    <div class="dbrow">
      <div class="db-app"><b>${esc(a.label)}</b><span>${esc(a.supabaseRefs[0])}</span></div>
      ${a.supabaseAlive === true ? '<span class="pill ok">reachable</span>' : a.supabaseAlive === false ? '<span class="pill crit">unreachable</span>' : '<span class="pill idle">—</span>'}
    </div>`).join("");
  const projects = new Set(dbApps.flatMap((a) => a.supabaseRefs)).size;
  return `
  ${secHead("Databases & hosting", "Where your app data lives (Supabase) and what serves your sites (Netlify).", `${projects} Supabase · Netlify`)}
  <div class="spend">
    <div class="panel">
      <div class="k-label" style="margin-bottom:10px">Supabase projects (live ping)</div>
      ${rows || '<div class="pc-line dim">none</div>'}
    </div>
    <div class="panel">
      <div class="k-label" style="margin-bottom:10px">Netlify hosting</div>
      <div class="pc-line">${nf?.connected ? `${nf.sites?.length || 0} sites · ${nf.upCount || 0} live` : "not connected"}</div>
      <div class="pc-line dim">${nf?.bandwidth ? `${(nf.bandwidth.usedGB || 0).toFixed(1)} GB bandwidth used` : ""}</div>
      <div class="pc-line dim" style="margin-top:6px">Supabase = your app databases. Each app has its own project.</div>
    </div>
  </div>`;
}

function renderProjectCards(apps, type, title, count) {
  const list = apps.filter((a) => a.type === type);
  if (!list.length) return "";
  const cards = list.map((a) => `
    <div class="proj">
      <div class="proj-h">
        <div><div class="proj-name">${esc(a.label)}</div>${a.url ? `<a class="proj-url" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url.replace(/^https?:\/\//, ""))}</a>` : `<div class="proj-url dim">${esc(a.repo || "local only")}</div>`}</div>
        <span class="pill ${a.thirdParty ? "idle" : "ok"}">${a.thirdParty ? "external" : a.deploy || "local"}</span>
      </div>
      ${a.purpose ? `<div class="proj-purpose">${esc(a.purpose)}</div>` : ""}
      <div class="proj-ints">${intBadges(a.integrations)}</div>
    </div>`).join("");
  return `
  ${secHead(title, count || "", `${list.length}`)}
  <div class="projgrid">${cards}</div>`;
}

function renderPayments(expenses, now) {
  const cur = expenses.currency || "USD";
  const svcs = (expenses.services || []);
  const money2 = (v) => (numv(v) == null ? "—" : (cur === "GBP" ? "£" : "$") + Number(v).toLocaleString("en-GB", { maximumFractionDigits: 0 }));
  const rows = svcs.map((s) => {
    const last = s.lastPaid ? new Date(s.lastPaid + "T00:00:00") : null;
    const lastStr = last && !isNaN(last) ? last.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    return `<tr>
      <td class="pt-name">${esc(s.name)}${s.plan ? ` <span>${esc(s.plan)}</span>` : ""}</td>
      <td class="pt-cost">${money2(s.cost)}${s.cost != null ? `<small>/${s.cycle === "yearly" ? "yr" : "mo"}</small>` : ""}</td>
      <td class="pt-date">${lastStr}</td>
      <td class="pt-next">${s.renews || "—"}</td>
    </tr>`;
  }).join("");
  const monthly = svcs.reduce((a, s) => a + (numv(s.cost) == null ? 0 : (s.cycle === "yearly" ? s.cost / 12 : s.cost)), 0);
  const anyCost = svcs.some((s) => numv(s.cost) != null);
  return `
  ${secHead("Payments", "What each tool costs, when you last paid, and when the next charge lands.", anyCost ? money2(Math.round(monthly)) + "/mo total" : "add costs")}
  <div class="panel" style="overflow-x:auto">
    <table class="ptable">
      <thead><tr><th>Tool</th><th>Cost</th><th>Last paid</th><th>Next / resets</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="pc-line dim" style="margin-top:10px">Fill missing costs &amp; last-paid dates in expenses.json. Amounts I can't read from an API stay blank rather than guessed.</div>
  </div>`;
}

function renderHTML({ scan, nf, sb, rs, hunt, cfg, expenses, claude, seo, now }) {
  const c = { netlify: cfg.netlify || {}, supabase: cfg.supabase || {}, resend: cfg.resend || {} };
  const apps = scan.apps;
  const withSb = apps.filter((a) => a.supabase);
  const distinctProjects = new Set(withSb.flatMap((a) => a.supabaseRefs)).size;
  const netlifyCount = apps.filter((a) => a.deploy === "Netlify").length;
  const vercelCount = apps.filter((a) => a.deploy === "Vercel").length;
  const conflicts = apps.filter((a) => a.supabaseConflict);
  const signals = computeSignals({ nf, sb, seo, apps, expenses });
  const appList = apps.filter((a) => a.type === "app");
  const siteList = apps.filter((a) => a.type === "website");
  const liveApps = appList.filter((a) => a.url || (a.deploy && a.deploy !== "git → ?")).length;
  const dbCount = new Set(apps.filter((a) => a.supabase).flatMap((a) => a.supabaseRefs)).size;
  const monthlySpend = (expenses.services || []).reduce((s, x) => s + (numv(x.cost) == null ? 0 : (x.cycle === "yearly" ? x.cost / 12 : x.cost)), 0);
  const anySpend = (expenses.services || []).some((x) => numv(x.cost) != null);
  const curSym = expenses.currency === "GBP" ? "£" : "$";
  const redCount = signals.filter((s) => s.sev === "red").length;

  // ── APP ROWS ──
  const appRows = apps.map((a) => {
    const stack = [];
    if (a.supabase) {
      stack.push(htag("sb", a.supabaseRefs[0] ? `Supabase · ${a.supabaseRefs[0].slice(0, 8)}…` : "Supabase"));
      if (a.supabaseAlive === true) stack.push(htag("live", "● reachable"));
      else if (a.supabaseAlive === false) stack.push(htag("dead", "● unreachable"));
    } else stack.push(htag("none", "No backend"));
    if (a.deploy === "Netlify") stack.push(htag("nf", a.netlifySiteId ? "Netlify · linked" : "Netlify"));
    else if (a.deploy === "Vercel") stack.push(htag("vc", "Vercel"));
    else if (a.deploy === "git → ?") stack.push(htag("none", "Deploy: unknown"));
    else stack.push(htag("none", "No deploy cfg"));
    if (a.resend) stack.push(htag("rs", "Resend"));
    if (a.stripe) stack.push(htag("st", "Stripe"));
    // GA4
    if (a.analytics?.kind === "ga4") stack.push(htag("live", "GA4 ✓"));
    else if (a.analytics?.kind === "placeholder") stack.push(htag("ext", "GA4 placeholder"));
    else if (a.analytics?.kind === "plausible") stack.push(htag("sb", "Plausible"));
    else stack.push(htag("dead", "No GA4"));
    // git backup
    if (a.noRemote) stack.push(htag("dead", "⚠ not on GitHub"));
    if (a.thirdParty) stack.push(htag("ext", "Third-party clone"));
    return `<div class="app ${a.supabase ? "" : "muted"}">
      <div class="app-id">
        <div class="app-dot ${a.supabase ? "on" : "off"}"></div>
        <div><div class="app-name">${esc(a.name)}</div><div class="app-kind">${esc(a.kind)}${a.repo ? ` · ${esc(a.repo)}` : " · no git"}</div></div>
      </div>
      <div class="app-stack">${stack.join("")}</div>
      ${a.supabaseConflict ? `<div class="app-flag" title="Multiple Supabase URLs in .env">⚠ ${a.supabaseRefs.length} Supabase URLs — likely stale config</div>` : ""}
    </div>`;
  }).join("");

  // ── PLATFORM CARDS (live) ──
  const platStatus = (r) => r.connected ? `<span class="pill ok">Live</span>` : r.error ? `<span class="pill crit">${esc(r.error)}</span>` : `<span class="pill idle">No token</span>`;
  const nfBwPct = pct(nf.bandwidth?.usedGB, nf.bandwidth?.includedGB ?? c.netlify.bandwidthLimitGB);
  const platforms = [
    { key: "Nf", color: "#00c7b7", name: "Netlify", kind: "Hosting", r: nf,
      lines: nf.connected ? [`${nf.sites?.length ?? 0} sites · ${nf.upCount ?? 0} live`, nf.bandwidth ? (nf.bandwidth.includedGB ? `${gb(nf.bandwidth.usedGB)} / ${gb(nf.bandwidth.includedGB)} GB bandwidth` : `${gb(nf.bandwidth.usedGB)} GB bandwidth used`) : ""] : [],
      cost: c.netlify, bar: nf.connected ? nfBwPct : null },
    { key: "Sb", color: "#3ecf8e", name: "Supabase", kind: "Backend / DB", r: sb,
      lines: sb.connected ? [`${sb.projects?.length ?? 0} projects · ${sb.healthy ?? 0} healthy`] : [], cost: c.supabase, bar: null },
    { key: "Rs", color: "#5b5bd6", name: "Resend", kind: "Email", r: rs,
      lines: rs.connected ? [`${rs.domains?.length ?? 0} domains · ${rs.verified ?? 0} verified`] : [], cost: c.resend, bar: null },
  ].map((p) => `<div class="pcard ${p.r.connected ? "" : "muted"}">
      <div class="pc-head"><div class="svc"><div class="glyph" style="background:${p.color}">${p.key}</div>
        <div><div class="p-name">${p.name}</div><div class="p-kind">${p.kind}</div></div></div>${platStatus(p.r)}</div>
      <div class="pc-body">
        ${p.cost.plan ? `<div class="pc-plan">${esc(p.cost.plan)}${p.cost.monthlyCost != null ? " · " + money(p.cost.monthlyCost, p.cost.currency) + "/mo" : ""}</div>` : ""}
        ${p.r.connected ? p.lines.filter(Boolean).map((l) => `<div class="pc-line">${esc(l)}</div>`).join("") : `<div class="pc-line dim">${p.r.error ? "Check token in .env" : "Add token to .env for live data"}</div>`}
        ${p.bar != null ? bar(p.bar) : ""}
      </div></div>`).join("");

  const stamp = now.toLocaleString("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const monthlyCost = [nf, sb, rs].reduce((sum, r, i) => sum + (r.connected ? (numv([c.netlify, c.supabase, c.resend][i].monthlyCost) || 0) : 0), 0);
  const anyCost = [c.netlify, c.supabase, c.resend].some((x) => numv(x.monthlyCost) != null);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Curious Ops</title><style>${CSS()}</style></head>
<body><div class="wrap">
  <header class="top">
    <div class="brand"><div class="dot ${redCount ? "red" : ""}"></div>
      <div><h1>Curious Ops</h1><div class="sub">apps · databases · websites · spend · health</div></div></div>
    <div class="snapshot"><div class="live">Live</div><div><b>${esc(stamp)}</b></div><div>${apps.length} projects tracked</div></div>
  </header>

  ${renderLights(signals)}

  ${secHead("At a glance", "Your whole operation in four numbers.")}
  <div class="kpis">
    <div class="kpi"><div class="k-label">Live apps</div><div class="k-value">${liveApps}<span class="cur"> / ${appList.length}</span></div>
      <div class="k-meta">interactive tools</div></div>
    <div class="kpi"><div class="k-label">Databases</div><div class="k-value">${dbCount}</div>
      <div class="k-meta">Supabase projects</div></div>
    <div class="kpi"><div class="k-label">Websites</div><div class="k-value">${siteList.length}</div>
      <div class="k-meta">brand / marketing</div></div>
    <div class="kpi"><div class="k-label">Monthly spend</div><div class="k-value">${anySpend ? curSym + Math.round(monthlySpend).toLocaleString() : "—"}</div>
      <div class="k-meta">${anySpend ? "across your tools" : "add costs to expenses.json"}</div></div>
  </div>

  ${renderDatabases(apps, sb, nf)}

  ${renderProjectCards(apps, "app", "Apps", "interactive tools + what each connects to")}

  ${renderProjectCards(apps, "website", "Websites", "brand / marketing sites")}

  ${renderPayments(expenses, now)}

  ${renderActions(signals)}

  ${renderClaude(claude, expenses.anthropicConsole, expenses.claudeMax)}

  ${renderUsage(claude)}

  ${renderAppUsage(claude)}

  ${renderTools(hunt, rs, expenses)}

  ${renderSEO(seo)}

  <footer><span>Curious Ops · auto-refreshes daily · status.curiousbrand.co.uk</span><span>${esc(stamp)}</span></footer>
</div></body></html>`;
}

function CSS() { return `
:root{--bg:#f4f6f7;--surface:#fff;--surface-2:#eef1f3;--border:#dbe2e7;--text:#17222c;--muted:#5b6b78;--faint:#8494a0;--accent:#0d8aad;--good:#1c8a5a;--good-soft:rgba(28,138,90,.12);--warn:#b5771a;--warn-soft:rgba(181,119,26,.14);--crit:#c0483a;--crit-soft:rgba(192,72,58,.12);--sb:#3ecf8e;--sb-soft:rgba(62,207,142,.14);--nf:#00a19a;--nf-soft:rgba(0,161,154,.13);--vc-soft:rgba(90,90,110,.14);--mono:ui-monospace,"SF Mono","Menlo","Consolas",monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--shadow:0 1px 2px rgba(23,34,44,.04),0 4px 16px rgba(23,34,44,.05)}
@media(prefers-color-scheme:dark){:root{--bg:#0d1318;--surface:#151e26;--surface-2:#1b262f;--border:#26333d;--text:#e6edf2;--muted:#93a3b0;--faint:#6b7c88;--accent:#4cc2e0;--good:#45c489;--good-soft:rgba(69,196,137,.14);--warn:#e0a93f;--warn-soft:rgba(224,169,63,.15);--crit:#e5695a;--crit-soft:rgba(229,105,90,.14);--sb:#3ecf8e;--sb-soft:rgba(62,207,142,.16);--nf:#2dd4c0;--nf-soft:rgba(45,212,192,.15);--vc-soft:rgba(150,160,180,.16);--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.28)}}
:root[data-theme="light"]{--bg:#f4f6f7;--surface:#fff;--surface-2:#eef1f3;--border:#dbe2e7;--text:#17222c;--muted:#5b6b78;--faint:#8494a0;--good:#1c8a5a;--good-soft:rgba(28,138,90,.12);--warn:#b5771a;--warn-soft:rgba(181,119,26,.14);--crit:#c0483a;--crit-soft:rgba(192,72,58,.12);--sb:#3ecf8e;--sb-soft:rgba(62,207,142,.14);--nf:#00a19a;--nf-soft:rgba(0,161,154,.13);--vc-soft:rgba(90,90,110,.14)}
:root[data-theme="dark"]{--bg:#0d1318;--surface:#151e26;--surface-2:#1b262f;--border:#26333d;--text:#e6edf2;--muted:#93a3b0;--faint:#6b7c88;--good:#45c489;--good-soft:rgba(69,196,137,.14);--warn:#e0a93f;--warn-soft:rgba(224,169,63,.15);--crit:#e5695a;--crit-soft:rgba(229,105,90,.14);--sb:#3ecf8e;--sb-soft:rgba(62,207,142,.16);--nf:#2dd4c0;--nf-soft:rgba(45,212,192,.15);--vc-soft:rgba(150,160,180,.16)}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto;padding:28px 24px 64px}
.top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;padding-bottom:20px;margin-bottom:22px;border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:12px}
.brand .dot{width:11px;height:11px;border-radius:50%;background:var(--good);box-shadow:0 0 0 4px var(--good-soft);flex:none}
.brand h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}
.brand .sub{font-family:var(--mono);font-size:11px;letter-spacing:.03em;color:var(--faint);margin-top:2px}
.snapshot{text-align:right;font-family:var(--mono);font-size:12px;color:var(--muted)}
.snapshot b{color:var(--text);font-weight:600}
.snapshot .live{display:inline-flex;align-items:center;gap:6px;color:var(--good);font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.snapshot .live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--good)}
.wrap{max-width:1040px}
.section-label{display:flex;align-items:baseline;gap:12px;margin:52px 0 18px}
.section-label h2{margin:0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
.section-label .rule{flex:1;height:1px;background:var(--border)}
.section-label .count{font-family:var(--mono);font-size:12px;color:var(--faint)}
.brand .dot.red{background:var(--crit);box-shadow:0 0 0 4px var(--crit-soft)}
/* system health lights */
.lights{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.light{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:13px 15px;box-shadow:var(--shadow)}
.light .lamp{width:14px;height:14px;border-radius:50%;flex:none;position:relative}
.light.green .lamp{background:var(--good);box-shadow:0 0 0 4px var(--good-soft),0 0 10px var(--good)}
.light.amber .lamp{background:var(--warn);box-shadow:0 0 0 4px var(--warn-soft),0 0 10px var(--warn)}
.light.red .lamp{background:var(--crit);box-shadow:0 0 0 4px var(--crit-soft),0 0 12px var(--crit);animation:blink 1.4s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.45}}
@media(prefers-reduced-motion:reduce){.light.red .lamp{animation:none}}
.l-sys{font-size:13.5px;font-weight:650;letter-spacing:-.005em}
.l-msg{font-size:11.5px;color:var(--muted);margin-top:1px}
/* action items */
.acts{display:flex;flex-direction:column;gap:10px}
.act{display:flex;gap:12px;background:var(--surface);border:1px solid var(--border);border-left-width:3px;border-radius:10px;padding:13px 15px;box-shadow:var(--shadow)}
.act.red{border-left-color:var(--crit)}.act.amber{border-left-color:var(--warn)}
.act-dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:5px}
.act.red .act-dot{background:var(--crit)}.act.amber .act-dot{background:var(--warn)}
.act-body{flex:1;min-width:0}
.act-t{font-size:13.5px;font-weight:600}
.act-a{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.5}
.sec-desc{margin:-10px 0 18px;font-size:13px;color:var(--muted);line-height:1.55;max-width:72ch}
.fixbtn{align-self:center;flex:none;font-family:var(--sans);font-size:12px;font-weight:600;text-decoration:none;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--accent) 32%,transparent);border-radius:8px;padding:7px 12px;white-space:nowrap;cursor:pointer;transition:background .15s}
.fixbtn:hover{background:color-mix(in srgb,var(--accent) 20%,transparent)}
.fixbtn.na{color:var(--faint);background:var(--surface-2);border-color:var(--border);cursor:default;font-weight:400}
/* project cards (apps / websites) */
.projgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.proj{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 17px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:10px}
.proj-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.proj-name{font-weight:650;font-size:15.5px;letter-spacing:-.005em}
.proj-url{font-size:11.5px;font-family:var(--mono);color:var(--accent);text-decoration:none}
.proj-url:hover{text-decoration:underline}
.proj-url.dim{color:var(--faint)}
.proj-purpose{font-size:12.5px;color:var(--muted);line-height:1.5}
.proj-ints{display:flex;flex-wrap:wrap;gap:5px;padding-top:4px;border-top:1px dashed var(--border)}
.intb{font-family:var(--mono);font-size:10.5px;padding:2px 8px;border-radius:6px;white-space:nowrap;color:var(--c,var(--muted));background:color-mix(in srgb,var(--c,var(--faint)) 14%,transparent);border:1px solid color-mix(in srgb,var(--c,var(--faint)) 30%,transparent)}
.intb.none{color:var(--faint);background:var(--surface-2);border-color:var(--border)}
/* databases */
.dbrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px dashed var(--border)}
.dbrow:last-child{border-bottom:none}
.db-app{display:flex;flex-direction:column;gap:1px;min-width:0}
.db-app b{font-size:13.5px}.db-app span{font-size:11px;font-family:var(--mono);color:var(--faint)}
/* payments table */
.ptable{width:100%;border-collapse:collapse;font-size:13px}
.ptable th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:600;padding:0 10px 10px;border-bottom:1px solid var(--border)}
.ptable td{padding:11px 10px;border-bottom:1px solid var(--border)}
.ptable tr:last-child td{border-bottom:none}
.pt-name{font-weight:600}.pt-name span{font-family:var(--mono);font-size:11px;color:var(--faint);font-weight:400}
.pt-cost{font-family:var(--mono);font-variant-numeric:tabular-nums}.pt-cost small{color:var(--faint)}
.pt-date,.pt-next{font-family:var(--mono);font-size:12px;color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;box-shadow:var(--shadow)}
.k-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}
.k-value{font-family:var(--mono);font-size:26px;font-weight:600;letter-spacing:-.01em;margin-top:8px;font-variant-numeric:tabular-nums}
.k-value .cur{font-size:14px;color:var(--muted);font-weight:500}
.k-value.warnnum{color:var(--warn)}
.k-meta{font-size:12px;color:var(--muted);margin-top:4px}
.spark{margin-top:10px}
.bar{height:6px;border-radius:4px;background:var(--surface-2);overflow:hidden;margin-top:8px}
.bar>span{display:block;height:100%;border-radius:4px;background:var(--accent)}
.bar.good>span{background:var(--good)}.bar.warn>span{background:var(--warn)}.bar.crit>span{background:var(--crit)}
.apps{display:flex;flex-direction:column;gap:10px}
.app{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:14px 16px;display:grid;grid-template-columns:minmax(180px,1fr) auto;align-items:center;gap:12px}
.app.muted{opacity:.9}
.app-id{display:flex;align-items:center;gap:11px;min-width:0}
.app-dot{width:9px;height:9px;border-radius:50%;flex:none}
.app-dot.on{background:var(--sb);box-shadow:0 0 0 4px var(--sb-soft)}
.app-dot.off{background:var(--faint);box-shadow:0 0 0 4px var(--surface-2)}
.app-name{font-weight:650;font-size:15px;letter-spacing:-.005em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.app-kind{font-size:11.5px;color:var(--faint);font-family:var(--mono);text-transform:uppercase;letter-spacing:.04em}
.app-stack{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.app-flag{grid-column:1 / -1;font-size:12px;color:var(--warn);background:var(--warn-soft);padding:6px 10px;border-radius:8px;font-family:var(--mono)}
.tag{font-family:var(--mono);font-size:11px;font-weight:600;padding:3px 9px;border-radius:7px;white-space:nowrap;letter-spacing:.01em}
.tag.sb{color:#0a7a4d;background:var(--sb-soft)}
.tag.nf{color:var(--nf);background:var(--nf-soft)}
.tag.vc{color:var(--text);background:var(--vc-soft)}
.tag.rs{color:#5b5bd6;background:rgba(91,91,214,.13)}
.tag.st{color:#635bff;background:rgba(99,91,255,.13)}
.tag.none{color:var(--faint);background:var(--surface-2)}
.tag.ext{color:var(--warn);background:var(--warn-soft)}
.tag.live{color:var(--good);background:var(--good-soft)}
.tag.dead{color:var(--crit);background:var(--crit-soft)}
@media(prefers-color-scheme:dark){.tag.sb{color:#5fe0a5}}
.note{margin-top:12px;padding:12px 14px;border-radius:10px;background:var(--warn-soft);font-size:12.5px;line-height:1.55;display:flex;gap:10px;align-items:flex-start}
.note .ic{color:var(--warn);font-weight:700;flex:none}
.note code{background:rgba(0,0,0,.08);padding:1px 5px;border-radius:4px;font-family:var(--mono)}
.pcards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.pcard{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:15px 16px}
.pcard.muted{opacity:.82}
.pc-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.svc{display:flex;align-items:center;gap:10px}
.glyph{width:30px;height:30px;border-radius:8px;flex:none;display:grid;place-items:center;font-family:var(--mono);font-weight:700;font-size:13px;color:#08221e}
.p-name{font-weight:650;font-size:14.5px}.p-kind{font-size:11px;color:var(--faint)}
.pc-body{margin-top:12px;display:flex;flex-direction:column;gap:6px}
.pc-plan{font-family:var(--mono);font-size:12px;color:var(--muted);font-weight:600}
.pc-line{font-family:var(--mono);font-size:12.5px;color:var(--text);font-variant-numeric:tabular-nums}
.pc-line.dim{color:var(--faint)}
.pill{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:999px;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ok{color:var(--good);background:var(--good-soft)}.pill.crit{color:var(--crit);background:var(--crit-soft)}.pill.idle{color:var(--faint);background:var(--surface-2)}
.spend{display:grid;grid-template-columns:1.6fr 1fr;gap:14px}
.spend-head{display:flex;align-items:flex-end;gap:24px;flex-wrap:wrap;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border)}
.big{font-family:var(--mono);font-size:26px;font-weight:600;letter-spacing:-.01em;margin-top:4px;font-variant-numeric:tabular-nums}
.pc-line b{font-weight:600;font-family:var(--mono)}
span.dim{color:var(--faint);font-size:11px}
.spend-note{font-size:11.5px;color:var(--faint);margin-left:auto;max-width:180px;text-align:right;line-height:1.4}
.xchart{display:flex;flex-direction:column;gap:9px}
.xrow{display:grid;grid-template-columns:130px 1fr auto;align-items:center;gap:12px}
.xname{font-size:12.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xname span{color:var(--faint);font-size:11px;font-family:var(--mono)}
.xbar{height:14px;background:var(--surface-2);border-radius:5px;overflow:hidden}
.xfill{height:100%;border-radius:5px;background:linear-gradient(90deg,var(--accent),var(--good));min-width:2px}
.xfill.empty{background:repeating-linear-gradient(45deg,var(--surface-2),var(--surface-2) 4px,var(--border) 4px,var(--border) 8px)}
.xval{font-family:var(--mono);font-size:12px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.xval.dim{color:var(--faint);font-weight:400}
.uchart{display:flex;align-items:flex-end;gap:5px;height:96px;overflow-x:auto;padding-top:4px}
.ubar{display:flex;flex-direction:column;align-items:center;gap:5px;flex:1;min-width:20px}
.ucol{width:100%;max-width:26px;height:76px;display:flex;align-items:flex-end}
.ufill{width:100%;border-radius:4px 4px 0 0;background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 55%,transparent));min-height:3px}
.ufill.alt{background:linear-gradient(180deg,var(--good),color-mix(in srgb,var(--good) 55%,transparent))}
.ulab{font-family:var(--mono);font-size:9.5px;color:var(--faint);white-space:nowrap}
.renews{display:flex;flex-direction:column}
.renew{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:9px 0;border-bottom:1px dashed var(--border)}
.renew:last-child{border-bottom:none}
.renew .r-when{font-family:var(--mono);font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--surface-2);color:var(--muted);white-space:nowrap}
.renew.soon .r-when{background:var(--warn-soft);color:var(--warn)}
.renew.over .r-when{background:var(--crit-soft);color:var(--crit)}
.renew .r-name{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.renew .r-date{font-family:var(--mono);font-size:11px;color:var(--faint)}
@media(max-width:800px){.spend{grid-template-columns:1fr}.xrow{grid-template-columns:100px 1fr auto}}
footer{margin-top:34px;padding-top:18px;border-top:1px solid var(--border);font-family:var(--mono);font-size:11.5px;color:var(--faint);display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:space-between}
footer code{background:var(--surface-2);padding:1px 6px;border-radius:5px}
.seogrid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.seo{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:15px 16px}
.seo-h{display:flex;align-items:center;justify-content:space-between;gap:10px}
.seo-h b{font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-score{font-family:var(--mono);font-size:12px;font-weight:700;padding:2px 9px;border-radius:999px}
.seo-score.y{color:var(--good);background:var(--good-soft)}.seo-score.w{color:var(--warn);background:var(--warn-soft)}.seo-score.n{color:var(--crit);background:var(--crit-soft)}
.seo-title{font-size:12.5px;color:var(--text);margin-top:9px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-desc{font-size:11.5px;color:var(--muted);margin-top:3px;line-height:1.4;min-height:16px}
.seo .miss{color:var(--crit);font-style:italic}
.seo-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px}
.seochip{font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:6px;white-space:nowrap;letter-spacing:.01em}
.seochip.y{color:var(--good);background:var(--good-soft)}
.seochip.w{color:var(--warn);background:var(--warn-soft)}
.seochip.n{color:var(--crit);background:var(--crit-soft)}
@media(max-width:800px){.kpis{grid-template-columns:repeat(2,1fr)}.pcards{grid-template-columns:1fr}.app{grid-template-columns:1fr}.app-stack{justify-content:flex-start}.seogrid{grid-template-columns:1fr}}
@media(max-width:520px){.kpis{grid-template-columns:1fr}.snapshot{text-align:left}}
`; }
