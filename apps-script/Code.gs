/**
 * VSL Edit Portal \u2014 Google Apps Script backend.
 * No Supabase, no external DB. Uses two Drive folders + one private Sheet, all in YOUR account.
 *
 * ONE-TIME SETUP:
 *   1. script.google.com -> New project -> paste this file.
 *   2. Run setup()  (authorize Drive + Sheets when prompted).
 *      -> creates: "VSL - Submissions" folder, "VSL - Completions" folder, "VSL Edit Queue" sheet.
 *      -> check Execution log for the SUBMISSIONS folder URL (where you drop videos).
 *   3. Deploy -> New deployment -> type "Web app":
 *        Execute as: Me   |   Who has access: Anyone
 *      Copy the /exec URL and paste it into the interface config (and send it to Claude).
 */

const PROPS = PropertiesService.getScriptProperties();
const VIDEO_RE = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;

// Create the two subfolders INSIDE this parent folder. Leave '' to use My Drive root.
const PARENT_FOLDER_ID = '1nGlEFhEXjf_x2-Zu3CogYmO_lu3fWjn0';

function newFolder_(name) {
  return PARENT_FOLDER_ID
    ? DriveApp.getFolderById(PARENT_FOLDER_ID).createFolder(name)
    : DriveApp.createFolder(name);
}

function setup() {
  let submitId = PROPS.getProperty('SUBMIT_FOLDER_ID');
  let doneId   = PROPS.getProperty('DONE_FOLDER_ID');
  let sheetId  = PROPS.getProperty('SHEET_ID');

  if (!submitId) {
    const f = newFolder_('VSL - Submissions (drop raw videos + inspiration here)');
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); // so Claude can pull by link
    submitId = f.getId(); PROPS.setProperty('SUBMIT_FOLDER_ID', submitId);
  }
  if (!doneId) {
    const f = newFolder_('VSL - Completions (finished edits for review)');
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    doneId = f.getId(); PROPS.setProperty('DONE_FOLDER_ID', doneId);
  }
  if (!sheetId) {
    const ss = SpreadsheetApp.create('VSL Edit Queue');
    const sh = ss.getSheets()[0]; sh.setName('requests');
    sh.appendRow(['id','created','video_id','video_name','inspiration_ids','inspiration_names','change_type','notes','status','result_url','result_name']);
    sheetId = ss.getId(); PROPS.setProperty('SHEET_ID', sheetId);
    if (PARENT_FOLDER_ID) DriveApp.getFileById(sheetId).moveTo(DriveApp.getFolderById(PARENT_FOLDER_ID));
  }
  const out = {
    submissions_folder: DriveApp.getFolderById(submitId).getUrl(),
    completions_folder: DriveApp.getFolderById(doneId).getUrl(),
    queue_sheet:        SpreadsheetApp.openById(sheetId).getUrl()
  };
  Logger.log('>>> DROP RAW VIDEOS HERE: ' + out.submissions_folder);
  Logger.log('>>> Completions (review):  ' + out.completions_folder);
  Logger.log('>>> Queue sheet:           ' + out.queue_sheet);
  return out;
}

// ===== 24/7 email notifier \u2014 runs on Google's servers, works even if your Mac sleeps =====
const NOTIFY_EMAIL = 'starsvince@gmail.com';   // <- change to your preferred address
const NOTIFY_CC    = 'martin@narrowgatefirm.com';   // requester gets the same confirmation

// Run ONCE (like setup) to install the every-5-min checker. Authorize email when prompted.
function installNotifier() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkAndNotify') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkAndNotify').timeBased().everyMinutes(5).create();
  Logger.log('Notifier installed \u2014 emails ' + NOTIFY_EMAIL + ' on new requests.');
  return 'ok';
}

function checkAndNotify() {
  const notified = JSON.parse(PROPS.getProperty('NOTIFIED') || '[]');
  const seen = {}; notified.forEach(x => seen[x] = 1);
  const rows = sheet_().getDataRange().getValues(); rows.shift();
  const fresh = rows.filter(r => r[8] === 'new' && !seen[r[0]]); // col8=status, col0=id
  if (!fresh.length) return;
  fresh.forEach(r => { notified.push(r[0]); });   // emails are sent when the edit starts, not on a timer
  PROPS.setProperty('NOTIFIED', JSON.stringify(notified.slice(-300)));
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'list';
  if (action === 'completions') return json_({ ok: true, files: filesIn_(DriveApp.getFolderById(PROPS.getProperty('DONE_FOLDER_ID'))) });
  if (action === 'queue')       return json_(getQueue_());
  return json_(listSubmissions_()); // submissions (default)
}

