/**
 * Cargo Bot — Google Apps Script Web App
 * ฐานข้อมูลคือ Google Sheet (DEFAULT_SPREADSHEET_ID)
 *
 * หน้าแอป:   เปิด <WEB_APP_URL> ในเบราว์เซอร์ เข้าสู่ระบบด้วยอีเมลที่ลงทะเบียนในชีต Users
 *            บอร์ด ESP32 ใช้ Token ระบบอันเดียว (ผู้ดูแลดู/สร้างใหม่ได้ในเมนู "เชื่อมต่อ ESP32")
 *            หน้าเว็บเรียกเซิร์ฟเวอร์ผ่าน google.script.run.rpc(action, params, session)
 *
 * API (ESP32 / ระบบอื่น):
 *            POST <WEB_APP_URL>   body JSON (Content-Type: text/plain)
 *              {"token":"cb_...","action":"saveMove","code":"TABLE","qty":2}
 *            GET  <WEB_APP_URL>?action=products&token=cb_...
 * ตอบกลับ:   {"ok":true, ...}  หรือ  {"ok":false,"error":"<รหัส>","message":"<ข้อความ>"}
 *            Apps Script ตอบ HTTP 200 เสมอ ให้ตรวจที่ ok
 */

const TZ = 'Asia/Bangkok';
const SESSION_SEC = 21600;           // เซสชันหน้าเว็บ 6 ชั่วโมง (นับใหม่ทุกครั้งที่ใช้งาน)
const MODEL_FILE = 'cargo_model_weights.b64.txt';
const MODEL_CHUNK = 1000000;
// Google Sheet ฐานข้อมูล (Script Property SPREADSHEET_ID ใช้แทนได้ถ้าต้องการเปลี่ยนโดยไม่แก้โค้ด)
// "Database Cargo (ระบบบันทึกการขนส่ง)" สร้างจาก dev/build_db.py พร้อมทุกชีตและฟิลด์
const DEFAULT_SPREADSHEET_ID = '1_8C6v41tTDqwMaEhVT1ZM1j2VzEI-aZS3PfTtegj4Ko';
// ผู้ดูแลระบบถาวร: เข้าระบบครั้งแรกจะถูกสร้างบัญชีให้อัตโนมัติ และลดสิทธิ์/ปิด/ลบบัญชีจากหน้าแอปไม่ได้
const ADMIN_EMAILS = ['phatthachada.k@gmail.com'];
// ไม่บังคับ: ใส่ Client ID ของ Google เพื่อแสดงปุ่ม "Sign in with Google" เพิ่มจากการเข้าด้วยอีเมล
const DEFAULT_GOOGLE_CLIENT_ID = '';
// โดเมนของ Cloudflare Worker เช่น 'https://cargo.example.com' ("" = ใช้ URL /exec ของ Apps Script ตรง ๆ)
// ตั้งเป็น Script Property PUBLIC_BASE_URL แทนได้โดยไม่ต้องแก้โค้ด
const PUBLIC_BASE_URL = '';

const SHEETS = {
  Products: ['Code', 'Name', 'Unit', 'Active'],
  Moves: ['Timestamp', 'Code', 'Name', 'Qty', 'Unit', 'Mover', 'Pickup', 'Dropoff', 'Method', 'Score', 'Source', 'Photo', 'ReqId', 'AssignId'],
  Assignments: ['Id', 'Email', 'Pickup', 'Dropoff', 'Note', 'Status', 'CreatedAt', 'CreatedBy', 'UpdatedAt'],
  Places: ['Id', 'Name', 'Type', 'Active', 'CreatedAt', 'CreatedBy'],
  Users: ['Email', 'Name', 'Role', 'Active', 'LastLogin', 'CreatedAt'],
  Devices: ['DeviceId', 'Name', 'Role', 'TokenHash', 'Active', 'LastSeen', 'Firmware', 'Info', 'CreatedAt', 'Owner'],
  Refs: ['Id', 'Code', 'Name', 'Vec', 'Thumb', 'AddedBy', 'Timestamp']
};

