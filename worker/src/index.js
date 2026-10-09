// VSL edit portal: login gate + proxy to the Apps Script backend.
// Secrets: SESSION_KEY, SIGN_KEY, USERS (JSON {"email":"access code"}), API_URL.
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function who(req, env) {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)vsl=([^;]+)/); if (!m) return null;
  const [email, exp, sig] = decodeURIComponent(m[1]).split("|");
  if (!email || !exp || !sig || Date.now() > +exp) return null;
  return same(sig, await hmac(env.SESSION_KEY, email + "|" + exp)) ? email : null;
}
const loginPage = msg => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>
<style>body{margin:0;background:#F4F5F7;color:#14171F;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
form{max-width:360px;margin:12vh auto 0;padding:28px;background:#fff;border:1px solid #D8DDE5;border-radius:10px;box-shadow:0 8px 24px -12px rgba(20,23,31,.12)}
h1{font-size:22px;margin:0 0 18px}label{display:block;font-size:14px;font-weight:650;margin:14px 0 6px}
input{font:inherit;width:100%;box-sizing:border-box;border:1px solid #D8DDE5;border-radius:8px;padding:10px 12px}
button{font:inherit;font-weight:650;width:100%;margin-top:20px;min-height:48px;border:0;border-radius:8px;background:#1F4FD8;color:#fff;cursor:pointer}
p{color:#A3231B;font-size:14px;margin:14px 0 0}input:focus-visible,button:focus-visible{outline:3px solid rgba(31,79,216,.35);outline-offset:2px}</style></head>
<body><form method="post" action="/login"><h1>Edit requests</h1>
<label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username" required>
<label for="c">Access code</label><input id="c" name="code" type="password" autocomplete="current-password" required>
<button>Sign in</button>${msg ? `<p>${msg}</p>` : ""}</form></body></html>`, { status: msg ? 401 : 200, headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/login") {
      if (req.method !== "POST") return loginPage("");
      const f = await req.formData(); const email = String(f.get("email") || "").trim().toLowerCase(); const code = String(f.get("code") || "").trim();
      const users = JSON.parse(env.USERS || "{}"); const want = users[email];
      if (!want || !same(await hmac(env.SESSION_KEY, code), await hmac(env.SESSION_KEY, want))) return loginPage("That email and access code don't match. Check both and try again.");
      const exp = Date.now() + 90 * 864e5; const v = encodeURIComponent(email + "|" + exp + "|" + await hmac(env.SESSION_KEY, email + "|" + exp));
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": `vsl=${v}; Path=/; Max-Age=${90 * 86400}; HttpOnly; Secure; SameSite=Lax` } });
    }
    const email = await who(req, env);
    if (url.pathname === "/api") {
      if (!email) return Response.json({ ok: false, error: "signed out" }, { status: 401 });
      if (req.method === "GET") { const r = await fetch(env.API_URL + url.search, { redirect: "follow" }); return new Response(await r.text(), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
      const b = JSON.parse(await req.text());
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
