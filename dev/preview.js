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
  ScriptApp: { getService: () => ({ getUrl: () => 'http://localhost:' + PORT + '/exec' }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  // ใช้ตรวจ Google ID token กับ Google จริง (UrlFetchApp เป็นแบบ synchronous จึงเรียกผ่าน curl)
  UrlFetchApp: {
    fetch(url) {
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
function renderIndex() {
  const html = fs.readFileSync(path.join(GAS, 'Index.html'), 'utf8')
    .replace(/<\?!=\s*include_\('(\w+)'\)\s*\?>/g, (_, n) => fs.readFileSync(path.join(GAS, n + '.html'), 'utf8'));
  return html.replace('<head>', '<head>\n' + SHIM);
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
  if (req.url.startsWith('/exec')) {   // API แบบเดียวกับที่ ESP32 เรียก
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
  const sheet = req.url.match(/^\/sheet\/([\w-]+)/);
  if (sheet && books[sheet[1]]) {   // ดูข้อมูลใน Google Sheet จำลองเป็น JSON
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const b = books[sheet[1]], out = {};
    Object.keys(b.sheets).forEach(n => out[n] = b.sheets[n].rows.map(r => r.map(v => v && v.length > 80 ? v.slice(0, 40) + '…' : v)));
    res.end(JSON.stringify(out, null, 1));
    return;
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderIndex());
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => {
  console.log('Cargo Bot preview: http://localhost:' + PORT);
  console.log('เข้าระบบด้วยอีเมลผู้ดูแล: ' + vm.runInContext('ADMIN_EMAILS.join(", ")', ctx));
  console.log('ข้อมูลใน Google Sheet จำลอง: http://localhost:' + PORT + '/sheet/' + defaultId);
  console.log('API ทดลองสำหรับ ESP32: http://localhost:' + PORT + '/exec');
});