/* คำอธิบายฟิลด์ (เขียนลงชีต "คำอธิบายฟิลด์" ตอน setup) */
const DOC_SHEET = 'คำอธิบายฟิลด์';
const FIELD_DOCS = {
  Moves: ['บันทึกการขนส่ง', {
    Timestamp: ['วันเวลาที่บันทึก', '07/11/2026 09:30:00'],
    Code: ['รหัสอุปกรณ์ (อ้างอิง Products.Code)', 'TABLE'],
    Name: ['ชื่ออุปกรณ์', 'โต๊ะ'],
    Qty: ['จำนวนที่ขนส่ง', '4'],
    Unit: ['หน่วยนับ', 'ตัว'],
    Mover: ['ชื่อผู้ขนส่ง', 'สมชาย ใจดี'],
    Pickup: ['สถานที่รับ', 'โกดัง A'],
    Dropoff: ['สถานที่ส่ง', 'ห้องประชุมชั้น 3'],
    Method: ['วิธีระบุอุปกรณ์', 'ภาพถ่าย / เลือกเอง / สแกน QR / ผู้ดูแลเพิ่ม'],
    Score: ['ความคล้ายของภาพถ่าย (%)', '73'],
    Source: ['ผู้บันทึก: web:อีเมล / admin:อีเมล / รหัสบอร์ด ESP32', 'web:somchai@cargo.co'],
    Photo: ['ลิงก์ภาพถ่ายใน Google Drive', 'https://drive.google.com/...'],
    ReqId: ['รหัสรายการ (ไม่ซ้ำ ใช้แก้ไข/ลบ)', 'm_3f9a1c...'],
    AssignId: ['งานที่มอบหมาย (อ้างอิง Assignments.Id) ว่าง = ไม่ได้มาจากงานที่มอบหมาย', 'a_51c0e2...']
  }],
  Places: ['สถานที่รับ / สถานที่ส่ง (ตัวเลือกในฟอร์ม)', {
    Id: ['รหัสสถานที่', 'p_9c1e0a...'],
    Name: ['ชื่อสถานที่', 'โกดัง A'],
    Type: ['ประเภท: pickup = สถานที่รับ, dropoff = สถานที่ส่ง, both = ใช้ได้ทั้งสองแบบ', 'pickup'],
    Active: ['ใช้งานอยู่ (TRUE/FALSE)', 'TRUE'],
    CreatedAt: ['วันที่เพิ่ม', '07/11/2026 08:00:00'],
    CreatedBy: ['ผู้ดูแลที่เพิ่ม', 'phatthachada.k@gmail.com']
  }],
  Assignments: ['งานที่มอบหมาย (สถานที่รับ-ส่งของพนักงาน)', {
    Id: ['รหัสงาน', 'a_51c0e2...'],
    Email: ['อีเมลพนักงานที่ได้รับมอบหมาย', 'somchai@cargo.co'],
    Pickup: ['สถานที่รับ', 'โกดัง A'],
    Dropoff: ['สถานที่ส่ง', 'ห้องประชุมชั้น 3'],
    Note: ['หมายเหตุจากผู้ดูแล', 'ส่งก่อน 10 โมง'],
    Status: ['สถานะ: open = กำลังทำ, done = เสร็จแล้ว', 'open'],
    CreatedAt: ['วันที่มอบหมาย', '07/11/2026 08:00:00'],
    CreatedBy: ['ผู้ดูแลที่มอบหมาย', 'phatthachada.k@gmail.com'],
    UpdatedAt: ['แก้ไขล่าสุด', '07/11/2026 08:30:00']
  }],
  Users: ['บัญชีผู้ใช้งาน', {
    Email: ['อีเมลที่ใช้เข้าสู่ระบบ', 'somchai@cargo.co'],
    Name: ['ชื่อ-นามสกุล', 'สมชาย ใจดี'],
    Role: ['สิทธิ์: user = พนักงาน, admin = ผู้ดูแลระบบ', 'user'],
    Active: ['เปิดใช้งานบัญชี (TRUE/FALSE)', 'TRUE'],
    LastLogin: ['เข้าระบบล่าสุด', '07/11/2026 08:00:00'],
    CreatedAt: ['วันที่สร้างบัญชี', '01/11/2026 10:00:00']
  }],
  Products: ['อุปกรณ์ที่ขนส่ง', {
    Code: ['รหัสอุปกรณ์ (A-Z 0-9)', 'TABLE'],
    Name: ['ชื่ออุปกรณ์', 'โต๊ะ'],
    Unit: ['หน่วยนับ', 'ตัว'],
    Active: ['ใช้งานอยู่ (TRUE/FALSE)', 'TRUE']
  }],
  Devices: ['บอร์ด ESP32 (ทุกบอร์ดใช้ Token ระบบอันเดียว ระบบเพิ่มบอร์ดให้เองเมื่อติดต่อครั้งแรก)', {
    DeviceId: ['รหัสบอร์ด (DEVICE_ID ใน config.h)', 'ESP32-01'],
    Name: ['ชื่อบอร์ด (ใช้เป็นชื่อผู้ขนส่ง ถ้าไม่ได้กำหนดพนักงาน)', 'ESP32-01'],
    Role: ['ชนิด', 'device'],
    TokenHash: ['ไม่ใช้แล้ว (Token ระบบเก็บใน Script Properties: SYSTEM_TOKEN)', ''],
    Active: ['อนุญาตให้บอร์ดส่งข้อมูล (FALSE = ผู้ดูแลบล็อกไว้)', 'TRUE'],
    LastSeen: ['บอร์ดติดต่อล่าสุด', '07/11/2026 09:31:00'],
    Firmware: ['เวอร์ชันเฟิร์มแวร์', '1.0.0'],
    Info: ['สถานะบอร์ดล่าสุด (IP, สัญญาณ WiFi, คิว)', '{"rssi":-58}'],
    CreatedAt: ['วันที่บอร์ดติดต่อครั้งแรก', '07/11/2026 09:00:00'],
    Owner: ['อีเมลพนักงานที่ใช้บอร์ดนี้ (ผู้ดูแลกำหนด) บันทึกจากบอร์ดจะเป็นชื่อพนักงานคนนี้', 'somchai@cargo.co']
  }],
  Refs: ['ภาพที่ใช้จดจำอุปกรณ์', {
    Id: ['รหัสภาพ', '1a2b3c4d'],
    Code: ['รหัสอุปกรณ์', 'CHAIR'],
    Name: ['ชื่ออุปกรณ์', 'เก้าอี้'],
    Vec: ['ลักษณะเฉพาะของภาพ (ข้อมูลสำหรับระบบจดจำ)', '(ข้อความยาว)'],
    Thumb: ['ภาพย่อ', '(data:image/jpeg...)'],
    AddedBy: ['ผู้เพิ่มภาพ', 'สมชาย ใจดี'],
    Timestamp: ['วันที่เพิ่มภาพ', '07/11/2026 09:30:00']
  }]
};

const SEED_PRODUCTS = [
  ['TABLE', 'โต๊ะ', 'ตัว'], ['CHAIR', 'เก้าอี้', 'ตัว'], ['SOFA', 'โซฟา', 'ตัว'],
  ['STAND', 'แท่น', 'แท่น'], ['WATER', 'ขวดน้ำ', 'ขวด']
];

/* สิทธิ์: user = พนักงาน, admin = ผู้ดูแลระบบ (บัญชีในชีต Users); device/web = Token ในชีต Devices สำหรับ API ภายนอก */
const ROLES = {
  device: ['ping', 'heartbeat', 'products', 'lookup', 'saveMove'],
  web: ['ping', 'products', 'lookup', 'saveMove', 'dashboard'],
  user: ['ping', 'me', 'logout', 'products', 'lookup', 'places', 'saveMove', 'dashboard',
    'refs', 'addRef', 'modelInfo', 'modelChunk', 'myAssignments'],
  admin: ['*']
};
const ROLE_TH = { user: 'พนักงาน', admin: 'ผู้ดูแลระบบ' };
const PUBLIC = ['emailLogin', 'googleLogin', 'authConfig'];

const ACTIONS = {
  ping: () => ({ message: 'pong' }),
  heartbeat: () => ({ intervalSec: 60 }),
  emailLogin: emailLogin_,
  googleLogin: googleLogin_,
  authConfig: () => ({ googleClientId: googleClientId_() }),
  me: (p, who) => ({ user: publicUser_(who) }),
  logout: p => { CacheService.getScriptCache().remove('ses:' + p.session); return {}; },
  products: () => ({ products: getProducts_() }),
  lookup: p => ({ product: findProduct_(p.code) }),
  places: () => getPlaces_(),
  allPlaces: () => ({ places: listPlaces_() }),
  savePlace: savePlace_,
  deletePlace: deletePlace_,
  saveMove: saveMove_,
  dashboard: p => getDashboardData_(String(p.range || 'today')),
  refs: p => ({ refs: getRefs_(p.code) }),
  addRef: addRef_,
  addProduct: addProduct_,
  modelInfo: modelInfo_,
  modelChunk: p => ({ data: modelText_().substr(Math.max(0, Math.floor(Number(p.i) || 0)) * MODEL_CHUNK, MODEL_CHUNK) }),
  // ESP32: ผู้ใช้ขอ Token ของตัวเอง (ผู้ดูแลเห็นและปิดได้ทุกเครื่อง)
  myAssignments: (p, who) => ({ assignments: listAssignments_({ email: who.email, status: 'open' }) }),
  // ผู้ดูแลระบบ
  assignments: p => ({ assignments: listAssignments_(p) }),
  saveAssignment: saveAssignment_,
  deleteAssignment: deleteAssignment_,
  moves: p => ({ moves: listMoves_(p) }),
  addMove: addMove_,
  updateMove: updateMove_,
  deleteMove: deleteMove_,
  users: () => ({ users: listUsers_() }),
  saveUser: saveUser_,
  deleteUser: deleteUser_,
  allProducts: () => ({ products: listAllProducts_() }),
  saveProduct: saveProduct_,
  deleteRef: deleteRef_,
  // ESP32: Token เดียวทั้งระบบ
  systemToken: () => ({ token: systemToken_(false), apiUrl: apiUrl_(), devices: listDevices_() }),
  regenToken: () => ({ token: systemToken_(true), apiUrl: apiUrl_() }),
  setDevice: setDevice_,
  deleteDevice: deleteDevice_
};

/* ---------- entry points ---------- */
function doGet(e) {
  const p = Object.assign({}, e && e.parameter);
  if (!p.action) {
    return HtmlService.createTemplateFromFile('Index').evaluate()
      .setTitle('Cargo Bot ขนส่งอุปกรณ์')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);   // ให้หน้า Cloudflare Worker (โดเมนของเรา) แสดงแอปได้
  }
  return respond_(handle_(p));
}

