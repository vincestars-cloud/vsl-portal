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

// Inspiration files saved in subfolders (e.g. Assets/Inspiration), up to `depth` levels deep.
function subInspiration_(folder, depth) {
  if (depth <= 0) return [];
  let res = []; const fit = folder.getFolders();
  while (fit.hasNext()) {
    const sf = fit.next();
    filesIn_(sf).forEach(o => { o.lib = sf.getName(); res.push(o); });
    res = res.concat(subInspiration_(sf, depth - 1));
  }
  return res;
}

function listSubmissions_() {
  const sub = DriveApp.getFolderById(PROPS.getProperty('SUBMIT_FOLDER_ID'));
  const direct = filesIn_(sub);
  const lib = subInspiration_(sub, 2); // auto-includes Assets/Inspiration & any other subfolder
  return {
    ok: true,
    videos: direct.filter(f => f.isVideo),
    inspiration: direct.filter(f => !f.isVideo).concat(lib)
  };
}

function sheet_() { return SpreadsheetApp.openById(PROPS.getProperty('SHEET_ID')).getSheetByName('requests'); }

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
      return { ok: true };
    }
  }
  return { ok: false, error: 'id not found' };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
