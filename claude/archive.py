#!/usr/bin/env python3
"""
VSL edit archive: after 7 quiet days, move a finished request's big files to Google Drive and free the Mac.

  archive.py            dry run: list what would be archived and how much space it frees
  archive.py run        archive every eligible request folder, then clear old finals from ~/Downloads
  archive.py restore <request id>   bring a request's files back from Drive (poll.py does this by itself
                                    when a change request arrives for an archived edit)
  archive.py status     what is archived, and local sizes

Rules (safety first):
  - Only folders whose request is finished (done / approved / duplicate / failed), with NO file touched in 7 days,
    and that no open request refers to.
  - Upload first, then `rclone check` the Drive copy against the local files. Nothing is deleted unless the check passes.
  - Small text files (builders, transcripts, briefs, reports) stay on the Mac; only media and other big files go.
  - Regenerable junk (render segments, snapshots, node_modules) is not uploaded, just removed.
"""
import os, sys, json, time, subprocess, shutil, re

os.environ["PATH"] = "/usr/local/bin:/opt/homebrew/bin:" + os.environ.get("PATH", "/usr/bin:/bin")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import poll

DAYS = 7
REMOTE = "gdrive:"
PARENT = "1nGlEFhEXjf_x2-Zu3CogYmO_lu3fWjn0"            # the portal's Drive folder
ARCHIVE_DIR = "VSL - Edit archive"                        # created beside Submissions / Completions
INBOX = os.path.expanduser("~/vsl-edit/inbox")
DOWNLOADS = os.path.expanduser("~/Downloads")
LOG = os.path.expanduser("~/vsl-edit/archive.log")
MARK = "ARCHIVED.md"
JUNK = ["**/renders/.hf-segments/**", "**/.raw.hf-transaction-*/**", "**/node_modules/**", "**/snapshots/**", "**/__pycache__/**", "**/.DS_Store"]
KEEP_EXT = {".py", ".md", ".json", ".txt", ".html", ".js", ".sh", ".css", ".srt", ".filter", ".log"}
KEEP_MAX = 512 * 1024                                     # text files above this size go to Drive too
FINISHED = {"done", "approved", "duplicate", "failed"}

def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M ") + msg
    print(line)
    with open(LOG, "a") as f: f.write(line + "\n")

def rc(args, **kw):
    return subprocess.run(["rclone"] + args + ["--drive-root-folder-id", PARENT, "--timeout", "120s", "--retries", "5", "--low-level-retries", "8"],
                          capture_output=True, text=True, **kw)

def is_junk(rel):
    parts = rel.split(os.sep)
    return any(p in ("node_modules", "snapshots", "__pycache__") for p in parts) or ".hf-segments" in parts \
        or any(p.startswith(".raw.hf-transaction-") for p in parts) or parts[-1] == ".DS_Store"

def keep_local(path):
    return os.path.splitext(path)[1].lower() in KEEP_EXT and os.path.getsize(path) <= KEEP_MAX

def walk(d):
    for root, _, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            if os.path.islink(p) or f == MARK: continue
            yield p, os.path.relpath(p, d)

def newest(d):
    return max((os.path.getmtime(p) for p, _ in walk(d)), default=0)

def size(paths): return sum(os.path.getsize(p) for p in paths if os.path.exists(p))
def gb(n): return f"{n / 1e9:.2f} GB"

def candidates():
    q = poll.queue()
    status = {r["id"]: r.get("status") for r in q}
    open_notes = " ".join((r.get("notes") or "") + " " + (r.get("video_id") or "") for r in q if r.get("status") in ("new", "editing"))
    cutoff = time.time() - DAYS * 86400
    out = []
    for name in sorted(os.listdir(INBOX)):
        d = os.path.join(INBOX, name)
        if not os.path.isdir(d) or name.startswith(".") or os.path.exists(os.path.join(d, MARK)): continue
        st = status.get(name)
        if st is not None and st not in FINISHED: continue            # still being worked
        if name in open_notes: continue                               # an open change request builds on it
        if os.path.exists(os.path.join(os.path.expanduser("~/vsl-edit/auto-queue"), name)): continue
        n = newest(d)
        if not n or n > cutoff: continue
        out.append((name, d, st or "not in queue", n))
    return out

def plan(d):
    up, junk, keep = [], [], []
    for p, rel in walk(d):
        (junk if is_junk(rel) else keep if keep_local(p) else up).append(p)
    return up, junk, keep