function doPost(e) {
  let body = {};
  const raw = e && e.postData && e.postData.contents;
  if (raw) {
    try { body = JSON.parse(raw); } catch (err) { return respond_({ ok: false, error: 'bad_json', message: 'body ต้องเป็น JSON' }); }
  }
  return respond_(handle_(Object.assign({}, e && e.parameter, body)));
}

/* เรียกจากหน้าเว็บด้วย google.script.run */
function rpc(action, params, session) {
  return handle_(Object.assign({}, params, { action: action, session: session || '' }));
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* เพิ่มชีต/ฟิลด์ใหม่ให้ Google Sheet อัตโนมัติเมื่อโครงสร้างใน SHEETS เปลี่ยน (ตรวจครั้งเดียวต่อเวอร์ชัน) */
function ensureSchema_() {
  const props = PropertiesService.getScriptProperties();
  const ver = sha256_(JSON.stringify(SHEETS)).slice(0, 12) + ':' + dbId_();
  if (props.getProperty('SCHEMA_VERSION') === ver) return;
  setup();
  props.setProperty('SCHEMA_VERSION', ver);
}

function handle_(p) {
  try {
    const action = String(p.action || '');
    if (!ACTIONS[action]) fail_('unknown_action', 'ไม่รู้จักคำสั่ง "' + action + '"');
    ensureSchema_();
    let who = null;
    if (PUBLIC.indexOf(action) < 0) {
      who = p.session ? session_(p.session) : auth_(p.token, p);
      const allowed = ROLES[who.role] || [];
      if (allowed.indexOf('*') < 0 && allowed.indexOf(action) < 0) fail_('forbidden', 'สิทธิ์ ' + who.role + ' ใช้คำสั่ง ' + action + ' ไม่ได้');
      if (who.kind === 'token') touch_(who, p, action === 'heartbeat');
    }
    return Object.assign({ ok: true, action: action, serverTime: fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss') }, ACTIONS[action](p, who));
  } catch (err) {
    if (err && err.apiError) return { ok: false, error: err.apiError, message: err.message };
    console.error(err);
    return { ok: false, error: 'server_error', message: String((err && err.message) || err) };
  }
}

function respond_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const e = new Error(message);
  e.apiError = code;
  throw e;
}

/* ---------- Token ระบบ (ESP32 / ระบบภายนอก): Token เดียวทั้งระบบ แยกบอร์ดด้วย deviceId ---------- */
/* เก็บใน Script Properties (SYSTEM_TOKEN) ผู้ดูแลดู/คัดลอก/สร้างใหม่ได้ในเมนู "เชื่อมต่อ ESP32" */
function systemToken_(regen) {
  const props = PropertiesService.getScriptProperties();
  let t = props.getProperty('SYSTEM_TOKEN');
  if (!t || regen) {
    t = 'cb_' + randomHex_();
    props.setProperty('SYSTEM_TOKEN', t);
  }
  return t;
}

function deviceIdOf_(p) {
  const id = String(p.deviceId || '').trim();
  return /^[A-Za-z0-9_.-]{1,32}$/.test(id) ? id : 'ESP32';
}

function auth_(token, p) {
  token = String(token || '').trim();
  if (!token) fail_('unauthorized', 'ไม่ได้ส่ง token');
  const sys = PropertiesService.getScriptProperties().getProperty('SYSTEM_TOKEN');
  if (!sys || token !== sys) fail_('unauthorized', 'Token ไม่ถูกต้อง (ผู้ดูแลอาจสร้าง Token ใหม่แล้ว)');
  const id = deviceIdOf_(p);
  const row = readRows_('Devices').find(r => String(r.DeviceId).toLowerCase() === id.toLowerCase());
  if (row && !isOn_(row.Active)) fail_('unauthorized', 'บอร์ด ' + id + ' ถูกผู้ดูแลระบบบล็อกไว้');
  // บอร์ดที่ผู้ดูแลกำหนดพนักงานไว้: บันทึกในชื่อพนักงานคนนั้น และใช้งานที่มอบหมายของเขา
  const owner = row && row.Owner ? findUser_(row.Owner) : null;
  return {
    kind: 'token', deviceId: id, role: 'device',
    name: owner ? String(owner.Name || owner.Email) : (row && String(row.Name).trim() ? String(row.Name) : id),
    owner: owner ? String(owner.Email).toLowerCase() : ''
  };
}

/* บันทึกบอร์ดที่ติดต่อเข้ามา (บอร์ดใหม่ถูกเพิ่มในชีต Devices อัตโนมัติ) เขียนชีตไม่เกินนาทีละครั้ง ยกเว้น heartbeat */
function touch_(who, p, force) {
  const cache = CacheService.getScriptCache(), key = 'seen:' + who.deviceId.toLowerCase();
  if (!force && cache.get(key)) return;
  const upd = { LastSeen: new Date() };
  if (p.fw) upd.Firmware = text_(p.fw);
  if (force) upd.Info = text_(JSON.stringify({ ip: p.ip, rssi: p.rssi, uptime: p.uptime, queue: p.queue, heap: p.heap }));
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const row = readRows_('Devices').find(r => String(r.DeviceId).toLowerCase() === who.deviceId.toLowerCase());
    if (row) setCells_('Devices', row._row, upd);
    else appendRow_('Devices', Object.assign({ DeviceId: text_(who.deviceId), Name: text_(who.deviceId), Role: 'device', Active: true, CreatedAt: new Date() }, upd));
  } finally {
    lock.releaseLock();
  }
  cache.put(key, '1', 60);
}

/* ผู้ดูแล: กำหนดพนักงานที่ใช้บอร์ด / บล็อก-ปลดบล็อกบอร์ด */
function setDevice_(p) {
  const row = readRows_('Devices').find(r => String(r.DeviceId) === String(p.deviceId));
  if (!row) fail_('not_found', 'ไม่พบบอร์ด ' + p.deviceId);
  const upd = {};
  if (p.owner !== undefined) {
    const email = String(p.owner || '').trim().toLowerCase();
    if (email && !findUser_(email)) fail_('not_found', 'ไม่พบพนักงาน ' + email);
    upd.Owner = email;
  }
  if (p.active !== undefined) upd.Active = !!p.active;
  setCells_('Devices', row._row, upd);
  return {};
}

function deleteDevice_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const row = readRows_('Devices').find(r => String(r.DeviceId) === String(p.deviceId));
    if (!row) fail_('not_found', 'ไม่พบบอร์ด ' + p.deviceId);
    sheet_('Devices').deleteRow(row._row);   // ถ้าบอร์ดยังติดต่อเข้ามาด้วย Token ปัจจุบัน จะถูกเพิ่มกลับเอง
  } finally {
    lock.releaseLock();
  }
  return {};
}

