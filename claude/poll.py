#!/usr/bin/env python3
"""
VSL Edit Portal — queue poller for Claude Code (runs on subscription, no API tokens).

  poll.py                 list NEW requests
  poll.py process         ingest every NEW request: download video + inspiration, stage a
                          working dir + BRIEF.md, mark it 'editing'
  poll.py done <id> <mp4> upload the finished video to Completions + mark the row 'done'
  poll.py update <id> <status> [url] [name]

Drive I/O uses rclone remote `gdrive` (read+write verified). Folders referenced by ID.
"""
import os, sys, json, subprocess, fcntl

# launchd runs with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so rclone (/usr/local/bin) was
# "No such file or directory" on every auto run. Put the real tool dirs on PATH first.
os.environ["PATH"] = "/usr/local/bin:/opt/homebrew/bin:" + os.environ.get("PATH", "/usr/bin:/bin")

API = os.environ.get("VSL_API") or "https://script.google.com/macros/s/AKfycbxXa000IF-BPEiF5j9vT1UWd9TNpORow0-XYnlWX2pQXAm7Pf_EEpzZRqDqfkOgXxcw/exec"
REMOTE = "gdrive:"
DONE_FOLDER_ID = "1IJ3WphFk2EVVSdS6W1bWxtwZ4WUgRJIT"   # VSL - Completions
INBOX = os.path.expanduser("~/vsl-edit/inbox")

# completion email (sent via Mail.app / osascript on this Mac; no API keys needed)
NOTIFY_FROM = "starsvince@gmail.com"           # Mail.app Google account
NOTIFY_TO   = "martin@narrowgatefirm.com"
NOTIFY_CC   = "starsvince@gmail.com"            # cc Vince (vince@inleap.ai bounces)

def _get(action):
    out = subprocess.run(["curl", "-sL", f"{API}?action={action}&t=1"], capture_output=True, text=True, timeout=40).stdout
    return json.loads(out)

def _post(payload):
    subprocess.run(["curl", "-s", "-X", "POST", "-H", "Content-Type: text/plain",
                    "--data", json.dumps(payload), API], capture_output=True, text=True, timeout=40)
    return {"ok": True}

def apps_notify(kind, rid, note=""):
    """Ask the Apps Script backend to send the HTML email for this row (recipients and wording live there)."""
    try:
        out = subprocess.run(["curl", "-sL", "-H", "Content-Type: text/plain", "--data",   # no -X POST: curl must follow the 302 with a GET
                              json.dumps({"action": "notify", "kind": kind, "id": rid, "note": note[:700]}), API],
                             capture_output=True, text=True, timeout=60).stdout
        return bool(json.loads(out).get("ok"))
    except Exception:
        return False

def html_mail():
    """True once the deployed backend carries the HTML email code (it then also sends the request emails itself)."""
    try: return bool(_get("list").get("caps", {}).get("htmlmail"))
    except Exception: return False

def queue():        return _get("queue").get("requests", [])
def new_requests(): return [r for r in queue() if r.get("status") == "new"]
def update(rid, status, url=None, name=None):
    return _post({"action": "update", "id": rid, "status": status, "result_url": url, "result_name": name})

def dl(file_id, dest):
    os.makedirs(dest, exist_ok=True)
    # rclone copyid needs a trailing slash to treat dest as a directory; without it
    # newer rclone (1.74+) mis-handles the .partial rename -> "incompatible remotes".
    # 8 parallel streams: a 2.4 GB source went from ~16 min to ~6 min (measured 2026-10-02)
    subprocess.run(["rclone", "backend", "copyid", REMOTE, file_id, os.path.join(dest, ""),
                    "--multi-thread-streams", "8", "--multi-thread-cutoff", "64M"], check=True)

MAX_ATTEMPTS = 3

