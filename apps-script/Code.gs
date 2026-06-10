/**
 * VSL Edit Portal — Google Apps Script backend.
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

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'list';
  if (action === 'completions') return json_({ ok: true, files: filesIn_(DriveApp.getFolderById(PROPS.getProperty('DONE_FOLDER_ID'))) });
  if (action === 'queue')       return json_(getQueue_());
  return json_(listSubmissions_()); // submissions (default)
}

function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.action === 'update') return json_(updateRow_(b.id, b.status, b.result_url, b.result_name));
    const sh = sheet_();
    const id = Utilities.getUuid();
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
    return json_({ ok: true, id: id });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
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
// you move it. Fully dynamic — no hardcoded inspiration IDs, add files anytime.
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

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