/* URL ที่บอร์ดต้องเรียก: ผ่าน Cloudflare Worker ถ้าตั้ง PUBLIC_BASE_URL ไว้ (→ /api) ไม่อย่างนั้นใช้ /exec ของ Apps Script */
function apiUrl_() {
  const base = (PropertiesService.getScriptProperties().getProperty('PUBLIC_BASE_URL') || PUBLIC_BASE_URL).replace(/\/+$/, '');
  if (base) return base + '/api';
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function listDevices_() {
  const names = {};
  readRows_('Users').forEach(r => names[String(r.Email).toLowerCase()] = String(r.Name || r.Email));
  return readRows_('Devices').filter(r => String(r.DeviceId).trim()).map(r => ({
    deviceId: String(r.DeviceId), active: isOn_(r.Active), lastSeen: dt_(r.LastSeen), firmware: String(r.Firmware || ''),
    createdAt: dt_(r.CreatedAt), owner: String(r.Owner || '').toLowerCase(), ownerName: names[String(r.Owner || '').toLowerCase()] || ''
  }));
}

function startSession_(row) {
  const session = 'ss_' + randomHex_();
  CacheService.getScriptCache().put('ses:' + session, String(row.Email).toLowerCase(), SESSION_SEC);
  setCells_('Users', row._row, { LastLogin: new Date() });
  return { session: session, user: publicUser_(userFromRow_(row)) };
}

/* ---------- เข้าสู่ระบบด้วย Google (Google Identity Services) ---------- */
/* หน้าเว็บส่ง ID token ที่ได้จากปุ่ม Google มา → ตรวจกับ Google → อีเมลต้องลงทะเบียนในชีต Users แล้วเท่านั้น */
function googleLogin_(p) {
  const clientId = googleClientId_();
  if (!clientId) fail_('google_disabled', 'ยังไม่ได้ตั้งค่า Google Login');
  const info = verifyGoogleIdToken_(String(p.credential || ''), clientId);
  const row = loginRow_(String(info.email || ''), info.name);
  if (!String(row.Name).trim() && info.name) setCells_('Users', row._row, { Name: text_(info.name) });
  return startSession_(row);
}

/* ---------- เข้าสู่ระบบด้วยอีเมล (ไม่มีรหัสผ่าน/รหัสยืนยัน): อีเมลต้องลงทะเบียนในชีต Users ---------- */
function emailLogin_(p) {
  const email = String(p.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('bad_email', 'กรุณาใส่อีเมลให้ถูกต้อง');
  return startSession_(loginRow_(email));
}

/* หาบัญชีที่เข้าระบบได้: ผู้ดูแลถาวรที่ยังไม่มีบัญชีจะถูกสร้างให้ (พร้อมเตรียมชีตทั้งหมดใน Google Sheet) */
function loginRow_(email, name) {
  email = String(email || '').trim().toLowerCase();
  let row = findUser_(email);
  if (!row && isAdminEmail_(email)) {
    setup();
    appendRow_('Users', { Email: email, Name: text_(name || email), Role: 'admin', Active: true, CreatedAt: new Date() });
    row = findUser_(email);
  }
  if (!row || !isOn_(row.Active)) fail_('not_registered', 'อีเมล ' + email + ' ยังไม่ได้ลงทะเบียนในระบบ กรุณาแจ้งผู้ดูแลระบบให้เพิ่มอีเมลนี้');
  return row;
}

function verifyGoogleIdToken_(credential, clientId) {
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential)) fail_('bad_credential', 'ข้อมูลเข้าสู่ระบบจาก Google ไม่ถูกต้อง');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) fail_('bad_credential', 'Google ไม่ยืนยันการเข้าสู่ระบบนี้ กรุณาลองใหม่');
  const info = JSON.parse(res.getContentText());
  if (info.aud !== clientId) fail_('bad_credential', 'Client ID ไม่ตรงกับที่ตั้งค่าไว้');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(info.iss) < 0) fail_('bad_credential', 'ผู้ออก token ไม่ใช่ Google');
  if (Number(info.exp) * 1000 < Date.now()) fail_('bad_credential', 'การเข้าสู่ระบบหมดอายุ กรุณาลองใหม่');
  if (String(info.email_verified) !== 'true') fail_('bad_credential', 'อีเมล Google นี้ยังไม่ได้ยืนยัน');
  return info;
}

function googleClientId_() {
  return PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') || DEFAULT_GOOGLE_CLIENT_ID;
}

function isAdminEmail_(email) {
  return ADMIN_EMAILS.map(e => e.toLowerCase()).indexOf(String(email || '').toLowerCase()) >= 0;
}

/* ตรวจเซสชันทุกครั้งกับชีต Users เพื่อให้การปิดบัญชี/เปลี่ยนสิทธิ์มีผลทันที */
function session_(session) {
  const cache = CacheService.getScriptCache(), key = 'ses:' + session, u = cache.get(key);
  if (!u) fail_('unauthorized', 'กรุณาเข้าสู่ระบบใหม่');
  const row = findUser_(u);
  if (!row || !isOn_(row.Active)) { cache.remove(key); fail_('unauthorized', 'บัญชีนี้ถูกปิดใช้งาน'); }
  cache.put(key, u, SESSION_SEC);
  return userFromRow_(row);
}

function userFromRow_(row) {
  const email = String(row.Email).toLowerCase();
  return { kind: 'user', email: email, deviceId: 'web:' + email, name: String(row.Name || email), role: row.Role === 'admin' || isAdminEmail_(email) ? 'admin' : 'user' };
}

function publicUser_(who) {
  return { email: who.email || who.deviceId, name: who.name, role: who.role, roleName: ROLE_TH[who.role] || who.role };
}

function findUser_(email) {
  const u = String(email).toLowerCase();
  return readRows_('Users').find(r => String(r.Email).toLowerCase() === u);
}

function listUsers_() {
  return readRows_('Users').filter(r => String(r.Email).trim()).map(r => ({
    email: String(r.Email), name: String(r.Name), role: r.Role === 'admin' || isAdminEmail_(r.Email) ? 'admin' : 'user',
    active: isOn_(r.Active), lastLogin: dt_(r.LastLogin), fixed: isAdminEmail_(r.Email)
  }));
}

function saveUserRow_(p, who) {
  const email = String(p.email || '').trim().toLowerCase(), name = String(p.name || '').trim();
  const role = p.role === 'admin' ? 'admin' : 'user', active = p.active !== false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 100) fail_('bad_email', 'รูปแบบอีเมลไม่ถูกต้อง');
  if (!name) fail_('no_name', 'กรุณาใส่ชื่อ-นามสกุล');
  if (who.email === email && (role !== 'admin' || !active)) fail_('self_lock', 'ลดสิทธิ์หรือปิดบัญชีของตัวเองไม่ได้');
  if (isAdminEmail_(email) && (role !== 'admin' || !active)) fail_('fixed_admin', email + ' เป็นผู้ดูแลระบบถาวร ลดสิทธิ์หรือปิดบัญชีไม่ได้');
  // ลงทะเบียนอีเมลอย่างเดียว ไม่มีรหัสผ่าน: เจ้าของอีเมลเข้าระบบด้วยรหัสที่ส่งไปทางอีเมล
  const row = findUser_(email);
  if (p.isNew) {
    if (row) fail_('exists', 'มีบัญชีอีเมล ' + email + ' อยู่แล้ว');
    appendRow_('Users', { Email: email, Name: text_(name), Role: role, Active: active, CreatedAt: new Date() });
  } else {
    if (!row) fail_('not_found', 'ไม่พบบัญชีอีเมล ' + email);
    setCells_('Users', row._row, { Name: text_(name), Role: role, Active: active });
  }
  return {};
}

function deleteUser_(p, who) {
  const email = String(p.email || '').trim().toLowerCase();
  if (email === who.email) fail_('self_lock', 'ลบบัญชีของตัวเองไม่ได้');
  if (isAdminEmail_(email)) fail_('fixed_admin', email + ' เป็นผู้ดูแลระบบถาวร ลบไม่ได้');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const row = findUser_(email);
    if (!row) fail_('not_found', 'ไม่พบบัญชีอีเมล ' + email);
    sheet_('Users').deleteRow(row._row);
  } finally {
    lock.releaseLock();
  }
  return {};
}