// ===== Passwordless login: email a one-time sign-in link on behalf of the Cloudflare Worker. =====
// Only ever emails the two owners, and only a real /auth link on the portal domain, so even a
// direct POST to this public endpoint can't be used to send a phishing link to anyone else.
const LOGIN_ALLOWED = ['starsvince@gmail.com', 'martin@narrowgatefirm.com'];
const LOGIN_LINK_RE = /^https:\/\/edits\.vincestars\.com\/auth\?t=[^\s"'<>]+$/;

function sendMagicLink_(b) {
  const email = String(b.email || '').trim().toLowerCase();
  const link  = String(b.link || '');
  if (LOGIN_ALLOWED.indexOf(email) === -1) return json_({ ok: true });            // silent: no account enumeration
  if (!LOGIN_LINK_RE.test(link))           return json_({ ok: false, error: 'bad link' });
  MailApp.sendEmail(email, 'Your sign-in link \u2014 Edit requests',
    'Click to sign in (the link expires in 15 minutes):\n\n' + link +
    '\n\nIf you did not request this, you can ignore this email.',
    { name: 'Edit Requests', htmlBody:
      '<p style="font:15px/1.5 -apple-system,Arial,sans-serif">Click to sign in (the link expires in 15 minutes):</p>' +
      '<p><a href="' + link + '" style="display:inline-block;background:#1F4FD8;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font:600 15px -apple-system,Arial,sans-serif">Sign in</a></p>' +
      '<p style="color:#5B6472;font:13px/1.5 -apple-system,Arial,sans-serif">Or paste this link into your browser:<br>' + link + '</p>' +
      '<p style="color:#99a;font:12px -apple-system,Arial,sans-serif">If you did not request this, you can ignore this email.</p>' });
  return json_({ ok: true });
}

function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.action === 'magiclink') return sendMagicLink_(b);
    if (b.action === 'notify') return handleNotify_(b);
    if (b.action === 'update') return json_(updateRow_(b.id, b.status, b.result_url, b.result_name));
    const sh = sheet_();
    const id = Utilities.getUuid();
    // Screenshots marked up in the portal: saved to Drive and attached to the request like any reference file.
    b.inspiration_ids = b.inspiration_ids || []; b.inspiration_names = b.inspiration_names || [];
    (b.shots || []).slice(0, 30).forEach(function (s) {
      const name = id.slice(0, 8) + '_' + String(s.name || 'change.jpg').replace(/[^\w.\-]/g, '');
      const f = shotsFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(s.data), 'image/jpeg', name));
      b.inspiration_ids.push(f.getId()); b.inspiration_names.push(name);
    });
    sh.appendRow([
      id, new Date().toISOString(),
      b.video_id || '', b.video_name || '',
      (b.inspiration_ids || []).join(','), (b.inspiration_names || []).join(' | '),
      b.change_type || '', b.notes || '', 'new', '', ''
    ]);
    // clean, human-readable version history (separate tab)
    histSheet_().appendRow([
      new Date().toISOString().slice(0, 16).replace('T', ' '),
      b.video_name || '', (b.inspiration_names || []).join(', '),
      b.change_type || '', b.notes || '', '', 'new', id
    ]);
    // No email here: "We got your request" goes out when the edit actually starts (notify kind 'autostarted'), Vince 2026-10-13.
    return json_({ ok: true, id: id });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}

// Folder for portal screenshots. Lives beside (not inside) Submissions so it never shows up in the reference list.
function shotsFolder_() {
  let id = PROPS.getProperty('SHOTS_FOLDER_ID');
  if (!id) {
    const f = newFolder_('VSL - Edit note screenshots');
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    id = f.getId(); PROPS.setProperty('SHOTS_FOLDER_ID', id);
  }
  return DriveApp.getFolderById(id);
}

