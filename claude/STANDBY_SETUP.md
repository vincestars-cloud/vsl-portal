# Standby edit machine (MacBook) setup

Goal: if the Mac mini is off, the MacBook takes a portal request that has sat unclaimed for 15 minutes, edits it and delivers it.
The mini stays the main machine. The standby never touches a request the mini has already claimed (status `editing`).

Run these in a Claude Code session ON the MacBook. Adjust `/Users/vincentohasiligwo` if the username differs.

1. Tools: `brew install rclone ffmpeg node python` ; Google Chrome installed ; VS Code + the Claude Code extension, signed in.
2. Repos (same paths as the mini):
   - `git clone https://github.com/vincestars-cloud/vsl-portal ~/vsl-portal`
   - `git clone https://github.com/vincestars-cloud/vsl-edit ~/vsl-edit` (kit + inbox; private), then `mkdir -p ~/vsl-edit/inbox ~/vsl-edit/auto-queue ~/vsl-edit/auto-failed`
   - `~/openclaw` (skills): `git clone https://github.com/vincestars-cloud/openclaw-config ~/openclaw` (private), so `~/openclaw/shared/skills/jos-motion-graphics/SKILL.md` exists
   - `~/vsl-edit/kit/` (builders, `scaffold/`, `reference/`) comes with that clone. The repo is PRIVATE: sign in with `gh auth login` first.
3. Secrets (never in git): copy `~/vsl-portal/claude/.portal_secrets.json` from the mini by AirDrop, `chmod 600`. Without it no request verifies as signed and nothing auto-edits.
4. Drive: `rclone config` -> remote named `gdrive`, scope `drive`, signed in as starsvince@gmail.com. Test: `rclone lsd gdrive: --drive-root-folder-id 1nGlEFhEXjf_x2-Zu3CogYmO_lu3fWjn0`
5. Transcription: `python3 ~/vsl-edit/kit/transcribe_words.py` must run (install the whisper package it imports).
6. LaunchAgents: copy `com.vincestars.vsledit.plist` as is. For the poller create `~/Library/LaunchAgents/com.vincestars.vslportal.plist` running `/usr/bin/python3 ~/vsl-portal/claude/poll.py auto` every 300 s WITH
   `<key>EnvironmentVariables</key><dict><key>VSL_STANDBY_MIN</key><string>15</string></dict>`. Do NOT install the archive agent here.
   Load both with `launchctl bootstrap gui/$(id -u) <plist>`.
7. Prove it: `VSL_STANDBY_MIN=15 python3 ~/vsl-portal/claude/poll.py auto` prints "auto: nothing new"; then the checks in the mini's memory note (signature gate, scoped runner test, a short render through `hf_render.sh`).

Known limit: if the mini dies in the middle of an edit, the request stays `editing` and the standby will not take it. Set the row back to `new` in the queue sheet (or `poll.py update <id> new`) to hand it over.