function saveUser_(p, who) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return saveUserRow_(p, who);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- products ---------- */
function getProducts_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('products');
  if (hit) return JSON.parse(hit);
  const list = listAllProducts_().filter(p => p.active).map(p => ({ code: p.code, name: p.name, unit: p.unit }));
  cache.put('products', JSON.stringify(list), 60);
  return list;
}

function listAllProducts_() {
  return readRows_('Products').filter(r => String(r.Code).trim()).map(r => ({
    code: String(r.Code).trim().toUpperCase(), name: String(r.Name), unit: String(r.Unit || 'ชิ้น'),
    active: r.Active === '' || isOn_(r.Active)
  }));
}

/* รับได้ทั้งรหัสตรง ๆ และ URL ที่มี ?item=CODE (จาก QR) */
function parseCode_(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/[?&]item=([^&#]+)/i);
  if (m) s = decodeURIComponent(m[1]);
  return s.trim().toUpperCase();
}

function findProduct_(raw) {
  const code = parseCode_(raw);
  if (!code) fail_('no_code', 'ไม่ได้ส่งรหัสสินค้า');
  const p = getProducts_().find(x => x.code === code);
  if (!p) fail_('not_found', 'ไม่พบสินค้ารหัส "' + code + '" ในชีต Products');
  return p;
}

function addProduct_(p) {
  const code = parseCode_(p.code), name = String(p.name || '').trim(), unit = String(p.unit || '').trim() || 'ชิ้น';
  if (!/^[A-Z0-9_-]{1,32}$/.test(code)) fail_('bad_code', 'รหัสสินค้าใช้ได้เฉพาะ A-Z 0-9 _ - ไม่เกิน 32 ตัว');
  if (!name) fail_('no_name', 'กรุณาใส่ชื่อสินค้า');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const all = listAllProducts_();
    if (all.some(x => x.code === code)) fail_('exists', 'มีสินค้ารหัส ' + code + ' อยู่แล้ว');
    if (all.some(x => x.name === name)) fail_('exists', 'มีสินค้าชื่อ "' + name + '" อยู่แล้ว');
    appendRow_('Products', { Code: code, Name: text_(name), Unit: text_(unit), Active: true });
    CacheService.getScriptCache().remove('products');
  } finally {
    lock.releaseLock();
  }
  return { product: { code: code, name: name, unit: unit } };
}

function saveProduct_(p) {
  const code = parseCode_(p.code), name = String(p.name || '').trim(), unit = String(p.unit || '').trim() || 'ชิ้น';
  if (!name) fail_('no_name', 'กรุณาใส่ชื่อสินค้า');
  const row = readRows_('Products').find(r => String(r.Code).trim().toUpperCase() === code);
  if (!row) fail_('not_found', 'ไม่พบสินค้ารหัส ' + code);
  setCells_('Products', row._row, { Name: text_(name), Unit: text_(unit), Active: p.active !== false });
  CacheService.getScriptCache().remove('products');
  return {};
}

/* ---------- moves ---------- */
function saveMove_(p, who) {
  const product = findProduct_(p.code);
  const qty = Math.floor(Number(p.qty));
  if (!qty || qty < 1 || qty > 9999) fail_('bad_qty', 'จำนวนชิ้นต้องอยู่ระหว่าง 1 – 9999');
  // ไม่ส่งชื่อผู้ขนส่งมา: หน้าเว็บใช้ชื่อบัญชี, ESP32 ใช้ชื่ออุปกรณ์
  const mover = String(p.mover || '').trim().slice(0, 100) || (who.kind === 'user' || who.role === 'device' ? who.name : '');
  if (!mover) fail_('no_mover', 'กรุณาใส่ชื่อผู้ขนส่ง');
  let pickup = String(p.pickup || '').trim().slice(0, 200), dropoff = String(p.dropoff || '').trim().slice(0, 200);
  // งานที่มอบหมาย: หน้าเว็บส่ง assignId มา / บอร์ด ESP32 ที่ไม่ส่งสถานที่ ใช้งานล่าสุดของเจ้าของบอร์ด
  let assign = null;
  const ownerEmail = who.kind === 'user' ? who.email : String(who.owner || '');
  if (p.assignId) {
    assign = findAssignment_(p.assignId);
    if (assign.Email !== ownerEmail && who.role !== 'admin') fail_('forbidden', 'งานนี้ไม่ได้มอบหมายให้คุณ');
  } else if (who.kind === 'token' && ownerEmail && (!pickup || !dropoff)) {
    assign = listAssignments_({ email: ownerEmail, status: 'open' })[0] || null;
    if (assign) assign = findAssignment_(assign.id);
  }
  if (assign) { pickup = pickup || String(assign.Pickup); dropoff = dropoff || String(assign.Dropoff); }
  if (who.kind === 'user' && (!pickup || !dropoff)) fail_('no_place', 'กรุณาใส่สถานที่รับและสถานที่ส่ง');
  const method = String(p.method || '').trim() || (who.role === 'device' ? 'สแกน QR' : 'เลือกเอง');
  const score = p.score === undefined || p.score === null || p.score === '' ? '' : Math.round(Number(p.score) * 100);
  const reqId = String(p.reqId || '').slice(0, 80) || 'm_' + randomHex_().slice(0, 16);   // ใช้เป็นรหัสรายการด้วย
  const cache = CacheService.getScriptCache();

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // ส่งซ้ำด้วย reqId เดิม (เช่น เน็ตหลุดก่อนได้คำตอบ) จะไม่บันทึกซ้ำ
    if (reqId) {
      const dup = cache.get('req:' + reqId);
      if (dup) return Object.assign(JSON.parse(dup), { duplicate: true });
    }
    const photo = p.photo ? savePhoto_(p.photo, product.code) : '';
    const t = new Date();
    appendRow_('Moves', {
      Timestamp: t, Code: product.code, Name: product.name, Qty: qty, Unit: product.unit,
      Mover: text_(mover), Pickup: text_(pickup), Dropoff: text_(dropoff), Method: text_(method), Score: score,
      Source: text_(who.deviceId), Photo: photo, ReqId: reqId, AssignId: assign ? String(assign.Id) : ''
    });
    const res = { product: product, qty: qty, mover: mover, pickup: pickup, dropoff: dropoff, method: method, score: score, date: fmt_(t, 'dd/MM/yyyy'), time: fmt_(t, 'HH:mm:ss') };
    if (reqId) cache.put('req:' + reqId, JSON.stringify(res), 21600);
    return res;
  } finally {
    lock.releaseLock();
  }
}

/* เก็บภาพ (data URL) ลงโฟลเดอร์ใน Google Drive แล้วคืนลิงก์ */
function savePhoto_(dataUrl, code) {
  const m = String(dataUrl).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) return '';
  const props = PropertiesService.getScriptProperties();
  let folder = null;
  const id = props.getProperty('PHOTO_FOLDER_ID');
  try { folder = id ? DriveApp.getFolderById(id) : null; } catch (e) { folder = null; }
  if (!folder) {
    folder = DriveApp.createFolder('Cargo Bot Photos');
    props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  }
  const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
  const name = code + '_' + fmt_(new Date(), 'yyyyMMdd_HHmmss') + '.' + ext;
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name));
  // ให้ผู้ที่มีลิงก์เปิดดูได้ เพื่อแสดงภาพใน Dashboard (บางองค์กรปิดตัวเลือกนี้ไว้)
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* ใช้ลิงก์ตามสิทธิ์เดิม */ }
  return file.getUrl();
}