def _lock():
    """One poller at a time. Two overlapping runs downloaded the same file into the same
    .partial and rclone rejected it ("corrupted on transfer: md5 hashes differ") — 2026-10-02."""
    os.makedirs(INBOX, exist_ok=True)
    f = open(os.path.join(INBOX, ".poll.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another poll run is still working — exiting"); sys.exit(0)
    return f

def ingest(r):
    d = os.path.join(INBOX, r["id"]); os.makedirs(d, exist_ok=True)
    # Claim the row BEFORE the download: a 2 GB pull outlasts the 20-min launchd interval,
    # so the next run must not see this request as still 'new'.
    update(r["id"], "editing")
    att_file = os.path.join(d, ".attempts")
    attempts = int(open(att_file).read() or 0) + 1 if os.path.exists(att_file) else 1
    open(att_file, "w").write(str(attempts))
    try:
        # A change request names the earlier request it builds on. If that one was archived to Drive, bring it back first.
        import re as _re
        for prev in set(_re.findall(r"\(request ([0-9a-f-]{36})\)", r.get("notes") or "")):
            if os.path.exists(os.path.join(INBOX, prev, "ARCHIVED.md")):
                print(f"  ↺ restoring archived edit {prev[:8]}")
                subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "archive.py"), "restore", prev], check=True)
        if r.get("video_id"):
            print(f"  ↓ video: {r.get('video_name')}"); dl(r["video_id"], d)
        insp_ids = [x for x in (r.get("inspiration_ids") or "").split(",") if x]
        for fid in insp_ids:
            print(f"  ↓ inspiration: {fid}"); dl(fid, os.path.join(d, "inspiration"))
    except Exception:
        # give the row back so the next run retries; after MAX_ATTEMPTS stop and say so loudly
        if attempts >= MAX_ATTEMPTS:
            update(r["id"], "failed")
            _send_mail(NOTIFY_CC, None, f"VSL Edit Portal — download FAILED {attempts}x: {r.get('video_name')}",
                       ["Hi Vince,", "", f"The portal could not download this request after {attempts} tries and has stopped retrying:",
                        f"- {r.get('video_name')}  (id {r['id']})", "", "Check the file in Drive, then set the row back to 'new' to retry.",
                        "", "- VSL Edit Portal auto-poller"])
        else:
            update(r["id"], "new")
        raise
    # Same source video requested before? Point the editor at that work so it revises instead of starting over.
    earlier = [x for x in queue() if x.get("id") != r["id"] and x.get("video_id") == r.get("video_id") and x.get("result_name")
               and os.path.isdir(os.path.join(INBOX, x["id"]))]
    hint = ""
    if earlier:
        e = earlier[0]
        hint = (f"\n## Earlier edit of this same video\nRequest {e['id']} was delivered as {e.get('result_name')}. Its folder "
                f"{os.path.join(INBOX, e['id'])} holds the transcript, the builder and the raw render. Start from that builder and apply "
                f"this brief to it (for example a new palette); do not rebuild from scratch. If that folder has ARCHIVED.md, run: "
                f"python3 {os.path.join(os.path.dirname(os.path.abspath(__file__)), 'archive.py')} restore {e['id']}\n")
    open(os.path.join(d, "BRIEF.md"), "w").write(
        f"# Edit request {r['id']}\n\n"
        f"- Video:  {r.get('video_name')}\n- Change: {r.get('change_type')}\n"
        f"- Notes:  {r.get('notes')}\n- Inspiration: {r.get('inspiration_names') or '(none)'}\n\n"
        f"Files in: {d}\nWhen finished:  python3 {os.path.abspath(__file__)} done {r['id']} <result.mp4>\n" + hint)
    print(f"  ✓ staged -> {d}")
    return d

def process():
    _lk = _lock()
    n = new_requests()
    if not n: print("No new requests."); return []
    print(f"{len(n)} new request(s) — ingesting:\n")
    dirs = []
    for r in n:
        print(f"• {r.get('video_name')} — {r.get('change_type')}")
        dirs.append(ingest(r)); print()
    return dirs

def notify():
    nr = new_requests()
    if not nr: return
    names = ", ".join((r.get("video_name") or "?") for r in nr[:3])
    msg = f"{len(nr)} new edit request(s): {names}"
    subprocess.run(["osascript", "-e",
                    f'display notification "{msg}" with title "VSL Edit Portal" sound name "Glass"'])
    print(msg)