function fileObj_(f) {
  return {
    id: f.getId(), name: f.getName(), mime: f.getMimeType(),
    size: f.getSize(), modified: f.getLastUpdated().toISOString(), url: f.getUrl(),
    isVideo: f.getMimeType().indexOf('video') === 0 || VIDEO_RE.test(f.getName())
  };
}

function filesIn_(folder) {
  const it = folder.getFiles(); const out = [];
  while (it.hasNext()) out.push(fileObj_(it.next()));
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

function collectInto_(folder, libName, depth, seen, res) {
  filesIn_(folder).forEach(o => { if (!seen[o.id]) { seen[o.id] = 1; o.lib = libName; res.push(o); } });
  if (depth <= 0) return;
  const it = folder.getFolders();
  while (it.hasNext()) { const sf = it.next(); collectInto_(sf, libName + '/' + sf.getName(), depth - 1, seen, res); }
}

// Inspiration = files in (1) any subfolder of Submissions, and (2) any folder named
// *inspiration* / *assets* anywhere under the parent. Found by NAME, so it works wherever
// you move it. Fully dynamic \u2014 no hardcoded inspiration IDs, add files anytime.
function inspirationFiles_() {
  const seen = {}, res = [];
  const sub = DriveApp.getFolderById(PROPS.getProperty('SUBMIT_FOLDER_ID'));
  const sit = sub.getFolders();
  while (sit.hasNext()) { const sf = sit.next(); collectInto_(sf, sf.getName(), 1, seen, res); }
  if (PARENT_FOLDER_ID) {
    const pit = DriveApp.getFolderById(PARENT_FOLDER_ID).getFolders();
    while (pit.hasNext()) {
      const pf = pit.next();
      if (/inspiration|assets/i.test(pf.getName())) collectInto_(pf, pf.getName(), 2, seen, res);
    }
  }
  return res.sort((a, b) => b.modified.localeCompare(a.modified));
}

function listSubmissions_() {
  const sub = DriveApp.getFolderById(PROPS.getProperty('SUBMIT_FOLDER_ID'));
  const direct = filesIn_(sub);
  return {
    ok: true,
    caps: { upload: true, htmlmail: true, v: 5 },   // tells the portal this backend can save screenshots
    videos: direct.filter(f => f.isVideo),
    inspiration: direct.filter(f => !f.isVideo).concat(inspirationFiles_())
  };
}

function sheet_() { return SpreadsheetApp.openById(PROPS.getProperty('SHEET_ID')).getSheetByName('requests'); }

// Clean version-history tab (auto-created on first submit): Date | Video | Inspirations | Needs | Notes | Output | Status | id
function histSheet_() {
  const ss = SpreadsheetApp.openById(PROPS.getProperty('SHEET_ID'));
  let sh = ss.getSheetByName('history');
  if (!sh) { sh = ss.insertSheet('history'); sh.appendRow(['Date', 'Video', 'Inspirations', 'Needs', 'Notes', 'Output', 'Status', 'id']); }
  return sh;
}
function updateHist_(id, status, resultUrl) {
  const sh = histSheet_(); const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][7] === id) {
      if (resultUrl) sh.getRange(i + 1, 6).setValue(resultUrl);
      if (status)    sh.getRange(i + 1, 7).setValue(status);
      return;
    }
  }
}

function getQueue_() {
  const rows = sheet_().getDataRange().getValues(); rows.shift();
  return { ok: true, requests: rows.map(r => ({
    id: r[0], created: r[1], video_id: r[2], video_name: r[3],
    inspiration_ids: r[4], inspiration_names: r[5],
    change_type: r[6], notes: r[7], status: r[8], result_url: r[9], result_name: r[10]
  })).reverse() };
}

function updateRow_(id, status, resultUrl, resultName) {
  const sh = sheet_(); const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === id) {
      if (status)            sh.getRange(i + 1, 9).setValue(status);
      if (resultUrl != null) sh.getRange(i + 1, 10).setValue(resultUrl);
      if (resultName != null) sh.getRange(i + 1, 11).setValue(resultName);
      updateHist_(id, status, resultUrl);
      return { ok: true };
    }
  }
  return { ok: false, error: 'id not found' };
}

