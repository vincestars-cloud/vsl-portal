# VSL Edit Portal

A static web interface to send video-edit requests to Claude Code — **no Supabase, no API tokens**.

- You drop raw videos (+ inspiration) into a Google Drive folder.
- The interface lists them as a dropdown (auto-refreshing), you pick one + describe the change.
- The request is logged to a private Google Sheet (via Apps Script).
- Claude Code (your Max subscription, scheduled) reads the queue, pulls the video, edits it, and drops the finished video in a **Completions** folder for review.

**Zero Anthropic API tokens** — the interface never calls the API; the editing is done by Claude Code on subscription.

## Setup (one-time, ~10 min)

### 1. Apps Script backend
1. Go to **script.google.com → New project**, delete the stub, paste `apps-script/Code.gs`.
2. Run **`setup`** (top toolbar ▶). Authorize Drive + Sheets when prompted.
3. Open **View → Execution log** — copy the **"DROP RAW VIDEOS HERE"** folder URL. That's where you drop videos.
4. **Deploy → New deployment → Web app**: *Execute as = Me*, *Who has access = Anyone*. Copy the **/exec URL**.

### 2. Interface
- Hosted on GitHub Pages. Either:
  - Send Claude the `/exec` URL and it hardcodes it into `index.html`, **or**
  - Test immediately by opening `…/index.html?api=<your /exec URL>`.

### 3. Claude side (rclone, one-time)
- `brew install rclone` then `rclone config` → new remote named **`gdrive`**, type Google Drive, authorize the same account. Lets Claude pull submissions and upload completions for 5GB+ files.

## How a request flows
1. Drop `video.mov` into **VSL - Submissions**.
2. Open the interface → it appears in the dropdown → pick it, choose a change, add notes → **Send to Claude**.
3. Scheduled Claude routine: reads the queue (`?action=queue`), pulls the video by ID, runs the edit pipeline, uploads the result to **VSL - Completions**, marks the row `done` + result link.
4. The interface's **Ready for review** list shows the finished video with a link.

## Files
- `index.html` — the interface (static).
- `apps-script/Code.gs` — the Drive/Sheet backend.
- `claude/poll.py` — the queue poller Claude runs (scheduled).