def notify_email(name, link):
    """Send a completion email via Mail.app (osascript) — to Martin, cc Vince."""
    subject = f"VSL edit ready for review - {name}"
    body_lines = ["Hi Martin,", "",
                  "Your VSL edit is finished and ready for review:", link, "",
                  f"File: {name}", "",
                  "- Sent automatically by the VSL Edit Portal"]
    def esc(s): return s.replace("\\", "\\\\").replace('"', '\\"')
    content = " & return & ".join('"%s"' % esc(l) for l in body_lines)
    props = (f'{{subject:"{esc(subject)}", content:{content}, visible:false}}')
    ascript = (
        'tell application "Mail"\n'
        f'  set m to make new outgoing message with properties {props}\n'
        '  tell m\n'
        f'    make new to recipient at end of to recipients with properties {{address:"{NOTIFY_TO}"}}\n'
        f'    make new cc recipient at end of cc recipients with properties {{address:"{NOTIFY_CC}"}}\n'
        f'    set sender to "{NOTIFY_FROM}"\n'
        '  end tell\n'
        '  send m\n'
        'end tell')
    try:
        r = subprocess.run(["osascript", "-e", ascript], capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            print(f"  emailed {NOTIFY_TO} (cc {NOTIFY_CC})")
        else:
            print(f"  ! email failed: {r.stderr.strip()}")
    except Exception as e:
        print(f"  ! email error: {e}")

def _send_mail(to_addr, cc_addr, subject, body_lines):
    def esc(s): return s.replace("\\", "\\\\").replace('"', '\\"')
    content = " & return & ".join('"%s"' % esc(l) for l in body_lines)
    cc_line = (f'    make new cc recipient at end of cc recipients with properties {{address:"{cc_addr}"}}\n'
               if cc_addr else "")
    ascript = ('tell application "Mail"\n'
               f'  set m to make new outgoing message with properties {{subject:"{esc(subject)}", content:{content}, visible:false}}\n'
               '  tell m\n'
               f'    make new to recipient at end of to recipients with properties {{address:"{to_addr}"}}\n'
               f'{cc_line}'
               f'    set sender to "{NOTIFY_FROM}"\n'
               '  end tell\n  send m\nend tell')
    try:
        r = subprocess.run(["osascript", "-e", ascript], capture_output=True, text=True, timeout=60)
        print(f"  emailed {to_addr}") if r.returncode == 0 else print(f"  ! email failed: {r.stderr.strip()}")
    except Exception as e:
        print(f"  ! email error: {e}")

def from_portal(r):
    """True only when the request was signed by the login-protected portal (the Worker adds the signature).
    Anything posted straight at the Apps Script URL has no valid signature and must never start an unattended edit."""
    import re, hmac, hashlib
    try:
        key = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".portal_secrets.json")))["SIGN_KEY"]
    except Exception:
        return False
    m = re.search(r"^(.*?)\n*Sent from the portal by (\S+) \[([0-9a-f]{24})\]\s*$", r.get("notes") or "", re.S)
    if not m: return False
    want = hmac.new(key.encode(), ((r.get("video_id") or "") + "\n" + m.group(1) + "\n" + m.group(2)).encode(), hashlib.sha256).hexdigest()[:24]
    return hmac.compare_digest(want, m.group(3))

AUTO_QUEUE = os.path.expanduser("~/vsl-edit/auto-queue")

def auto():
    """Auto-poller: download + stage every real NEW request, then alert Vince by email.
    The creative edit still needs a Claude session — this just preps + notifies."""
    _lk = _lock()
    nr = [r for r in new_requests() if r.get("video_id")]   # real edits only (skip empty test rows)
    # Standby machine (VSL_STANDBY_MIN=15 in its LaunchAgent): only take a request the main Mac has left unclaimed that long.
    wait_min = float(os.environ.get("VSL_STANDBY_MIN", "0") or 0)
    if wait_min:
        import datetime as _dt
        now = _dt.datetime.now(_dt.timezone.utc)
        def _age(r):
            try: return (now - _dt.datetime.fromisoformat(str(r.get("created")).replace("Z", "+00:00"))).total_seconds() / 60
            except Exception: return 0
        nr = [r for r in nr if _age(r) >= wait_min]
    if not nr:
        print("auto: nothing new"); return
    print(f"auto: staging {len(nr)} request(s)")
    staged = []
    # Same video + same ask submitted twice (double-click on Send) -> work the first, mark the rest.
    sig = lambda r: (r.get("video_id"), r.get("change_type"), (r.get("notes") or "").strip(), r.get("inspiration_ids"))
    busy = {sig(r) for r in queue() if r.get("status") == "editing"}
    for r in sorted(nr, key=lambda r: r.get("created") or ""):
        if sig(r) in busy:
            print(f"  = duplicate of a request already in progress: {r.get('id')}"); update(r["id"], "duplicate"); continue
        busy.add(sig(r))
        try:
            ingest(r); staged.append(r)
            if from_portal(r):   # hand it to the auto-edit runner (if Vince has switched it on, it watches this folder)
                os.makedirs(AUTO_QUEUE, exist_ok=True); open(os.path.join(AUTO_QUEUE, r["id"]), "w").write(r.get("video_name") or "")
        except Exception as e:
            print(f"  ! ingest failed {r.get('id')}: {e}")
    if not staged:
        return
    names = ", ".join((r.get("video_name") or "?") for r in staged)
    if html_mail():   # the backend already emailed Martin ("we got it") and Vince (the full request) when it was submitted
        subprocess.run(["osascript", "-e", f'display notification "Staged {len(staged)}: {names}" with title "VSL Edit Portal" sound name "Glass"'])
        return
    subprocess.run(["osascript", "-e",
                    f'display notification "Staged {len(staged)}: {names}" with title "VSL Edit Portal — new request" sound name "Glass"'])
    body = ["Hi Vince,", "",
            f"{len(staged)} new VSL edit request(s) were downloaded and staged for editing:", ""]
    for r in staged:
        body.append(f"- {r.get('video_name')}  [{r.get('change_type')}]")
        if (r.get("notes") or "").strip():
            body.append(f"    notes: {r.get('notes')}")
        body.append(f"    folder: ~/vsl-edit/inbox/{r.get('id')}/  (BRIEF.md written, status=editing)")
    body += ["", "Open a Claude Code session to run the edit — the files are already pulled.",
             "", "- VSL Edit Portal auto-poller"]
    _send_mail(NOTIFY_CC, None, f"VSL Edit Portal — {len(staged)} new request(s) staged", body)
    # Requester's receipt: tells Martin it arrived and is being worked (Vince, 2026-10-03).
    for r in staged:
        _send_mail(NOTIFY_TO, NOTIFY_CC, f"VSL edit request received: {r.get('video_name')}",
                   ["Hi Martin,", "", "Your edit request was received and is queued for editing:", "",
                    f"Video: {r.get('video_name')}", f"Needs: {r.get('change_type')}",
                    f"Inspiration: {r.get('inspiration_names') or '(none)'}", f"Notes: {r.get('notes') or ''}", "",
                    "You'll get a second email with the review link when it is finished.", "",
                    "Portal: https://edits.vincestars.com/", "", "- VSL Edit Portal"])