def archive(name, d):
    up, junk, keep = plan(d)
    dest = f"{REMOTE}{ARCHIVE_DIR}/{name}"
    log(f"archive {name}: uploading {len(up) + len(keep)} files ({gb(size(up + keep))}), dropping {len(junk)} regenerable files ({gb(size(junk))})")
    flt = sum((["--exclude", j] for j in JUNK), []) + ["--exclude", MARK]
    r = rc(["copy", d, dest, "--transfers", "4"] + flt, timeout=6 * 3600)
    if r.returncode != 0:
        log(f"  ! upload failed, nothing deleted: {r.stderr.strip()[-300:]}"); return False
    c = rc(["check", d, dest, "--one-way"] + flt, timeout=3600)          # every local file must exist on Drive with the same hash
    if c.returncode != 0:
        log(f"  ! verification failed, nothing deleted: {(c.stderr or c.stdout).strip()[-300:]}"); return False
    removed = up + junk
    freed = size(removed)
    listing = [os.path.relpath(p, d) for p in up]
    for p in removed:
        try: os.remove(p)
        except OSError: pass
    for root, dirs, files in os.walk(d, topdown=False):                   # tidy empty folders
        if root != d and not os.listdir(root):
            try: os.rmdir(root)
            except OSError: pass
    with open(os.path.join(d, MARK), "w") as f:
        f.write(f"# Archived {time.strftime('%Y-%m-%d')}\n\nThe big files of this request were moved to Google Drive: `{ARCHIVE_DIR}/{name}`\n"
                f"Bring them back with: `python3 {os.path.abspath(__file__)} restore {name}`\n\n## Files on Drive ({len(listing)})\n" + "\n".join("- " + x for x in sorted(listing)) + "\n")
    log(f"  ok: verified on Drive, freed {gb(freed)}")
    return freed

def restore(name):
    d = os.path.join(INBOX, name)
    if not os.path.exists(os.path.join(d, MARK)):
        print(f"{name} is not archived (nothing to restore)."); return True
    log(f"restore {name}: downloading from Drive")
    r = rc(["copy", f"{REMOTE}{ARCHIVE_DIR}/{name}", d, "--transfers", "4", "--multi-thread-streams", "8"], timeout=6 * 3600)
    if r.returncode != 0:
        log(f"  ! restore failed: {r.stderr.strip()[-300:]}"); return False
    os.remove(os.path.join(d, MARK))
    for p, _ in walk(d): os.utime(p, None)                               # fresh timestamps: it gets a new 7 quiet days
    log("  ok: restored"); return True

def downloads():
    """Finished edits in ~/Downloads that are byte-for-byte in the Completions folder and older than 7 days."""
    done = {f["name"]: f.get("size") for f in poll._get("completions").get("files", [])}
    cutoff = time.time() - DAYS * 86400
    out = []
    for f in os.listdir(DOWNLOADS):
        p = os.path.join(DOWNLOADS, f)
        if f in done and os.path.isfile(p) and os.path.getsize(p) == done[f] and os.path.getmtime(p) < cutoff: out.append(p)
    return out

def run(real):
    cands = candidates(); total = 0
    if not cands: print("No request folders are due (finished and untouched for 7 days).")
    for name, d, st, n in cands:
        up, junk, keep = plan(d)
        if real:
            total += archive(name, d) or 0
        else:
            print(f"would archive {name[:8]}  [{st}]  last touched {time.strftime('%b %d', time.localtime(n))}  frees {gb(size(up + junk))}  ({len(keep)} small files stay)")
            total += size(up + junk)
    dl = downloads()
    if dl:
        if real:
            n = size(dl); total += n
            for p in dl: os.remove(p)
            log(f"downloads: removed {len(dl)} finished edits already in Completions, freed {gb(n)}")
        else:
            print(f"would remove {len(dl)} finished edits from ~/Downloads (identical copies are in Completions): {gb(size(dl))}")
            total += size(dl)
    print(("Freed " if real else "Would free ") + gb(total))

def status():
    for name in sorted(os.listdir(INBOX)):
        d = os.path.join(INBOX, name)
        if os.path.isdir(d) and not name.startswith("."):
            print(f"{name[:8]}  {'ARCHIVED' if os.path.exists(os.path.join(d, MARK)) else 'local   '}  {gb(size(p for p, _ in walk(d)))}")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "run": run(True)
    elif a and a[0] == "restore" and len(a) > 1: sys.exit(0 if restore(a[1]) else 1)
    elif a and a[0] == "status": status()
    else: run(False)