// ===== EMAIL:START \u2014 clean HTML emails for the edit portal (requests, deliveries, status notes) =====
// Recipients are fixed here, never taken from the caller, so the public endpoint cannot be used to mail anyone else.
const MAIL_VINCE  = 'starsvince@gmail.com';
const MAIL_MARTIN = 'martin@narrowgatefirm.com';
const PORTAL_URL  = 'https://edits.vincestars.com';

function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function thumb_(id, w) { return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w' + (w || 480); }
function noExt_(n) { return String(n || '').replace(/\.[a-z0-9]{2,4}$/i, ''); }

// Turn a request's notes (the portal writes ABOUT / CHANGES / REFERENCES / OVERALL DIRECTION blocks) into structure.
function parseRequest_(row) {
  var notes = String(row.notes || ''), by = '';
  var m = notes.match(/\n*Sent from the portal by (\S+) \[[0-9a-f]+\]\s*$/);
  if (m) { by = m[1]; notes = notes.slice(0, m.index); }
  notes = notes.replace(/\r/g, '').trim();
  var out = { by: by, about: '', changes: [], refs: [], direction: '' };
  var re = /^(ABOUT|CHANGES \(\d+\)|REFERENCES|OVERALL DIRECTION)\n/mg, marks = [], mm;
  while ((mm = re.exec(notes)) !== null) marks.push({ name: mm[1].split(' ')[0], start: mm.index, body: mm.index + mm[0].length });
  if (!marks.length) { out.direction = notes; }
  else {
    if (marks[0].start > 0) out.direction = notes.slice(0, marks[0].start).trim();
    marks.forEach(function (k, i) {
      var txt = notes.slice(k.body, i + 1 < marks.length ? marks[i + 1].start : notes.length).trim();
      if (k.name === 'ABOUT') out.about = txt;
      else if (k.name === 'CHANGES') out.changes = parseChanges_(txt);
      else if (k.name === 'REFERENCES') out.refs = txt.split('\n').map(function (l) { return l.replace(/^- /, '').trim(); }).filter(String);
      else out.direction = txt;
    });
  }
  return out;
}
function parseChanges_(txt) {
  var items = [], cur = null;
  txt.split('\n').forEach(function (line) {
    var h = line.match(/^(\d+)\. \[(.*?)\] ?(.*)$/);
    if (h) { cur = { n: +h[1], time: h[2], lines: [h[3]], shot: '' }; items.push(cur); return; }
    if (!cur) return;
    var s = line.match(/\(screenshot attached: (\S+?)\)/);
    if (s) { cur.shot = s[1]; return; }
    if (/^\s*\(he had a screenshot/.test(line)) return;
    cur.lines.push(line.replace(/^ {1,3}/, ''));
  });
  return items.map(function (c) {
    var lines = c.lines.filter(function (l) { return l.trim() !== ''; });
    c.title = lines.shift() || ''; c.body = lines; return c;
  });
}
function timeLabel_(t) {
  t = String(t || '').trim();
  if (!t || /no time/i.test(t)) return 'Whole video';
  return t.replace(/\s+to\s+/i, ' \u2013 ');
}
function cleanBrief_(s, max) {
  s = String(s || '').replace(/^#{1,6}\s*/mg, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '\u2026' : s;
}
function attachMap_(row) {
  var ids = String(row.inspiration_ids || '').split(',').filter(String), names = String(row.inspiration_names || '').split(' | ');
  var shots = {}, refs = [];
  ids.forEach(function (id, i) {
    var nm = names[i] || 'Attachment', s = nm.match(/change-(\d+)\.jpg$/i);
    if (s) shots[+s[1]] = { id: id, name: nm }; else refs.push({ id: id, name: nm });
  });
  return { shots: shots, refs: refs };
}

var C_ = { bg: '#F4F5F7', card: '#FFFFFF', ink: '#14171F', soft: '#5B6472', rule: '#E3E7EC', blue: '#1F4FD8', blueT: '#EEF3FE', green: '#0B6B3A', greenT: '#E3F4EA', amber: '#8A5300', amberT: '#FFF3D6' };
var F_ = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

function chip_(text, kind) {
  var c = { blue: [C_.blueT, C_.blue], green: [C_.greenT, C_.green], amber: [C_.amberT, C_.amber], grey: ['#EEF0F3', C_.soft] }[kind || 'grey'];
  // table cell with bgcolor: survives mail clients that drop CSS "background"
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;"><tr><td bgcolor="' + c[0] + '" style="background-color:' + c[0] + ';border-radius:99px;padding:4px 12px;font-size:13px;font-weight:700;color:' + c[1] + ';' + F_ + '">' + esc_(text) + '</td></tr></table>';
}
function button_(url, label, primary) {
  var bg = primary ? C_.blue : '#FFFFFF', fg = primary ? '#FFFFFF' : C_.ink, bd = primary ? C_.blue : '#C9D0D9';
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin:0 10px 10px 0;"><tr><td bgcolor="' + bg + '" style="background-color:' + bg + ';border:1px solid ' + bd + ';border-radius:9px;">' +
    '<a href="' + esc_(url) + '" style="display:inline-block;padding:13px 24px;font-size:16px;font-weight:700;text-decoration:none;color:' + fg + ';' + F_ + '"><font color="' + fg + '">' + esc_(label) + '</font></a></td></tr></table>';
}
function section_(title, inner) {
  return '<tr><td style="padding:22px 32px 0 32px;"><div style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:' + C_.soft + ';margin-bottom:10px;' + F_ + '">' + esc_(title) + '</div>' + inner + '</td></tr>';
}
function shell_(o) {
  // o: heading, chip(html), sub, body(html rows), buttons(html), links(html), foot
  return '<!doctype html><html><body bgcolor="' + C_.bg + '" style="margin:0;padding:0;background-color:' + C_.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + C_.bg + '" style="background-color:' + C_.bg + ';"><tr><td align="center" style="padding:28px 12px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background-color:#FFFFFF;border:1px solid ' + C_.rule + ';border-radius:14px;">' +
    '<tr><td style="padding:30px 32px 6px 32px;">' + (o.chip || '') +
    '<div style="font-size:26px;line-height:1.25;font-weight:bold;color:' + C_.ink + ';margin:12px 0 4px 0;' + F_ + '">' + esc_(o.heading) + '</div>' +
    (o.sub ? '<div style="font-size:16px;line-height:1.5;color:' + C_.soft + ';' + F_ + '">' + o.sub + '</div>' : '') + '</td></tr>' +
    (o.body || '') +
    (o.buttons ? '<tr><td style="padding:26px 32px 4px 32px;">' + o.buttons + '</td></tr>' : '') +
    (o.links ? '<tr><td style="padding:2px 32px 0 32px;font-size:13px;line-height:1.6;color:' + C_.soft + ';' + F_ + '">' + o.links + '</td></tr>' : '') +
    '<tr><td style="padding:18px 32px 28px 32px;font-size:13px;line-height:1.5;color:' + C_.soft + ';border-top:1px solid ' + C_.rule + ';' + F_ + '">' + (o.foot || 'Edit requests') + '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function changesHtml_(p, att) {
  if (!p.changes.length) return '';
  var rows = p.changes.map(function (c) {
    var shot = att.shots[c.n] ? '<div style="margin-top:12px;"><img src="' + thumb_(att.shots[c.n].id, 560) + '" width="260" alt="Screenshot for change ' + c.n + '" style="display:block;width:260px;max-width:100%;border-radius:8px;border:1px solid ' + C_.rule + ';"></div>' : '';
    var body = c.body.map(function (l) { return '<div style="margin-top:6px;">' + esc_(l.trim()) + '</div>'; }).join('');
    return '<div style="border:1px solid ' + C_.rule + ';border-radius:10px;padding:16px 18px;margin-bottom:12px;">' +
      '<div style="margin-bottom:8px;">' + chip_(timeLabel_(c.time), 'blue') + '</div>' +
      '<div style="font-size:17px;font-weight:700;line-height:1.35;color:' + C_.ink + ';' + F_ + '">' + esc_(c.title) + '</div>' +
      '<div style="font-size:15px;line-height:1.55;color:#2B323D;' + F_ + '">' + body + '</div>' + shot + '</div>';
  }).join('');
  return section_('What was asked (' + p.changes.length + (p.changes.length === 1 ? ' change' : ' changes') + ')', rows);
}
function briefHtml_(p, label) {
  if (!p.direction) return '';
  return section_(label, '<div style="font-size:15px;line-height:1.6;color:#2B323D;white-space:pre-wrap;' + F_ + '">' + esc_(cleanBrief_(p.direction, 1100)) + '</div>' +
    (String(p.direction).length > 1100 ? '<div style="margin-top:8px;font-size:13px;color:' + C_.soft + ';' + F_ + '">Shortened here. The full text is in the portal under Request history.</div>' : ''));
}
function refsHtml_(p, att) {
  var parts = '';
  if (p.refs.length) parts += '<ul style="margin:0 0 12px 0;padding-left:20px;font-size:15px;line-height:1.6;color:#2B323D;' + F_ + '">' + p.refs.map(function (r) { return '<li>' + esc_(r) + '</li>'; }).join('') + '</ul>';
  if (att.refs.length) parts += '<div>' + att.refs.slice(0, 6).map(function (a) {
    return '<div style="display:inline-block;width:132px;margin:0 10px 10px 0;vertical-align:top;"><img src="' + thumb_(a.id, 320) + '" width="132" alt="" style="display:block;width:132px;border-radius:8px;border:1px solid ' + C_.rule + ';">' +
      '<div style="font-size:12px;line-height:1.35;color:' + C_.soft + ';margin-top:4px;' + F_ + '">' + esc_(noExt_(a.name)) + '</div></div>'; }).join('') + '</div>';
  return parts ? section_('References', parts) : '';
}

// ---- time estimate, shown in the "we got your request" email ----
// From the edits delivered so far (2026-10): a new build took 67, 70 and 160 minutes for videos of 5.4, 5.4 and 6.8 minutes;
// a revision of an existing edit took 31 minutes. Raw uploads from the studio camera run a steady 7.6 MB per second,
// so length comes from file size. Edits run one at a time, so requests already waiting are added on.
var EDIT_TZ = 'America/New_York';
function estMinutes_(row) {
  if (/changes to a delivered/i.test(row.change_type || '')) return [30, 60];
  var len = 0;
  try { var sz = DriveApp.getFileById(row.video_id).getSize(); if (sz > 4e8) len = Math.min(15, sz / 7.6e6 / 60); } catch (e) {}
  if (!len) return [60, 180];                                     // unknown length (small or unusual file)
  return [Math.round(12 * len + 10), Math.round(24 * len + 15)];  // download + transcribe + build + render
}
function round5_(m) { return Math.max(5, Math.round(m / 5) * 5); }
function durWords_(m) {
  m = round5_(m); if (m < 60) return m + ' min';
  var h = Math.floor(m / 60), r = m % 60; return h + ' hr' + (r ? ' ' + r + ' min' : '');
}
function estimate_(row) {
  var mine = estMinutes_(row), ahead = 0, low = mine[0], high = mine[1];
  try {
    var rows = sheet_().getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      var r = rowObj_(rows[i]);
      if (r.id === row.id || !r.video_id || (r.status !== 'new' && r.status !== 'editing')) continue;
      if (String(r.created) >= String(row.created)) continue;
      var e = estMinutes_(r); ahead++; low += e[0] * 0.6; high += e[1];   // the one in progress is partly done
    }
  } catch (e2) {}
  var now = new Date().getTime(), a = new Date(now + round5_(low) * 60000), b = new Date(now + round5_(high) * 60000);
  return { low: round5_(low), high: round5_(high), ahead: ahead,
           from: Utilities.formatDate(a, EDIT_TZ, 'EEE h:mm a'), to: Utilities.formatDate(b, EDIT_TZ, 'EEE h:mm a') };
}
function estimateHtml_(est) {
  if (!est) return '';
  return section_('When to expect it',
    '<div style="font-size:18px;font-weight:700;line-height:1.4;color:' + C_.ink + ';' + F_ + '">Between ' + esc_(est.from) + ' and ' + esc_(est.to) + ' ET</div>' +
    '<div style="font-size:15px;line-height:1.55;color:#2B323D;margin-top:4px;' + F_ + '">About ' + esc_(durWords_(est.low)) + ' to ' + esc_(durWords_(est.high)) + ' from now. ' +
    (est.ahead ? 'Edits run one at a time and ' + est.ahead + (est.ahead === 1 ? ' request is' : ' requests are') + ' ahead of this one.' : 'It is being edited now.') +
    ' This is an estimate from past edits, not a promise.</div>');
}
function estimateText_(est) { return est ? '\n\nEstimated ready between ' + est.from + ' and ' + est.to + ' ET (about ' + durWords_(est.low) + ' to ' + durWords_(est.high) + ').' : ''; }

// ---- the emails ----
function requestMail_(row, forWho, est) {
  var p = parseRequest_(row), att = attachMap_(row), isChange = /changes to a delivered/i.test(row.change_type || '');
  var who = p.by ? p.by.split('@')[0] : '';
  var name = noExt_(row.video_name);
  var heading = forWho === 'martin' ? 'We got your request' : (isChange ? 'Changes requested' : 'New edit requested');
  var sub = forWho === 'martin'
    ? 'Editing has started. You will get another email with a review link the moment it is ready.'
    : esc_((who ? who.charAt(0).toUpperCase() + who.slice(1) : 'Someone') + ' sent this ' + (isChange ? 'revision' : 'new request') + '. It stages on your Mac within 5 minutes.');
  var meta = '<tr><td style="padding:18px 32px 0 32px;"><div style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:' + C_.soft + ';' + F_ + '">Video</div>' +
    '<div style="font-size:18px;font-weight:700;color:' + C_.ink + ';margin-top:4px;' + F_ + '">' + esc_(name) + '</div>' +
    '<div style="font-size:14px;color:' + C_.soft + ';margin-top:2px;' + F_ + '">' + esc_(String(row.change_type || '').replace(/^\S*\s?New build/, 'New build')) + '</div></td></tr>';
  var html = shell_({
    chip: chip_(forWho === 'martin' ? 'Received' : 'New request', forWho === 'martin' ? 'green' : 'amber'), heading: heading, sub: sub,
    body: meta + estimateHtml_(est) + changesHtml_(p, att) + briefHtml_(p, p.changes.length ? 'Overall direction' : 'The brief') + refsHtml_(p, att),
    buttons: button_(PORTAL_URL, 'Open the portal', true),
    links: 'Portal: <a href="' + PORTAL_URL + '" style="color:' + C_.blue + ';">' + PORTAL_URL + '</a>',
    foot: 'Every request, with its attachments, is kept under <b>Request history</b> in the portal.'
  });
  var text = heading + '\n' + name + '\n\n' + (p.changes.map(function (c) { return c.n + '. [' + timeLabel_(c.time) + '] ' + c.title; }).join('\n') || cleanBrief_(p.direction, 600)) + estimateText_(est) + '\n\n' + PORTAL_URL;
  return { subject: (forWho === 'martin' ? 'We got your request: ' : (isChange ? 'Changes requested: ' : 'New request: ')) + name, html: html, text: text };
}
function deliveredMail_(row) {
  var p = parseRequest_(row), name = row.result_name || noExt_(row.video_name);
  var asked = p.changes.length ? section_('What you asked for', '<ol style="margin:0;padding-left:22px;font-size:15px;line-height:1.7;color:#2B323D;' + F_ + '">' +
    p.changes.map(function (c) { return '<li>' + esc_(c.title) + ' <span style="color:' + C_.soft + ';">(' + esc_(timeLabel_(c.time)) + ')</span></li>'; }).join('') + '</ol>') : '';
  var html = shell_({
    chip: chip_('Ready for review', 'blue'), heading: noExt_(name), sub: 'Your edit is finished. Watch it, then approve it or ask for changes.',
    body: asked + section_('What to do next', '<div style="font-size:15px;line-height:1.6;color:#2B323D;' + F_ + '">Open the portal, press <b>Watch</b>, and use <b>Approve</b> or <b>Request changes</b>. You can add as many timed notes and screenshots as you like in one request.</div>'),
    buttons: button_(row.result_url, 'Watch the edit', true) + button_(PORTAL_URL, 'Open the portal', false),
    links: 'Video: <a href="' + esc_(row.result_url) + '" style="color:' + C_.blue + ';">' + esc_(row.result_url) + '</a><br>Portal: <a href="' + PORTAL_URL + '" style="color:' + C_.blue + ';">' + PORTAL_URL + '</a>',
    foot: 'File: ' + esc_(name)
  });
  return { subject: 'Ready for review: ' + noExt_(name), html: html, text: 'Your edit is ready for review: ' + row.result_url + '\n\nPortal: ' + PORTAL_URL };
}
function noteMail_(kind, row, note) {
  var kinds = { staged: ['Staged', 'grey', 'Request staged on the Mac', 'The files are downloaded and ready to edit.'],
                autostarted: ['Editing', 'amber', 'Auto-edit started', 'An edit session started on its own.'],
                autoready: ['Review', 'blue', 'Auto-edit ready for your review', 'Nothing has been sent to the client.'],
                autofailed: ['Needs you', 'amber', 'Auto-edit did not finish', 'Open a Claude session to finish it.'] }[kind];
  var name = noExt_(row.video_name);
  var html = shell_({
    chip: chip_(kinds[0], kinds[1]), heading: kinds[2], sub: esc_(kinds[3]),
    body: '<tr><td style="padding:18px 32px 0 32px;"><div style="font-size:18px;font-weight:700;color:' + C_.ink + ';' + F_ + '">' + esc_(name) + '</div></td></tr>' +
      (note ? section_('Details', '<div style="font-size:15px;line-height:1.6;color:#2B323D;white-space:pre-wrap;' + F_ + '">' + esc_(String(note).slice(0, 700)) + '</div>') : ''),
    buttons: button_(PORTAL_URL, 'Open the portal', true), foot: 'Request ' + esc_(String(row.id).slice(0, 8))
  });
  return { subject: kinds[2] + ': ' + name, html: html, text: kinds[2] + ': ' + name + (note ? '\n\n' + String(note).slice(0, 700) : '') };
}
// ===== EMAIL:END =====

// ---- glue: sheet rows -> emails ----
function rowObj_(r) { return { id: r[0], created: r[1], video_id: r[2], video_name: r[3], inspiration_ids: r[4], inspiration_names: r[5], change_type: r[6], notes: r[7], status: r[8], result_url: r[9], result_name: r[10] }; }
function findRow_(id) { const rows = sheet_().getDataRange().getValues(); for (let i = 1; i < rows.length; i++) if (rows[i][0] === id) return rowObj_(rows[i]); return null; }
function sendMail_(to, cc, m) { MailApp.sendEmail({ to: to, cc: cc || '', subject: m.subject, body: m.text, htmlBody: m.html, name: 'Edit Requests' }); }
function sendRequestEmails_(row) {
  const key = 'N_request_' + row.id; if (PROPS.getProperty(key)) return;
  var est = null; try { est = estimate_(row); } catch (e) {}       // never let the estimate block the email
  sendMail_(MAIL_MARTIN, MAIL_VINCE, requestMail_(row, 'martin', est));   // one email; Vince is cc'd (his choice, 2026-10-13)
  PROPS.setProperty(key, '1');
}
// Called by the Mac poller. The caller names only a kind and a row id; recipients and wording come from here.
function handleNotify_(b) {
  const row = findRow_(String(b.id || '')); if (!row) return json_({ ok: false, error: 'id not found' });
  const key = 'N_' + b.kind + '_' + row.id; if (PROPS.getProperty(key)) return json_({ ok: true, skipped: 'already sent' });
  if (b.kind === 'delivered') {
    if (row.status !== 'done' || !row.result_url) return json_({ ok: false, error: 'not delivered yet' });
    sendMail_(MAIL_MARTIN, MAIL_VINCE, deliveredMail_(row));
  } else if (b.kind === 'autostarted') {
    sendRequestEmails_(row);                                   // "We got your request" to Martin, cc Vince, with the time estimate
  } else if (['staged', 'autoready', 'autofailed'].indexOf(b.kind) >= 0) {
    sendMail_(MAIL_VINCE, '', noteMail_(b.kind, row, (b.kind === 'autoready' || b.kind === 'autofailed') ? b.note : ''));
  } else return json_({ ok: false, error: 'unknown kind' });
  PROPS.setProperty(key, '1');
  return json_({ ok: true });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