def _free_name(path):
    """Never overwrite an earlier delivery: if Completions already holds a different file with this name, move to the next _vN."""
    import re, shutil
    name = os.path.basename(path)
    try: have = {f["name"]: f.get("size") for f in _get("completions").get("files", [])}
    except Exception: return path
    if name not in have or have[name] == os.path.getsize(path): return path
    stem, ext = os.path.splitext(name)
    m = re.search(r"^(.*_v)(\d+)$", stem); base, n = (m.group(1), int(m.group(2))) if m else (stem + "_v", 1)
    while f"{base}{n}{ext}" in have: n += 1
    new = os.path.join(os.path.dirname(path), f"{base}{n}{ext}")
    shutil.copy2(path, new); print(f"  name taken in Completions: delivering as {os.path.basename(new)}")
    return new

def done(rid, path, send_email=True):
    path = _free_name(path)
    name = os.path.basename(path)
    # --timeout 60s: without it a stalled Drive connection hung the upload for 10+ min, twice (2026-10-03)
    subprocess.run(["rclone", "copy", path, REMOTE, "--drive-root-folder-id", DONE_FOLDER_ID,
                    "--timeout", "60s", "--retries", "5", "--low-level-retries", "5"], check=True, timeout=1800)
    link = subprocess.run(["rclone", "link", REMOTE + name, "--drive-root-folder-id", DONE_FOLDER_ID],
                          capture_output=True, text=True).stdout.strip()
    update(rid, "done", link, name)
    print(f"uploaded {name} -> Completions\n{link}")
    if send_email and not apps_notify("delivered", rid):
        notify_email(name, link)   # backend not updated yet: plain-text fallback

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "list":
        nr = new_requests()
        print("No new requests." if not nr else
              "\n".join(f"{r['id']}  {r.get('video_name')}  [{r.get('change_type')}]  {r.get('notes')}" for r in nr))
    elif a[0] == "process": process()
    elif a[0] == "auto": auto()
    elif a[0] == "notify": notify()
    elif a[0] == "done" and len(a) > 2: done(a[1], a[2], "--no-email" not in a)
    elif a[0] == "mail" and len(a) > 2:
        if not apps_notify(a[1], a[2], " ".join(a[3:])):   # backend without the HTML code yet: plain mail to Vince
            _send_mail(NOTIFY_CC, None, f"VSL Edit Portal: {a[1]} ({a[2][:8]})", [" ".join(a[3:]) or a[1]])
    elif a[0] == "email" and len(a) > 2: notify_email(a[1], a[2])
    elif a[0] == "update" and len(a) > 2: update(*a[1:])
    else: print(__doc__)