function photoThumb_(url) {
  const m = String(url || '').match(/\/d\/([\w-]+)/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w200' : '';
}

/* ---------- dashboard ---------- */
function getDashboardData_(range) {
  const DAY = 86400000, now = Date.now();
  const dayKey = t => fmt_(new Date(t), 'yyyy-MM-dd');
  const fDate = t => fmt_(new Date(t), 'dd/MM/yyyy'), fTime = t => fmt_(new Date(t), 'HH:mm:ss');
  const today = dayKey(now), back = { today: 0, '7d': 6, '30d': 29 }[range];
  const start = back === undefined ? '0' : dayKey(now - back * DAY);
  const products = getProducts_();

  const rows = readRows_('Moves').filter(r => r.Timestamp instanceof Date).map(r => ({
    t: r.Timestamp.getTime(), key: dayKey(r.Timestamp), hour: Number(fmt_(r.Timestamp, 'H')),
    code: String(r.Code), name: String(r.Name), unit: String(r.Unit), qty: Number(r.Qty) || 0,
    mover: String(r.Mover), pickup: String(r.Pickup || ''), dropoff: String(r.Dropoff || ''),
    method: String(r.Method), score: r.Score, photo: String(r.Photo || '')
  })).sort((a, b) => a.t - b.t);
  const inR = rows.filter(r => r.key >= start);

  const byP = {};
  products.forEach(p => byP[p.code] = Object.assign({}, p, { qty: 0, trips: 0, last: '-' }));
  const byM = {}, byMethod = {}, byRoute = {}, hours = Array(24).fill(0);
  inR.forEach(r => {
    const rk = (r.pickup || '-') + ' → ' + (r.dropoff || '-');
    const rt = byRoute[rk] || (byRoute[rk] = { route: rk, pickup: r.pickup || '-', dropoff: r.dropoff || '-', qty: 0, trips: 0, last: 0 });
    rt.qty += r.qty; rt.trips++; rt.last = Math.max(rt.last, r.t);
    const p = byP[r.code] || (byP[r.code] = { code: r.code, name: r.name, unit: r.unit, qty: 0, trips: 0, last: '-' });
    p.qty += r.qty; p.trips++; p.last = fDate(r.t) + ' ' + fTime(r.t);
    const m = byM[r.mover] || (byM[r.mover] = { mover: r.mover, qty: 0, trips: 0, last: 0, items: {} });
    m.qty += r.qty; m.trips++; m.last = Math.max(m.last, r.t); m.items[r.name] = (m.items[r.name] || 0) + r.qty;
    hours[r.hour] += r.qty;
    byMethod[r.method] = (byMethod[r.method] || 0) + 1;
  });

  const keys = [];
  for (let d = 13; d >= 0; d--) keys.push(dayKey(now - d * DAY));
  const daily = {};
  products.forEach(p => daily[p.code] = keys.map(() => 0));
  rows.forEach(r => { const i = keys.indexOf(r.key); if (i >= 0 && daily[r.code]) daily[r.code][i] += r.qty; });

  const refCount = {};
  readRows_('Refs').forEach(r => refCount[r.Code] = (refCount[r.Code] || 0) + 1);
  const last = rows[rows.length - 1];

  return {
    updated: fDate(now) + ' ' + fTime(now),
    kpi: {
      totalQty: inR.reduce((s, r) => s + r.qty, 0), trips: inR.length, movers: Object.keys(byM).length,
      todayQty: rows.filter(r => r.key === today).reduce((s, r) => s + r.qty, 0),
      lastMove: last ? fDate(last.t) + ' ' + fTime(last.t) : '-', routes: Object.keys(byRoute).length
    },
    methods: byMethod,
    routes: Object.keys(byRoute).map(k => byRoute[k]).sort((a, b) => b.trips - a.trips).map(r => Object.assign(r, { last: fDate(r.last) + ' ' + fTime(r.last) })),
    products: Object.keys(byP).map(c => Object.assign(byP[c], { refs: refCount[c] || 0 })),
    movers: Object.keys(byM).map(k => byM[k]).sort((a, b) => b.qty - a.qty).map(m => Object.assign(m, { last: fTime(m.last) })),
    hours: hours,
    daily: { labels: keys.map(k => k.slice(8) + '/' + k.slice(5, 7)), series: products.map(p => ({ name: p.name, data: daily[p.code] })) },
    recent: rows.slice(-30).reverse().map(r => ({
      date: fDate(r.t), time: fTime(r.t), name: r.name, qty: r.qty, unit: r.unit,
      mover: r.mover, pickup: r.pickup, dropoff: r.dropoff, method: r.method, score: r.score, photo: photoThumb_(r.photo), photoUrl: r.photo
    }))
  };
}

/* ---------- สถานที่รับ / สถานที่ส่ง (ผู้ดูแลกำหนดในชีต Places) ---------- */
const PLACE_TYPES = { pickup: 'สถานที่รับ', dropoff: 'สถานที่ส่ง', both: 'รับและส่ง' };

/* ตัวเลือกในฟอร์ม: เฉพาะสถานที่ที่เปิดใช้ แยกเป็นรายการสถานที่รับ / สถานที่ส่ง */
function getPlaces_() {
  const list = listPlaces_().filter(x => x.active);
  return {
    pickups: list.filter(x => x.type !== 'dropoff').map(x => x.name),
    dropoffs: list.filter(x => x.type !== 'pickup').map(x => x.name)
  };
}

function listPlaces_() {
  return readRows_('Places').filter(r => r.Id && String(r.Name).trim()).map(r => ({
    id: String(r.Id), name: String(r.Name), type: PLACE_TYPES[r.Type] ? String(r.Type) : 'both',
    active: r.Active === '' || isOn_(r.Active), createdAt: dt_(r.CreatedAt)
  })).sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

function savePlace_(p, who) {
  const name = String(p.name || '').trim().slice(0, 200), type = PLACE_TYPES[p.type] ? String(p.type) : 'both';
  if (!name) fail_('no_name', 'กรุณาใส่ชื่อสถานที่');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const rows = readRows_('Places');
    if (rows.some(r => String(r.Name).trim().toLowerCase() === name.toLowerCase() && String(r.Id) !== String(p.id || '')))
      fail_('exists', 'มีสถานที่ชื่อ "' + name + '" อยู่แล้ว');
    const fields = { Name: text_(name), Type: type, Active: p.active !== false };
    if (p.id) {
      const row = rows.find(r => String(r.Id) === String(p.id));
      if (!row) fail_('not_found', 'ไม่พบสถานที่นี้ (อาจถูกลบไปแล้ว)');
      setCells_('Places', row._row, fields);
      return { id: p.id };
    }
    const id = 'p_' + randomHex_().slice(0, 12);
    appendRow_('Places', Object.assign({ Id: id, CreatedAt: new Date(), CreatedBy: text_(who.email || '') }, fields));
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

function deletePlace_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const row = readRows_('Places').find(r => String(r.Id) === String(p.id || ''));
    if (!row) fail_('not_found', 'ไม่พบสถานที่นี้ (อาจถูกลบไปแล้ว)');
    sheet_('Places').deleteRow(row._row);   // บันทึกการขนส่งเดิมเก็บชื่อสถานที่ไว้แล้ว จึงไม่กระทบข้อมูลเก่า
  } finally {
    lock.releaseLock();
  }
  return {};
}

/* ---------- งานที่มอบหมาย: ผู้ดูแลกำหนดสถานที่รับ-ส่งให้พนักงาน ---------- */
/* p.email = เฉพาะพนักงานคนนี้, p.status = open/done (ว่าง = ทั้งหมด) ล่าสุดก่อน พร้อมจำนวนเที่ยวที่ขนแล้ว */
function listAssignments_(p) {
  const email = String(p.email || '').toLowerCase(), status = String(p.status || '');
  const trips = {};
  readRows_('Moves').forEach(r => { if (r.AssignId) { const t = trips[r.AssignId] || (trips[r.AssignId] = { trips: 0, qty: 0 }); t.trips++; t.qty += Number(r.Qty) || 0; } });
  const names = {};
  readRows_('Users').forEach(r => names[String(r.Email).toLowerCase()] = String(r.Name || r.Email));
  return readRows_('Assignments')
    .filter(r => r.Id && (!email || String(r.Email).toLowerCase() === email) && (!status || r.Status === status))
    .map(r => ({
      id: String(r.Id), email: String(r.Email), name: names[String(r.Email).toLowerCase()] || String(r.Email),
      pickup: String(r.Pickup), dropoff: String(r.Dropoff), note: String(r.Note || ''), status: String(r.Status || 'open'),
      createdAt: dt_(r.CreatedAt), t: r.CreatedAt instanceof Date ? r.CreatedAt.getTime() : 0,
      trips: (trips[r.Id] || {}).trips || 0, qty: (trips[r.Id] || {}).qty || 0
    }))
    .sort((a, b) => b.t - a.t);
}

function findAssignment_(id) {
  const row = readRows_('Assignments').find(r => String(r.Id) === String(id || ''));
  if (!row) fail_('not_found', 'ไม่พบงานที่มอบหมายนี้ (อาจถูกลบไปแล้ว)');
  row.Email = String(row.Email).toLowerCase();
  return row;
}

function saveAssignment_(p, who) {
  const email = String(p.email || '').trim().toLowerCase();
  const user = findUser_(email);
  if (!user) fail_('not_found', 'ไม่พบพนักงาน ' + email);
  const pickup = String(p.pickup || '').trim().slice(0, 200), dropoff = String(p.dropoff || '').trim().slice(0, 200);
  if (!pickup || !dropoff) fail_('no_place', 'กรุณาใส่สถานที่รับและสถานที่ส่ง');
  const fields = { Email: email, Pickup: text_(pickup), Dropoff: text_(dropoff), Note: text_(String(p.note || '').trim().slice(0, 300)),
    Status: p.status === 'done' ? 'done' : 'open', UpdatedAt: new Date() };
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (p.id) {
      setCells_('Assignments', findAssignment_(p.id)._row, fields);
      return { id: p.id };
    }
    const id = 'a_' + randomHex_().slice(0, 16);
    appendRow_('Assignments', Object.assign({ Id: id, CreatedAt: new Date(), CreatedBy: text_(who.email || who.deviceId) }, fields));
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

function deleteAssignment_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    sheet_('Assignments').deleteRow(findAssignment_(p.id)._row);
  } finally {
    lock.releaseLock();
  }
  return {};
}

