// VSL edit portal: passwordless (magic-link) login + proxy to the Apps Script backend.
// Env:
//   SESSION_KEY  secret — signs the session cookie AND the one-time login links (domain-separated)
//   SIGN_KEY     secret — signs new portal requests so the Mac can tell portal requests apart
//   API_URL      the Apps Script /exec URL (proxied for the portal AND used to email login links)
//   ALLOWED      optional JSON array of allowed emails (defaults to Vince + Martin)
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

const DEFAULT_ALLOWED = ["starsvince@gmail.com", "martin@narrowgatefirm.com"];
function allowList(env) {
  try { const a = JSON.parse(env.ALLOWED || ""); if (Array.isArray(a) && a.length) return a.map(e => String(e).trim().toLowerCase()); } catch (e) {}
  return DEFAULT_ALLOWED;
}

// ---- session cookie: email|exp|hmac(SESSION_KEY, email|exp) ----
async function who(req, env) {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)vsl=([^;]+)/); if (!m) return null;
  const [email, exp, sig] = decodeURIComponent(m[1]).split("|");
  if (!email || !exp || !sig || Date.now() > +exp) return null;
  return same(sig, await hmac(env.SESSION_KEY, email + "|" + exp)) ? email : null;
}
function sessionCookie(email, exp, sig) {
  const v = encodeURIComponent(email + "|" + exp + "|" + sig);
  return `vsl=${v}; Path=/; Max-Age=${90 * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

// ---- one-time login link token: email|exp|hmac(SESSION_KEY, "magic|email|exp") ----
// 15-minute lifetime; domain-separated from the session cookie so the two can never be swapped.
const LINK_TTL = 15 * 60 * 1000;
async function makeLinkToken(env, email, exp) { return email + "|" + exp + "|" + await hmac(env.SESSION_KEY, "magic|" + email + "|" + exp); }
async function readLinkToken(env, tok) {
  const [email, exp, sig] = String(tok).split("|");
  if (!email || !exp || !sig || Date.now() > +exp) return null;
  return same(sig, await hmac(env.SESSION_KEY, "magic|" + email + "|" + exp)) ? email : null;
}

const CSS = `body{margin:0;background:#F4F5F7;color:#14171F;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.box{max-width:380px;margin:12vh auto 0;padding:28px;background:#fff;border:1px solid #D8DDE5;border-radius:10px;box-shadow:0 8px 24px -12px rgba(20,23,31,.12)}
h1{font-size:22px;margin:0 0 6px}label{display:block;font-size:14px;font-weight:650;margin:18px 0 6px}
input{font:inherit;width:100%;box-sizing:border-box;border:1px solid #D8DDE5;border-radius:8px;padding:10px 12px}
button{font:inherit;font-weight:650;width:100%;margin-top:20px;min-height:48px;border:0;border-radius:8px;background:#1F4FD8;color:#fff;cursor:pointer}
.muted{color:#5B6472;font-size:13px;margin:12px 0 0}.err{color:#A3231B;font-size:14px;margin:14px 0 0}
a{color:#1F4FD8}input:focus-visible,button:focus-visible{outline:3px solid rgba(31,79,216,.35);outline-offset:2px}`;
const html = (status, body) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edit requests</title><style>${CSS}</style></head><body><div class="box">${body}</div></body></html>`,
  { status, headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });

const loginPage = (err) => html(err ? 401 : 200, `<form method="post" action="/login">
<h1>Edit requests</h1><p class="muted">Enter your email and we'll send you a one-time sign-in link. No password.</p>
<label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username" required autofocus>
<button>Email me a login link</button>${err ? `<p class="err">${err}</p>` : ""}</form>`);
const sentPage = (email) => html(200, `<h1>Check your email</h1>
<p class="muted">If <b>${email}</b> is on the access list, a one-time sign-in link is on its way. It expires in 15 minutes.</p>
<p class="muted"><a href="/login">Use a different email</a></p>`);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Request a login link
    if (url.pathname === "/login") {
      if (req.method !== "POST") return loginPage("");
      const f = await req.formData();
      const email = String(f.get("email") || "").trim().toLowerCase();
      if (allowList(env).includes(email)) {                       // only send to allowed users; show the same page either way (no account enumeration)
        const exp = Date.now() + LINK_TTL;
        const link = url.origin + "/auth?t=" + encodeURIComponent(await makeLinkToken(env, email, exp));
        try {
          await fetch(env.API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "magiclink", email, link }), redirect: "follow" });
        } catch (e) {}
      }
      return sentPage(email || "that address");
    }

    // Consume a login link -> start a session
    if (url.pathname === "/auth") {
      const email = await readLinkToken(env, url.searchParams.get("t") || "");
      if (!email || !allowList(env).includes(email)) return loginPage("That link is invalid or has expired. Request a new one.");
      const exp = Date.now() + 90 * 864e5;
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": sessionCookie(email, exp, await hmac(env.SESSION_KEY, email + "|" + exp)) } });
    }

    if (url.pathname === "/logout") {
      return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": "vsl=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
    }

    const email = await who(req, env);
    if (url.pathname === "/api") {
      if (!email) return Response.json({ ok: false, error: "signed out" }, { status: 401 });
      if (req.method === "GET") { const r = await fetch(env.API_URL + url.search, { redirect: "follow" }); return new Response(await r.text(), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
      const b = JSON.parse(await req.text());
      if (b.action === "magiclink") return Response.json({ ok: false, error: "nope" }, { status: 400 }); // login mail is server-initiated only, never via the client proxy
      if (b.action !== "update") {   // sign new requests so the Mac can tell portal requests from anything posted straight at the backend
        b.notes = String(b.notes || ""); const sig = (await hmac(env.SIGN_KEY, (b.video_id || "") + "\n" + b.notes + "\n" + email)).slice(0, 24);
        b.notes += (b.notes ? "\n\n" : "") + "Sent from the portal by " + email + " [" + sig + "]";
      }
      const r = await fetch(env.API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(b), redirect: "follow" });
      return new Response(await r.text(), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (!email) return Response.redirect(url.origin + "/login", 302);
    return env.ASSETS.fetch(req);
  }
};
