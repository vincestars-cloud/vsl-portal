# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Static HTML/CSS/JS, one file, no build step. Hosted as a static site. Backend is a Google Apps Script web app over two Drive folders and one Sheet.

## Users
Martin (martin@narrowgatefirm.com), a marketing operator who commissions video edits for financial-advisor and ministry clients. He uses it at a desk, usually on a laptop, between other work. He is not technical and is not a video editor. Vince reviews everything before it reaches Martin and reads the same queue.

## Product Purpose
Martin drops a raw talking-head video in a Drive folder, asks for an edit, and gets a finished video back. The portal is where he asks, watches the result, and says what to change. Success: one request carries every change he wants, each change points at an exact moment, and nobody has to guess which version is current.

## Positioning
The editor is an AI session, not a person on a call. Notes have to be complete and exact the first time, because nobody will ask a follow-up question.

## Operating Context
- Raw videos and reference files live in Google Drive; finished edits land in a Completions folder.
- A video usually goes through several versions (v1, v2, v3) before it is approved.
- Martin often pastes a long style brief that is the same for every video from a given client.
- Feedback arrives as "at 0:33 to 0:42, do X" and as screenshots of a frame with a note under it.
- Reference videos are picked because of one specific moment in them, not the whole video.

## Capabilities and Constraints
- Reads: list of videos and reference files, list of finished edits, request queue.
- Writes: a new request row; a status update on an existing row.
- Drive thumbnails and the Drive preview player work for link-shared files. The preview player cannot report its current time to the page.
- Screenshot upload from the browser needs the newer backend version; until it is deployed, screenshots travel as timestamps.
- Statuses: new, editing, done, approved, duplicate, failed.

## Brand Commitments
No emojis. Light interface. No animation for its own sake. Plain words, no jargon, nothing over-explained.

## Evidence on Hand
Live data from the Apps Script endpoint (4 raw videos, 22 reference files, 27 finished edits, 24 requests as of 2026-10-09). No testimonials, metrics or marketing claims exist and none should be invented.

## Product Principles
1. A note without a moment attached is a guess. Make attaching the moment the easy path.
2. One video, one place. Versions stack under the video; the newest is the one in front.
3. Never make him retype what he already said. Briefs are reusable.
4. Say what state the work is in, in his words: received, being edited, ready to watch, approved.