/* ---------- จัดการบันทึกการขนส่ง (ผู้ดูแลระบบ) ---------- */
/* รายการตามช่วงวันที่ (yyyy-MM-dd) และคำค้น (ชื่อผู้ขนส่ง / อุปกรณ์ / สถานที่) ล่าสุดก่อน */
function listMoves_(p) {
  const from = String(p.from || ''), to = String(p.to || '9999'), q = String(p.q || '').trim().toLowerCase();
  const rows = readRows_('Moves').filter(r => r.Timestamp instanceof Date);
  rows.filter(r => !r.ReqId).forEach(r => { r.ReqId = 'm_' + randomHex_().slice(0, 16); setCells_('Moves', r._row, { ReqId: r.ReqId }); });
  return rows.map(r => ({
    id: String(r.ReqId), key: fmt_(r.Timestamp, 'yyyy-MM-dd'), when: fmt_(r.Timestamp, 'yyyy-MM-dd') + 'T' + fmt_(r.Timestamp, 'HH:mm'),
    date: fmt_(r.Timestamp, 'dd/MM/yyyy'), time: fmt_(r.Timestamp, 'HH:mm'), t: r.Timestamp.getTime(),
    code: String(r.Code), name: String(r.Name), qty: Number(r.Qty) || 0, unit: String(r.Unit),
    mover: String(r.Mover), pickup: String(r.Pickup || ''), dropoff: String(r.Dropoff || ''),
    source: String(r.Source || ''), photoUrl: String(r.Photo || '')
  }))
    .filter(m => m.key >= from && m.key <= to && (!q || [m.mover, m.name, m.pickup, m.dropoff, m.code].join(' ').toLowerCase().indexOf(q) >= 0))
    .sort((a, b) => b.t - a.t).slice(0, 500);
}

/* ค่าที่ผู้ดูแลกรอกในฟอร์ม → ค่าที่จะเขียนลงชีต Moves */
function moveFields_(p) {
  const product = findProduct_(p.code), qty = Math.floor(Number(p.qty));
  if (!qty || qty < 1 || qty > 9999) fail_('bad_qty', 'จำนวนต้องอยู่ระหว่าง 1 – 9999');
  const mover = String(p.mover || '').trim(), pickup = String(p.pickup || '').trim(), dropoff = String(p.dropoff || '').trim();
  if (!mover || !pickup || !dropoff) fail_('missing', 'กรุณากรอกผู้ขนส่ง สถานที่รับ และสถานที่ส่ง');
  const when = p.when ? new Date(String(p.when).slice(0, 16) + ':00+07:00') : new Date();
  if (isNaN(when.getTime())) fail_('bad_date', 'วันที่และเวลาไม่ถูกต้อง');
  return { Timestamp: when, Code: product.code, Name: product.name, Qty: qty, Unit: product.unit,
    Mover: text_(mover.slice(0, 100)), Pickup: text_(pickup.slice(0, 200)), Dropoff: text_(dropoff.slice(0, 200)) };
}

function findMove_(id) {
  const row = readRows_('Moves').find(r => String(r.ReqId) === String(id || ''));
  if (!row) fail_('not_found', 'ไม่พบรายการนี้ (อาจถูกลบไปแล้ว)');
  return row;
}

function addMove_(p, who) {
  const f = moveFields_(p), id = 'm_' + randomHex_().slice(0, 16);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    appendRow_('Moves', Object.assign(f, { Method: 'ผู้ดูแลเพิ่ม', Source: text_('admin:' + who.email), ReqId: id }));
  } finally {
    lock.releaseLock();
  }
  return { id: id };
}

function updateMove_(p, who) {
  const f = moveFields_(p);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    setCells_('Moves', findMove_(p.id)._row, f);
  } finally {
    lock.releaseLock();
  }
  return { id: p.id };
}

function deleteMove_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    sheet_('Moves').deleteRow(findMove_(p.id)._row);
  } finally {
    lock.releaseLock();
  }
  return {};
}

/* ---------- ฐานข้อมูล Google Sheet ---------- */
/* Script Property SPREADSHEET_ID > DEFAULT_SPREADSHEET_ID > Sheet ที่สคริปต์ผูกอยู่ */
let SS_ = null;
function dbId_() {
  return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID;
}

