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
import os, sys, json, subprocess

API   = os.environ.get("VSL_API") or "https://script.google.com/macros/s/AKfycbxXa000IF-BPEiF5j9vT1UWd9TNpORow0-XYnlWX2pQXAm7Pf_EEpzZRqDqfkOgXxcw/exec"
REMOTE = "gdrive:"
DONE_FOLDER_ID = "1IJ3WphFk2EVVSdS6W1bWxtwZ4WUgRJIT"   # VSL - Completions
INBOX = os.path.expanduser("~/vsl-edit/inbox")

def _get(action):
    out = subprocess.run(["curl", "-sL", f"{API}?action={action}&t=1"], capture_output=True, text=True, timeout=40).stdout
    return json.loads(out)

def _post(payload):
    subprocess.run(["curl", "-s", "-X", "POST", "-H", "Content-Type: text/plain",
                    "--data", json.dumps(payload), API], capture_output=True, text=True, timeout=40)
    return {"ok": True}

def queue():        return _get("queue").get("requests", [])
def new_requests(): return [r for r in queue() if r.get("status") == "new"]
def update(rid, status, url=None, name=None):
    return _post({"action": "update", "id": rid, "status": status, "result_url": url, "result_name": name})

def dl(file_id, dest):
    os.makedirs(dest, exist_ok=True)
    subprocess.run(["rclone", "copyid", REMOTE, file_id, dest], check=True)

def ingest(r):
    d = os.path.join(INBOX, r["id"]); os.makedirs(d, exist_ok=True)
    if r.get("video_id"):
        print(f"  ↓ video: {r.get('video_name')}"); dl(r["video_id"], d)
    insp_ids = [x for x in (r.get("inspiration_ids") or "").split(",") if x]
    for fid in insp_ids:
        print(f"  ↓ inspiration: {fid}"); dl(fid, os.path.join(d, "inspiration"))
    open(os.path.join(d, "BRIEF.md"), "w").write(
        f"# Edit request {r['id']}\n\n"
        f"- Video:  {r.get('video_name')}\n- Change: {r.get('change_type')}\n"
        f"- Notes:  {r.get('notes')}\n- Inspiration: {r.get('inspiration_names') or '(none)'}\n\n"
        f"Files in: {d}\nWhen finished:  python3 {os.path.abspath(__file__)} done {r['id']} <result.mp4>\n")
    update(r["id"], "editing")
    print(f"  ✓ staged -> {d}")
    return d

def process():
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

def done(rid, path):
    name = os.path.basename(path)
    subprocess.run(["rclone", "copy", path, REMOTE, "--drive-root-folder-id", DONE_FOLDER_ID], check=True)
    link = subprocess.run(["rclone", "link", REMOTE + name, "--drive-root-folder-id", DONE_FOLDER_ID],
                          capture_output=True, text=True).stdout.strip()
    update(rid, "done", link, name)
    print(f"uploaded {name} -> Completions\n{link}")

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "list":
        nr = new_requests()
        print("No new requests." if not nr else
              "\n".join(f"{r['id']}  {r.get('video_name')}  [{r.get('change_type')}]  {r.get('notes')}" for r in nr))
    elif a[0] == "process": process()
    elif a[0] == "notify": notify()
    elif a[0] == "done" and len(a) > 2: done(a[1], a[2])
    elif a[0] == "update" and len(a) > 2: update(*a[1:])
    else: print(__doc__)
