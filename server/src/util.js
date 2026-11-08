/* เครื่องมือทั่วไป: เวลาไทย, แฮช, ข้อผิดพลาดของ API, แคชในหน่วยความจำ, คิวเขียนข้อมูล */
const crypto = require('crypto');

const TZ_OFFSET_MS = 7 * 3600e3;   // Asia/Bangkok (ไม่มีเวลาออมแสง)
const pad = n => String(n).padStart(2, '0');

/* รูปแบบเดียวกับ Utilities.formatDate ของ Apps Script ที่ระบบใช้: yyyy MM dd HH mm ss และ H */
function fmt(d, f) {
  const x = new Date(new Date(d).getTime() + TZ_OFFSET_MS);
  if (f === 'H') return String(x.getUTCHours());
  return f.replace('yyyy', x.getUTCFullYear()).replace('MM', pad(x.getUTCMonth() + 1)).replace('dd', pad(x.getUTCDate()))
    .replace('HH', pad(x.getUTCHours())).replace('mm', pad(x.getUTCMinutes())).replace('ss', pad(x.getUTCSeconds()));
}
const dt = v => v instanceof Date && !isNaN(v) ? fmt(v, 'dd/MM/yyyy HH:mm:ss') : '';

const randomHex = () => crypto.randomBytes(32).toString('hex');
const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const hmacHex = (s, key) => crypto.createHmac('sha256', key).update(String(s), 'utf8').digest('hex');
function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class ApiError extends Error {
  constructor(code, message) { super(message); this.apiError = code; }
}
function fail(code, message) { throw new ApiError(code, message); }

/* แคชในหน่วยความจำ (แทน CacheService) */
const mem = new Map();
const cache = {
  get(k) { const e = mem.get(k); if (!e) return null; if (e.x < Date.now()) { mem.delete(k); return null; } return e.v; },
  put(k, v, sec) { mem.set(k, { v, x: Date.now() + sec * 1000 }); },
  remove(k) { mem.delete(k); }
};
setInterval(() => { const now = Date.now(); for (const [k, e] of mem) if (e.x < now) mem.delete(k); }, 60000).unref();

/* คิวเขียนข้อมูลทีละงาน (แทน LockService) สำหรับงานที่ต้องตรวจซ้ำก่อนเขียน */
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const isOn = v => v === true || v === 1 || /^(true|1|yes|y)$/i.test(String(v).trim());
const str = v => String(v === null || v === undefined ? '' : v);

module.exports = { fmt, dt, randomHex, sha256, hmacHex, sameText, ApiError, fail, cache, withLock, isOn, str };
