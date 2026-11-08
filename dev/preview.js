/*
 * ทดลองรันหน้าแอปบนเครื่อง โดยไม่ต้อง Deploy ขึ้น Google
 * ใช้ gas/Code.gs ตัวจริง แต่จำลอง Google Sheet / Drive / Cache ไว้ในหน่วยความจำ (ปิดโปรแกรมแล้วข้อมูลหาย)
 *
 *   node dev/preview.js          แล้วเปิด http://localhost:8080
 *   เริ่มจาก Google Sheet ว่าง (มีแค่ "ชีต1") เหมือนไฟล์จริง เข้าระบบด้วยอีเมลผู้ดูแลใน ADMIN_EMAILS
 */
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), vm = require('vm');
const ROOT = path.join(__dirname, '..'), GAS = path.join(ROOT, 'gas'), PORT = Number(process.env.PORT) || 8080;

/* ---------- จำลองบริการของ Google ---------- */
function mkSheet(name) {
  const rows = [];
  return {
    rows,
    getName: () => name,
    clear: () => { rows.length = 0; },
    getMaxRows: () => Math.max(1000, rows.length),
    appendRow: r => rows.push(r.slice()),
    deleteRow: i => rows.splice(i - 1, 1),
    setFrozenRows() {},
    deleteRows: (i, n) => rows.splice(i - 1, n),
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange(a, b, c, d) {
      if (typeof a === 'string') return { setNumberFormat() {} };
      const range = {
        setFontWeight: () => range,
        setNumberFormat: () => range,
        getValues: () => rows.slice(a - 1, a - 1 + c).map(r => r.slice(b - 1, b - 1 + (d || 1))),
        setValues: v => { v.forEach((r, i) => { const row = rows[a - 1 + i] || (rows[a - 1 + i] = []); r.forEach((x, j) => row[b - 1 + j] = x); }); return range; },
        setValue: x => { rows[a - 1][b - 1] = x; return range; }
      };
      return range;
    }
  };
}
/* Google Sheet ในหน่วยความจำ: สคริปต์ทำตัวเหมือนโปรเจกต์ Apps Script แบบไม่ผูกกับชีต */
const books = {};
function mkBook(name, givenId) {
  const id = givenId || 'sheet' + (Object.keys(books).length + 1), sheets = {};
  return books[id] = {
    sheets,
    getId: () => id, getName: () => name, getUrl: () => 'http://localhost:' + PORT + '/sheet/' + id,
    getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet(n)), setSpreadsheetTimeZone() {},
    getSheets: () => Object.values(sheets), deleteSheet: sh => { delete sheets[sh.getName()]; }
  };
}
const cache = {}, props = {}, photos = {};
const modelPath = path.join(ROOT, 'model', 'cargo_model_weights.b64.txt');
const modelFile = {
  getId: () => 'local-model', getSize: () => fs.statSync(modelPath).size,
  getLastUpdated: () => fs.statSync(modelPath).mtime, getBlob: () => ({ getDataAsString: () => fs.readFileSync(modelPath, 'utf8') })
};
const pad = n => String(n).padStart(2, '0');
const ctx = {
  console,
  SpreadsheetApp: {
    getActive: () => null,
    openById: id => { if (!books[id]) throw new Error('not found'); return books[id]; },
    create: name => mkBook(name)
  },
  // PUBLIC_URL = URL สาธารณะ (เช่น Cloudflare Tunnel) ให้ config.h ของ ESP32 ชี้ไปที่ /api ของ URL นั้น
  // บัญชี Gmail ที่เปิดอยู่ในเบราว์เซอร์ (Apps Script ให้ผ่าน Session) จำลองด้วย GMAIL_USER=อีเมล
  Session: { getActiveUser: () => ({ getEmail: () => process.env.GMAIL_USER || '' }) },
  ScriptApp: { getService: () => ({ getUrl: () => process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/+$/, '') + '/api' : 'http://localhost:' + PORT + '/exec' }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  // ใช้ตรวจ Google ID token กับ Google จริง (UrlFetchApp เป็นแบบ synchronous จึงเรียกผ่าน curl)
  UrlFetchApp: {
    fetch(url) {
      const mock = MOCK_GOOGLE && url.startsWith('https://oauth2.googleapis.com/tokeninfo') && mockTokenInfo(url);
      if (mock) return mock;
      const out = require('child_process').execFileSync('curl', ['-s', '-w', '\n%{http_code}', url], { encoding: 'utf8' });
      const i = out.lastIndexOf('\n');
      return { getResponseCode: () => Number(out.slice(i + 1)), getContentText: () => out.slice(0, i) };
    }
  },
  DriveApp: {
    Access: {}, Permission: {},
    getFilesByName: () => { let done = false; return { hasNext: () => !done, next: () => { done = true; return modelFile; } }; },
    getFileById: id => id === 'local-model' ? modelFile : null,
    getFolderById: () => null,
    createFolder: () => ({
      getId: () => 'local-photos',
      createFile: blob => {
        const id = crypto.randomUUID();
        photos[id] = blob;
        return { setSharing() {}, getUrl: () => 'http://localhost:' + PORT + '/photo/d/' + id };
      }
    })
  },
  ContentService: { MimeType: { JSON: 1 }, createTextOutput: s => ({ setMimeType: () => s }) },
  Utilities: {
    formatDate(d, tz, f) {
      const x = new Date(d.getTime() + 7 * 3600e3);   // Asia/Bangkok
      if (f === 'H') return String(x.getUTCHours());
      return f.replace('yyyy', x.getUTCFullYear()).replace('MM', pad(x.getUTCMonth() + 1)).replace('dd', pad(x.getUTCDate()))
        .replace('HH', pad(x.getUTCHours())).replace('mm', pad(x.getUTCMinutes())).replace('ss', pad(x.getUTCSeconds()));
    },
    computeDigest: (a, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => b > 127 ? b - 256 : b),
    DigestAlgorithm: {}, Charset: {},
    computeHmacSha256Signature: (s, key) => [...crypto.createHmac('sha256', key).update(s, 'utf8').digest()].map(b => b > 127 ? b - 256 : b),
    getUuid: () => crypto.randomUUID(),
    base64Decode: s => Buffer.from(s, 'base64'),
    newBlob: (bytes, type) => ({ bytes, type })
  }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(GAS, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
// จำลอง Google Sheet ฐานข้อมูลหลัก (DEFAULT_SPREADSHEET_ID) ให้ว่างเหมือน Sheet ใหม่
const defaultId = vm.runInContext('DEFAULT_SPREADSHEET_ID', ctx);
if (defaultId) mkBook('Database Cargo', defaultId).insertSheet('ชีต1');

/* ---------- หน้าเว็บ + google.script.run จำลอง ---------- */
/* MOCK_GOOGLE=1: จำลอง Google Sign-In ทั้งปุ่ม/One Tap (google.accounts.id) และการตรวจ token (tokeninfo)
   ไม่ต้องมี Client ID จริง และเปิด Google Sign-In ไว้ตั้งแต่เริ่ม
   ปุ่มจำลองแสดงรายการบัญชีให้กดเลือก (บัญชีในชีต Users) แล้วสร้าง credential "mock.<base64url JSON>.sig"
   One Tap จำลอง: จำบัญชีล่าสุดใน localStorage แล้วเข้าระบบให้เอง จนกว่าจะกดออกจากระบบ */
const MOCK_GOOGLE = process.env.MOCK_GOOGLE === '1';
const MOCK_CLIENT_ID = 'preview-mock.apps.googleusercontent.com';
if (MOCK_GOOGLE) props.GOOGLE_CLIENT_ID = MOCK_CLIENT_ID;   // เปิด Google Sign-In (จำลอง) ตั้งแต่เริ่ม
function mockTokenInfo(url) {
  const tok = new URL(url).searchParams.get('id_token') || '';
  if (!tok.startsWith('mock.')) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  const info = Object.assign({ iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 3600), email_verified: 'true' }, claims);
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify(info) };
}
const GIS_MOCK = `<script>
(function () {
  const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
  const id = window.google.accounts = { id: {
    initialize(cfg) { this.cfg = cfg; },
    signIn(email) {
      ls.set('mockGoogleLast', email); ls.set('mockGoogleNoAuto', null);
      const claims = { email, name: email.split('@')[0], aud: this.cfg.client_id };
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(claims)))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      this.cfg.callback({ credential: 'mock.' + b64 + '.sig' });
    },
    async chooser() {   // จำลองหน้าเลือกบัญชีของ Google: กดเลือก ไม่ต้องพิมพ์
      if (window.__mockGoogleEmail) return this.signIn(window.__mockGoogleEmail);
      const list = await fetch('/dev/accounts').then(r => r.json()).catch(() => []);
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:99';
      box.innerHTML = '<div style="background:#fff;color:#16202c;border-radius:12px;padding:18px;width:min(340px,90vw);font:15px sans-serif">' +
        '<b>เลือกบัญชี (Google จำลอง)</b><div class="acc" style="display:flex;flex-direction:column;gap:6px;margin-top:10px"></div>' +
        '<button type="button" class="other" style="margin-top:10px">ใช้บัญชีอื่น</button> <button type="button" class="x">ยกเลิก</button></div>';
      list.forEach(a => {
        const b = document.createElement('button'); b.type = 'button'; b.style.cssText = 'text-align:left;padding:8px;border:1px solid #d9dee5;border-radius:8px;background:#f3f5f7;cursor:pointer';
        b.innerHTML = '<b></b><br><small></small>'; b.querySelector('b').textContent = a.name; b.querySelector('small').textContent = a.email;
        b.onclick = () => { box.remove(); this.signIn(a.email); }; box.querySelector('.acc').appendChild(b);
      });
      box.querySelector('.other').onclick = () => { const e = prompt('อีเมล Google'); box.remove(); if (e) this.signIn(e); };
      box.querySelector('.x').onclick = () => box.remove();
      document.body.appendChild(box);
    },
    renderButton(el) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'b'; b.textContent = 'ลงชื่อเข้าใช้ด้วย Google (จำลอง)';
      b.onclick = () => this.chooser(); el.appendChild(b);
    },
    prompt() {   // One Tap: เคยเลือกบัญชีแล้ว และไม่ได้กดออกจากระบบ → เข้าให้เอง
      const last = ls.get('mockGoogleLast');
      if (this.cfg && this.cfg.auto_select && last && !ls.get('mockGoogleNoAuto')) setTimeout(() => this.signIn(last), 300);
    },
    disableAutoSelect() { ls.set('mockGoogleNoAuto', '1'); }
  } };
})();
</script>`;

const SHIM = `<script>
window.google = { script: { get run() {
  let ok = () => {}, fail = () => {};
  const runner = {
    withSuccessHandler(f) { ok = f; return runner; },
    withFailureHandler(f) { fail = f; return runner; },
    rpc(action, params, session) {
      fetch('/rpc', { method: 'POST', body: JSON.stringify({ action, params, session }) })
        .then(r => r.json()).then(ok, fail);
    }
  };
  return runner;
} } };
</script>`;
/* MOCK_LOGIN_APP=1: จำลองแอปยืนยันตัวตน gas-login ที่ /dev/login (เลือกบัญชี แล้วส่ง ticket ที่เซ็นแล้วกลับมา /?t=) */
const MOCK_LOGIN_APP = process.env.MOCK_LOGIN_APP === '1';
if (MOCK_LOGIN_APP) { props.LOGIN_SECRET = crypto.randomBytes(32).toString('hex'); props.LOGIN_APP_URL = '/dev/login'; }
function mockTicket(email) {
  const body = email + '~' + (Date.now() + 5 * 60 * 1000);
  return body + '~' + crypto.createHmac('sha256', props.LOGIN_SECRET).update(body).digest('hex');
}
function renderIndex(ticket) {
  const html = fs.readFileSync(path.join(GAS, 'Index.html'), 'utf8')
    .replace(/<\?!=\s*include_\('(\w+)'\)\s*\?>/g, (_, n) => fs.readFileSync(path.join(GAS, n + '.html'), 'utf8'))
    .replace('<?= loginTicket ?>', /^[^~\s<>"'\\]+~\d+~[0-9a-f]{64}$/.test(ticket || '') ? ticket : '');
  return html.replace('<head>', '<head>\n' + SHIM + (MOCK_GOOGLE ? GIS_MOCK : ''));
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { action, params, session } = JSON.parse(body || '{}');
      const out = ctx.rpc(action, params, session);   // ฟังก์ชัน rpc ตัวจริงใน Code.gs
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.url.startsWith('/exec') || req.url.startsWith('/api')) {   // API แบบเดียวกับที่ ESP32 เรียก (/api = แบบผ่าน Cloudflare Worker)
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const e = { parameter: Object.fromEntries(u.searchParams), postData: body ? { contents: body } : null };
      const out = req.method === 'POST' ? ctx.doPost(e) : ctx.doGet(e);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
    return;
  }
  const photo = req.url.match(/^\/photo\/d\/([\w-]+)/) || req.url.match(/[?&]id=([\w-]+)/);
  if (photo && photos[photo[1]]) {
    res.writeHead(200, { 'Content-Type': photos[photo[1]].type });
    res.end(photos[photo[1]].bytes);
    return;
  }
  if (req.url === '/dev/clear-cache') {   // จำลองแคชของ Apps Script หมดอายุ (เกิน 6 ชั่วโมง)
    Object.keys(cache).forEach(k => delete cache[k]);
    res.writeHead(200); res.end('cache cleared');
    return;
  }
  if (req.url === '/dev/accounts') {   // บัญชีให้เลือกในหน้าเลือกบัญชี Google จำลอง: ผู้ดูแลถาวร + บัญชีในชีต Users
    const users = (books[defaultId] && books[defaultId].sheets.Users) ? books[defaultId].sheets.Users.rows.slice(1) : [];
    const list = users.map(r => ({ email: String(r[0]), name: String(r[1] || r[0]) }));
    vm.runInContext('ADMIN_EMAILS', ctx).forEach(e => { if (!list.some(a => a.email === e)) list.unshift({ email: e, name: e }); });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(list));
    return;
  }
  const sheet = req.url.match(/^\/sheet\/([\w-]+)/);
  if (sheet && books[sheet[1]]) {   // ดูข้อมูลใน Google Sheet จำลองเป็น JSON
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const b = books[sheet[1]], out = {};
    Object.keys(b.sheets).forEach(n => out[n] = b.sheets[n].rows.map(r => r.map(v => v && v.length > 80 ? v.slice(0, 40) + '…' : v)));
    res.end(JSON.stringify(out, null, 1));
    return;
  }
  if (MOCK_LOGIN_APP && req.url.startsWith('/dev/login')) {   // แอปยืนยันตัวตนจำลอง: ?as=อีเมล = Google ยืนยันว่าเป็นบัญชีนี้
    const as = new URL(req.url, 'http://x').searchParams.get('as');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (as) return res.end('<p>Google ยืนยันแล้ว: ' + as.replace(/[<>&"]/g, '') + '</p><a id="go" href="/?t=' + encodeURIComponent(mockTicket(as.toLowerCase())) + '">เข้าสู่ Cargo Bot</a>');
    return res.end('<form><b>เลือกบัญชี Google (จำลอง)</b><br><input name="as" type="email" placeholder="อีเมล"><button>ต่อไป</button></form>');
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderIndex(new URL(req.url, 'http://x').searchParams.get('t')));
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => {
  console.log('Cargo Bot preview: http://localhost:' + PORT);
  console.log('เข้าระบบด้วยอีเมลผู้ดูแล: ' + vm.runInContext('ADMIN_EMAILS.join(", ")', ctx));
  console.log('ข้อมูลใน Google Sheet จำลอง: http://localhost:' + PORT + '/sheet/' + defaultId);
  console.log('API ทดลองสำหรับ ESP32: http://localhost:' + PORT + '/exec');
});
