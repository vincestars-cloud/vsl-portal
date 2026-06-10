#!/usr/bin/env python3
"""
VSL Edit Portal — queue poller for Claude Code (runs on subscription, no API tokens).

Reads the Apps Script queue, surfaces NEW requests, and pulls the chosen video so
Claude can edit it. Run with no args to list new work; `pull <id>` to fetch a request's
files; `update <id> <status> [result_url] [result_name]` to mark progress.

Config: set VSL_API to the Apps Script /exec URL (or edit API_DEFAULT below).
Downloads/uploads use rclone remote `gdrive` (5GB-safe). Falls back to gdown for pulls.
"""
import os, sys, json, subprocess, urllib.request

API = os.environ.get("VSL_API") or "PASTE_APPS_SCRIPT_EXEC_URL_HERE"
WORKDIR = os.path.expanduser("~/vsl-edit/inbox")
RCLONE_REMOTE = "gdrive"  # rclone config remote name

def _get(action):
    with urllib.request.urlopen(f"{API}?action={action}&t=1", timeout=30) as r:
        return json.loads(r.read())

def _post(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(API, data=data, headers={"Content-Type": "text/plain"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def list_new():
    q = _get("queue").get("requests", [])
    new = [r for r in q if r.get("status") == "new"]
    if not new:
        print("No new requests."); return new
    print(f"{len(new)} NEW request(s):\n")
    for r in new:
        print(f"  id:    {r['id']}")
        print(f"  video: {r.get('video_name','?')}")
        print(f"  change:{r.get('change_type','?')}")
        print(f"  notes: {r.get('notes','')}\n")
    return new

def _download(file_id, name, dest):
    os.makedirs(dest, exist_ok=True)
    out = os.path.join(dest, name)
    # try rclone (by id) first, then gdown
    try:
        subprocess.run(["rclone", "copyid", f"{RCLONE_REMOTE}:", file_id, dest], check=True)
        return out
    except Exception:
        subprocess.run(["gdown", "--id", file_id, "-O", out], check=True)
        return out

def pull(req_id):
    q = _get("queue").get("requests", [])
    r = next((x for x in q if x["id"] == req_id), None)
    if not r:
        print("id not found"); return
    # the queue endpoint is trimmed; for ids re-list submissions to map names->ids if needed
    print(f"Pulling for: {r.get('video_name')} — {r.get('change_type')}")
    print(f"Notes: {r.get('notes')}")
    print("NOTE: fetch the video_id from the submissions list / sheet, then:")
    print(f"  rclone copyid {RCLONE_REMOTE}: <video_id> {WORKDIR}")
    print(f"  (inspiration files the same way). Then edit in ~/vsl-edit and upload the result:")
    print(f"  rclone copy <result.mp4> {RCLONE_REMOTE}:VSL-Completions/")
    print(f"  python3 poll.py update {req_id} done <result_url> <result_name>")

def update(req_id, status, result_url=None, result_name=None):
    print(_post({"action": "update", "id": req_id, "status": status,
                 "result_url": result_url, "result_name": result_name}))

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a: list_new()
    elif a[0] == "pull" and len(a) > 1: pull(a[1])
    elif a[0] == "update" and len(a) > 2: update(*a[1:])
    else: print(__doc__)
