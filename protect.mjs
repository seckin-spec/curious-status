#!/usr/bin/env node
// Wraps dashboard.html in an AES-GCM encrypted login gate.
//   node sync.mjs && node protect.mjs   →  dist/index.html (deployable)
//
// The dashboard HTML is encrypted at rest inside dist/index.html. It can only
// be decrypted in-browser with the correct EMAIL + passphrase (both feed the
// key derivation), so "view source" reveals only ciphertext. No backend.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, pbkdf2Sync, createCipheriv } from "node:crypto";

const DIR = dirname(fileURLToPath(import.meta.url));
const ALLOWED_EMAIL = "seckin@curiousbrand.co.uk";
const ITER = 600000; // PBKDF2 iterations — the page is public, so lean hard on the KDF

// ── passphrase: read from local file, or generate a HIGH-ENTROPY one ──
// The encrypted page is served publicly (anyone can grab the ciphertext), so the
// passphrase must survive offline brute-force. ~116 bits from a 56-char alphabet.
const passFile = join(DIR, "GATE-PASSPHRASE.txt");
let passphrase = existsSync(passFile) ? readFileSync(passFile, "utf8").trim() : "";
if (!passphrase) {
  const AB = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/l/I
  const raw = randomBytes(20);
  let s = ""; for (let i = 0; i < 20; i++) s += AB[raw[i] % AB.length];
  passphrase = s.match(/.{1,5}/g).join("-"); // e.g. aB3kd-9mNp2-Rt7vX-2wQ8y
  writeFileSync(passFile, passphrase + "\n");
  console.log("→ generated a strong passphrase, saved to GATE-PASSPHRASE.txt (git-ignored)");
}

// ── encrypt dashboard.html ──
const htmlPath = join(DIR, "dashboard.html");
if (!existsSync(htmlPath)) { console.error("dashboard.html not found — run `node sync.mjs` first."); process.exit(1); }
const payload = readFileSync(htmlPath, "utf8");

const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(`${ALLOWED_EMAIL}:${passphrase}`, salt, ITER, 32, "sha256");
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
const blob = Buffer.concat([ct, cipher.getAuthTag()]).toString("base64"); // WebCrypto expects tag appended
const b64 = (b) => Buffer.from(b).toString("base64");

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Curious Ops · Sign in</title>
<style>
  :root{--bg:#0d1318;--card:#151e26;--bd:#26333d;--tx:#e6edf2;--mut:#93a3b0;--ac:#4cc2e0;--er:#e5695a;--mono:ui-monospace,"SF Mono",Menlo,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  *{box-sizing:border-box}html,body{margin:0;height:100%}
  body{background:radial-gradient(1200px 600px at 50% -10%,#16222c,#0d1318 60%);color:var(--tx);font-family:var(--sans);display:grid;place-items:center;min-height:100vh;padding:24px}
  .card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:30px 28px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  .dot{width:12px;height:12px;border-radius:50%;background:var(--ac);box-shadow:0 0 0 5px rgba(76,194,224,.15);margin-bottom:18px}
  h1{margin:0 0 4px;font-size:19px;letter-spacing:-.01em}
  p.sub{margin:0 0 22px;color:var(--mut);font-size:13px}
  label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:14px 0 6px}
  input{width:100%;background:#0f1720;border:1px solid var(--bd);border-radius:9px;color:var(--tx);font-size:14px;padding:11px 12px;font-family:var(--sans)}
  input:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px rgba(76,194,224,.15)}
  button{width:100%;margin-top:20px;background:var(--ac);color:#062028;border:none;border-radius:9px;padding:12px;font-size:14px;font-weight:650;cursor:pointer;font-family:var(--sans)}
  button:disabled{opacity:.6;cursor:progress}
  .err{color:var(--er);font-size:12.5px;margin-top:14px;min-height:16px;font-family:var(--mono)}
  .foot{margin-top:20px;font-size:11px;color:#5c6b78;font-family:var(--mono);text-align:center}
</style></head>
<body>
  <form class="card" id="f" autocomplete="off">
    <div class="dot"></div>
    <h1>Curious Ops</h1>
    <p class="sub">Private status dashboard. Authorised access only.</p>
    <label for="e">Email</label>
    <input id="e" type="email" placeholder="you@curiousbrand.co.uk" autocomplete="username" required>
    <label for="p">Passphrase</label>
    <input id="p" type="password" placeholder="••••••••" autocomplete="current-password" required>
    <button id="b" type="submit">Unlock</button>
    <div class="err" id="err"></div>
    <div class="foot">AES-256 · decrypts in your browser</div>
  </form>
<script>
  const SALT = b64ToBytes("${b64(salt)}"), IV = b64ToBytes("${b64(iv)}"), BLOB = b64ToBytes("${blob}");
  function b64ToBytes(s){const bin=atob(s);const a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}
  async function unlock(email, pass){
    const enc=new TextEncoder();
    const mat=await crypto.subtle.importKey("raw",enc.encode(email+":"+pass),"PBKDF2",false,["deriveKey"]);
    const key=await crypto.subtle.deriveKey({name:"PBKDF2",salt:SALT,iterations:${ITER},hash:"SHA-256"},mat,{name:"AES-GCM",length:256},false,["decrypt"]);
    const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:IV},key,BLOB);
    return new TextDecoder().decode(pt);
  }
  const f=document.getElementById("f"),err=document.getElementById("err"),b=document.getElementById("b");
  f.addEventListener("submit",async(ev)=>{
    ev.preventDefault();err.textContent="";b.disabled=true;b.textContent="Unlocking…";
    const email=document.getElementById("e").value.trim().toLowerCase();
    const pass=document.getElementById("p").value;
    if(email!=="${ALLOWED_EMAIL}"){err.textContent="Not an authorised account.";b.disabled=false;b.textContent="Unlock";return;}
    try{
      const html=await unlock(email,pass);
      document.open();document.write(html);document.close();
    }catch(e){
      err.textContent="Wrong email or passphrase.";b.disabled=false;b.textContent="Unlock";
    }
  });
</script>
</body></html>`;

// dist/ (for any host) + docs/ (GitHub Pages publishing source)
for (const sub of ["dist", "docs"]) {
  const d = join(DIR, sub);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "index.html"), page);
}
// GitHub Pages custom-domain marker
writeFileSync(join(DIR, "docs", "CNAME"), "status.curiousbrand.co.uk\n");
console.log(`→ wrote dist/index.html + docs/index.html (${(page.length / 1024).toFixed(0)} KB, encrypted)`);
console.log(`   allowed email: ${ALLOWED_EMAIL} · passphrase in GATE-PASSPHRASE.txt`);