function ss_() {
  if (SS_) return SS_;
  const id = dbId_();
  if (id) {
    try { SS_ = SpreadsheetApp.openById(id); } catch (e) {
      fail_('bad_sheet', 'เปิด Google Sheet ฐานข้อมูลไม่ได้ ให้บัญชีเจ้าของสคริปต์มีสิทธิ์แก้ไข Sheet นี้');
    }
  } else {
    SS_ = SpreadsheetApp.getActive();
  }
  if (!SS_) fail_('no_db', 'ยังไม่ได้เชื่อมฐานข้อมูล Google Sheet');
  return SS_;
}

/* ---------- AI: ภาพอ้างอิง (CargoVision.vecToB64) และไฟล์โมเดล ---------- */
function getRefs_(code) {
  const c = code ? parseCode_(code) : '';
  return readRows_('Refs')
    .filter(r => r.Vec && (!c || String(r.Code) === c))
    .map(r => ({ id: String(r.Id), code: String(r.Code), name: String(r.Name), vec: String(r.Vec), thumb: String(r.Thumb || ''), addedBy: String(r.AddedBy) }));
}

function addRef_(p, who) {
  const product = findProduct_(p.code), vec = String(p.vec || ''), thumb = String(p.thumb || '');
  if (!/^[A-Za-z0-9+/=]{100,49000}$/.test(vec)) fail_('bad_vec', 'vec ต้องเป็น base64 จาก CargoVision.vecToB64');
  if (thumb && !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]{1,45000}$/.test(thumb)) fail_('bad_thumb', 'ภาพย่อต้องเป็น JPEG ขนาดไม่เกิน ~33 KB');
  const id = Utilities.getUuid().slice(0, 8);
  appendRow_('Refs', { Id: id, Code: product.code, Name: product.name, Vec: vec, Thumb: thumb, AddedBy: text_(p.addedBy || who.name), Timestamp: new Date() });
  return { id: id };
}

function deleteRef_(p) {
  const row = readRows_('Refs').find(r => String(r.Id) === String(p.id));
  if (!row) fail_('not_found', 'ไม่พบภาพ ' + p.id);
  sheet_('Refs').deleteRow(row._row);
  return {};
}

/* ไฟล์น้ำหนักโมเดล (base64) อยู่ใน Google Drive ส่งให้หน้าเว็บเป็นชิ้นละ 1 MB */
function modelFile_() {
  const props = PropertiesService.getScriptProperties(), id = props.getProperty('MODEL_FILE_ID');
  if (id) { try { return DriveApp.getFileById(id); } catch (e) { /* หาใหม่ด้านล่าง */ } }
  const it = DriveApp.getFilesByName(MODEL_FILE);
  if (!it.hasNext()) fail_('no_model', 'ไม่พบไฟล์ ' + MODEL_FILE + ' ใน Google Drive ของเจ้าของสคริปต์');
  const f = it.next();
  props.setProperty('MODEL_FILE_ID', f.getId());
  return f;
}

function modelText_() {
  return modelFile_().getBlob().getDataAsString();
}

function modelInfo_() {
  const f = modelFile_(), size = f.getSize();
  return { version: f.getId() + '-' + f.getLastUpdated().getTime(), chunks: Math.ceil(size / MODEL_CHUNK) };
}

/* ---------- sheet helpers ---------- */
function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SHEETS[name].length).setFontWeight('bold');
  }
  return sh;
}

function header_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

function readRows_(name) {
  const values = sheet_(name).getDataRange().getValues(), head = values.shift() || [];
  return values.map((v, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => o[h] = v[j]);
    return o;
  });
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  sh.appendRow(header_(sh).map(h => obj[h] === undefined ? '' : obj[h]));
}

function setCells_(name, rowNum, obj) {
  const sh = sheet_(name), head = header_(sh);
  Object.keys(obj).forEach(k => {
    const c = head.indexOf(k);
    if (c >= 0) sh.getRange(rowNum, c + 1).setValue(obj[k]);
  });
}

/* กันข้อความที่ขึ้นต้นด้วย = + - @ ถูกตีความเป็นสูตร */
function text_(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function isOn_(v) {
  return v === true || /^(true|1|yes|y)$/i.test(String(v).trim());
}

function fmt_(d, f) {
  return Utilities.formatDate(d, TZ, f);
}

function dt_(v) {
  return v instanceof Date ? fmt_(v, 'dd/MM/yyyy HH:mm:ss') : '';
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

function randomHex_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

/* ---------- เมนูในชีต ---------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Cargo Bot')
    .addItem('สร้าง / ตรวจฟิลด์ฐานข้อมูล', 'setup')
    .addToUi();
}

/* ตารางคำอธิบายฟิลด์ทุกชีต: ชีต | ฟิลด์ | ความหมาย | ตัวอย่าง (เขียนทับทุกครั้งที่ setup) */
function fieldDocRows_() {
  const rows = [['ชีต', 'ฟิลด์', 'ความหมาย', 'ตัวอย่าง']];
  Object.keys(FIELD_DOCS).forEach(n => {
    const [title, fields] = FIELD_DOCS[n];
    SHEETS[n].forEach(h => rows.push([n + ' (' + title + ')', h].concat(fields[h] || ['', ''])));
  });
  return rows;
}

function writeFieldDocs_(book) {
  const sh = book.getSheetByName(DOC_SHEET) || book.insertSheet(DOC_SHEET);
  const rows = fieldDocRows_();
  sh.clear();
  sh.getRange(1, 1, rows.length, 4).setValues(rows);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/* สร้างชีตและฟิลด์ทั้งหมดใน Google Sheet (รันซ้ำได้ ไม่ลบข้อมูลเดิม) */
function setup() {
  const book = ss_();
  book.setSpreadsheetTimeZone(TZ);
  // สร้างชีตที่ยังไม่มี และเติมคอลัมน์ที่ขาดให้ชีตจากเวอร์ชันก่อน
  Object.keys(SHEETS).forEach(n => {
    const sh = sheet_(n), head = header_(sh), missing = SHEETS[n].filter(h => head.indexOf(h) < 0);
    if (missing.length) sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  });
  // ลบชีตว่างที่ Google สร้างมากับไฟล์ใหม่ (ชีต1 / Sheet1)
  book.getSheets().forEach(sh => {
    if (/^(ชีต1|Sheet1)$/.test(sh.getName()) && sh.getLastRow() === 0 && book.getSheets().length > 1) book.deleteSheet(sh);
  });
  const ps = sheet_('Products');
  if (ps.getLastRow() < 2) ps.getRange(2, 1, SEED_PRODUCTS.length, 4).setValues(SEED_PRODUCTS.map(r => r.concat([true])));
  writeFieldDocs_(book);
  [['Moves', 'Timestamp'], ['Users', 'LastLogin'], ['Users', 'CreatedAt'], ['Devices', 'LastSeen'], ['Devices', 'CreatedAt'], ['Refs', 'Timestamp'],
    ['Assignments', 'CreatedAt'], ['Assignments', 'UpdatedAt'], ['Places', 'CreatedAt']]
    .forEach(([n, h]) => {
      const sh = sheet_(n), c = header_(sh).indexOf(h) + 1;
      if (c > 0) sh.getRange(2, c, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
    });
  CacheService.getScriptCache().remove('products');
}
