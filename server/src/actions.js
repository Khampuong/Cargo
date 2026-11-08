/*
 * Cargo Bot: คำสั่งทั้งหมดของระบบ (ย้ายมาจาก gas/Code.gs) ใช้ MySQL แทน Google Sheet
 * handle(p, via) ตอบ { ok:true, ... } หรือ { ok:false, error, message } เหมือนเดิมทุกอย่าง
 * หน้าเว็บ (Index.html) และ ESP32 จึงใช้ต่อได้โดยไม่ต้องแก้
 */
const fs = require('fs'), path = require('path');
const { q, one, getSetting, setSetting } = require('./db');
const { fmt, dt, randomHex, sha256, hmacHex, sameText, fail, cache, withLock, isOn, str } = require('./util');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || 'methas@gmail.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 365);
const PHOTO_DIR = path.resolve(process.env.PHOTO_DIR || path.join(__dirname, '..', 'data', 'photos'));
const MODEL_PATH = path.resolve(process.env.MODEL_FILE || path.join(ROOT, 'model', 'cargo_model_weights.b64.txt'));
const MODEL_CHUNK = 1000000;
const PASS_ROUNDS = 300, PASS_MAX_FAIL = 5, PASS_LOCK_SEC = 900;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLES = {
  device: ['ping', 'heartbeat', 'products', 'lookup', 'saveMove'],
  user: ['ping', 'me', 'logout', 'products', 'lookup', 'places', 'saveMove', 'dashboard',
    'refs', 'modelInfo', 'modelChunk',   // ภาพอ้างอิง (addRef) เพิ่มได้เฉพาะผู้ดูแล
    'myAssignments', 'myCart', 'borrowMyCart', 'returnMyCart'],   // พนักงานไม่มีการตั้งรหัสผ่าน
  admin: ['*']
};
const ROLE_TH = { user: 'พนักงาน', admin: 'ผู้ดูแลระบบ' };
const PUBLIC = ['emailLogin', 'authConfig', 'phoneName',
  'cartLookup', 'cartBorrow', 'cartReturn', 'phoneLogin'];
const PLACE_TYPES = { pickup: 'สถานที่รับ', dropoff: 'สถานที่ส่ง', both: 'รับและส่ง' };

const ACTIONS = {
  ping: () => ({ message: 'pong' }),
  heartbeat: () => ({ intervalSec: 60 }),
  emailLogin,
  setMyPassword, phoneName,
  // รถเข็น: หน้ายืม-คืน (/cart) ใช้เบอร์โทร ไม่ต้องเข้าสู่ระบบ
  cartLookup, cartBorrow, cartReturn, phoneLogin,
  myCart, borrowMyCart, returnMyCart,   // ปุ่มยืม/คืนรถเข็นในแอป (เข้าสู่ระบบแล้ว)
  // รถเข็น: ผู้ดูแลระบบ
  carts: async () => ({ carts: await listCarts() }),
  saveCart, deleteCart,
  cartLoans: async p => ({ loans: await listCartLoans(p) }),
  forceReturn,
  authConfig: () => ({ emailLogin: emailOnlyAllowed() }),
  me: (p, who) => ({ user: publicUser(who) }),
  logout: async p => { await endSession(p.session); return {}; },
  products: async () => ({ products: await getProducts() }),
  lookup: async p => ({ product: await findProduct(p.code) }),
  places: getPlaces,
  allPlaces: async () => ({ places: await listPlaces() }),
  savePlace, deletePlace,
  saveMove,
  dashboard: p => getDashboardData(str(p.range || 'today')),
  refs: async p => ({ refs: await getRefs(p.code) }),
  addRef, addProduct, modelInfo,
  modelChunk: p => ({ data: modelText().substr(Math.max(0, Math.floor(Number(p.i) || 0)) * MODEL_CHUNK, MODEL_CHUNK) }),
  myAssignments: async (p, who) => ({ assignments: await listAssignments({ email: who.email, status: 'open' }) }),
  // ผู้ดูแลระบบ
  assignments: async p => ({ assignments: await listAssignments(p) }),
  saveAssignment, deleteAssignment,
  moves: async p => ({ moves: await listMoves(p) }),
  addMove, updateMove, deleteMove,
  users: async () => ({ users: await listUsers() }),
  saveUser: (p, who) => withLock(() => saveUserRow(p, who)),
  deleteUser,
  allProducts: async () => ({ products: await listAllProducts() }),
  saveProduct, deleteProduct, deleteRef,
  systemToken: async (p, who, via) => ({ token: await systemToken(false), apiUrl: await apiUrl(via), devices: await listDevices() }),
  regenToken: async (p, who, via) => ({ token: await systemToken(true), apiUrl: await apiUrl(via) }),
  setDevice, deleteDevice
};

async function handle(p, via) {
  via = via || {};
  try {
    const action = str(p.action);
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) fail('unknown_action', 'ไม่รู้จักคำสั่ง "' + action + '"');
    let who = null;
    if (PUBLIC.indexOf(action) < 0) {
      who = p.session ? await session(p.session) : await auth(p.token, p);
      const allowed = ROLES[who.role] || [];
      if (allowed.indexOf('*') < 0 && allowed.indexOf(action) < 0) fail('forbidden', 'สิทธิ์ ' + who.role + ' ใช้คำสั่ง ' + action + ' ไม่ได้');
      if (who.kind === 'token') await touch(who, p, action === 'heartbeat');
    }
    const out = await ACTIONS[action](p, who, via);
    return Object.assign({ ok: true, action, serverTime: fmt(new Date(), 'yyyy-MM-dd HH:mm:ss') }, out);
  } catch (err) {
    if (err && err.apiError) return { ok: false, error: err.apiError, message: err.message };
    console.error(err);
    return { ok: false, error: 'server_error', message: String((err && err.message) || err) };
  }
}

/* ---------- Token ระบบ (ESP32): Token เดียวทั้งระบบ แยกบอร์ดด้วย deviceId ---------- */
async function systemToken(regen) {
  let t = await getSetting('SYSTEM_TOKEN');
  if (!t || regen) { t = 'cb_' + randomHex().slice(0, 64); await setSetting('SYSTEM_TOKEN', t); }
  return t;
}

function deviceIdOf(p) {
  const id = str(p.deviceId).trim();
  return /^[A-Za-z0-9_.-]{1,32}$/.test(id) ? id : 'ESP32';
}

async function auth(token, p) {
  token = str(token).trim();
  if (!token) fail('unauthorized', 'ไม่ได้ส่ง token');
  const sys = await getSetting('SYSTEM_TOKEN');
  if (!sys || !sameText(token, sys)) fail('unauthorized', 'Token ไม่ถูกต้อง (ผู้ดูแลอาจสร้าง Token ใหม่แล้ว)');
  const id = deviceIdOf(p);
  const row = await one('SELECT * FROM devices WHERE device_id = ?', [id]);
  if (row && !row.active) fail('unauthorized', 'บอร์ด ' + id + ' ถูกผู้ดูแลระบบบล็อกไว้');
  const owner = row && row.owner ? await findUser(row.owner) : null;
  return {
    kind: 'token', deviceId: row ? row.device_id : id, role: 'device',
    name: owner ? str(owner.name || owner.email) : (row && str(row.name).trim() ? row.name : id),
    owner: owner ? owner.email : ''
  };
}

/* บันทึกบอร์ดที่ติดต่อเข้ามา (บอร์ดใหม่ถูกเพิ่มเอง) เขียนไม่เกินนาทีละครั้ง ยกเว้น heartbeat */
async function touch(who, p, force) {
  const key = 'seen:' + who.deviceId.toLowerCase();
  if (!force && cache.get(key)) return;
  const fw = p.fw ? str(p.fw).slice(0, 50) : null;
  const info = force ? JSON.stringify({ ip: p.ip, rssi: p.rssi, uptime: p.uptime, queue: p.queue, heap: p.heap }).slice(0, 500) : null;
  await q(`INSERT INTO devices (device_id, name, active, last_seen, firmware, info) VALUES (?, ?, 1, UTC_TIMESTAMP(), ?, ?)
    ON DUPLICATE KEY UPDATE last_seen = UTC_TIMESTAMP(), firmware = COALESCE(?, firmware), info = COALESCE(?, info)`,
  [who.deviceId, who.deviceId, fw || '', info || '', fw, info]);
  cache.put(key, '1', 60);
}

async function setDevice(p) {
  const row = await one('SELECT * FROM devices WHERE device_id = ?', [str(p.deviceId)]);
  if (!row) fail('not_found', 'ไม่พบบอร์ด ' + p.deviceId);
  if (p.owner !== undefined) {
    const email = str(p.owner).trim().toLowerCase();
    if (email && !await findUser(email)) fail('not_found', 'ไม่พบพนักงาน ' + email);
    await q('UPDATE devices SET owner = ? WHERE device_id = ?', [email, row.device_id]);
  }
  if (p.active !== undefined) await q('UPDATE devices SET active = ? WHERE device_id = ?', [p.active ? 1 : 0, row.device_id]);
  return {};
}

async function deleteDevice(p) {
  const r = await q('DELETE FROM devices WHERE device_id = ?', [str(p.deviceId)]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบบอร์ด ' + p.deviceId);
  return {};
}

/* URL ที่บอร์ดต้องเรียก: PUBLIC_BASE_URL (เช่น Cloudflare) หรือที่อยู่ที่หน้าเว็บเปิดอยู่ + /api */
async function apiUrl(via) {
  const base = (await getSetting('PUBLIC_BASE_URL') || process.env.PUBLIC_BASE_URL || (via && via.baseUrl) || '').replace(/\/+$/, '');
  return base ? base + '/api' : '';
}

async function listDevices() {
  const rows = await q(`SELECT d.*, u.name AS owner_name FROM devices d LEFT JOIN users u ON u.email = d.owner ORDER BY d.device_id`);
  return rows.map(r => ({
    deviceId: r.device_id, active: !!r.active, lastSeen: dt(r.last_seen), firmware: str(r.firmware),
    createdAt: dt(r.created_at), owner: str(r.owner), ownerName: str(r.owner_name || '')
  }));
}

/* ---------- เซสชัน: เข้าระบบรอบเดียว เก็บแฮชใน MySQL ---------- */
async function startSession(row) {
  const s = 'ss_' + randomHex();
  const email = row.email.toLowerCase();
  await q('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
  await q('INSERT INTO sessions (id_hash, email, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? DAY)', [sha256(s), email, SESSION_DAYS]);
  await q('UPDATE users SET last_login = UTC_TIMESTAMP() WHERE email = ?', [email]);
  return { session: s, user: publicUser(userFromRow(row)) };
}

async function endSession(s) {
  if (!/^ss_[0-9a-f]+$/.test(str(s))) return;
  cache.remove('ses:' + s);
  await q('DELETE FROM sessions WHERE id_hash = ?', [sha256(s)]);
}

async function session(s) {
  s = str(s);
  if (!/^ss_[0-9a-f]+$/.test(s)) fail('unauthorized', 'กรุณาเข้าสู่ระบบ');
  const r = await one(`SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.email = s.email
    WHERE s.id_hash = ? AND s.expires_at > UTC_TIMESTAMP()`, [sha256(s)]);
  if (!r) { await endSession(s); fail('unauthorized', 'กรุณาเข้าสู่ระบบ'); }
  if (!r.active) { await endSession(s); fail('unauthorized', 'บัญชีนี้ถูกปิดใช้งาน'); }
  if (!cache.get('ses:' + s)) {   // ต่ออายุวันละครั้ง
    await q('UPDATE sessions SET expires_at = UTC_TIMESTAMP() + INTERVAL ? DAY WHERE id_hash = ?', [SESSION_DAYS, sha256(s)]);
    cache.put('ses:' + s, '1', 86400);
  }
  return userFromRow(r);
}

function userFromRow(row) {
  const email = str(row.email).toLowerCase();
  return { kind: 'user', email, deviceId: 'web:' + email, name: str(row.name || email), role: row.role === 'admin' || isAdminEmail(email) ? 'admin' : 'user' };
}
function publicUser(who) {
  return { email: who.email || who.deviceId, name: who.name, role: who.role, roleName: ROLE_TH[who.role] || who.role };
}
const isAdminEmail = e => ADMIN_EMAILS.indexOf(str(e).trim().toLowerCase()) >= 0;
const findUser = email => one('SELECT * FROM users WHERE email = ?', [str(email).trim().toLowerCase()]);

/* หาบัญชีที่เข้าระบบได้: ผู้ดูแลถาวรที่ยังไม่มีบัญชีจะถูกสร้างให้ */
async function loginRow(email, name) {
  email = str(email).trim().toLowerCase();
  let row = await findUser(email);
  if (!row && isAdminEmail(email)) {
    await q('INSERT IGNORE INTO users (email, name, role, active) VALUES (?, ?, "admin", 1)', [email, str(name || email).slice(0, 200)]);
    row = await findUser(email);
  }
  if (!row || !row.active) fail('not_registered', 'อีเมล ' + email + ' ยังไม่ได้ลงทะเบียนในระบบ กรุณาแจ้งผู้ดูแลระบบให้เพิ่มอีเมลนี้');
  return row;
}

/* ---------- เบอร์โทร/อีเมล + รหัสผ่าน (เข้ากันได้กับแฮชจากเวอร์ชัน Apps Script) ---------- */
/* EMAIL_ONLY_LOGIN=1 = ยอมให้เข้าด้วยอีเมลอย่างเดียว ไม่มีรหัสผ่าน (ใช้เฉพาะทดลองในเครื่อง) */
function emailOnlyAllowed() {
  return process.env.EMAIL_ONLY_LOGIN === '1';
}

/* รหัสผ่านหรือ PIN อย่างน้อย 6 ตัว (ใส่ผิด 5 ครั้งล็อก 15 นาที) */
function checkPassword(pass) {
  if (pass.length < 6 || pass.length > 128) fail('weak_password', 'รหัสผ่านต้องยาว 6-128 ตัวอักษร (ใช้ PIN 6 หลักได้)');
}

/* เบอร์โทร 10 หลัก ขึ้นต้น 0 เช่น "081-234-5678" หรือ "+66 81 234 5678" → "0812345678" (ไม่ครบ 10 หลัก = "") */
function normalizePhone(raw) {
  let s = str(raw).replace(/[\s\-().]/g, '');
  if (/^\+?66\d{9}$/.test(s)) s = '0' + s.replace(/^\+?66/, '');
  return /^0\d{9}$/.test(s) ? s : '';
}
const findUserByPhone = phone => one('SELECT * FROM users WHERE phone = ?', [phone]);

/* หน้าเข้าสู่ระบบ: พิมพ์เบอร์โทรแล้วแสดงชื่อพนักงาน (จำกัด 30 ครั้ง / 5 นาที ต่อ IP กันการไล่เดาเบอร์) */
async function phoneName(p, who, via) {
  const phone = normalizePhone(p.phone);
  if (!phone) fail('bad_phone', 'เบอร์โทรศัพท์ไม่ถูกต้อง');
  const key = 'pn:' + str(via.ip), n = Number(cache.get(key) || 0);
  if (n >= 30) fail('rate_limited', 'ค้นหาบ่อยเกินไป กรุณารอสักครู่');
  cache.put(key, String(n + 1), 300);
  const row = await findUserByPhone(phone);
  if (!row || !row.active) fail('not_found', 'ไม่พบเบอร์นี้ในระบบ กรุณาแจ้งผู้ดูแลระบบ');
  return { name: row.name };
}
function hashPassword(pass, salt) {
  salt = salt || randomHex().slice(0, 32);
  let h = salt + pass;
  for (let i = 0; i < PASS_ROUNDS; i++) h = hmacHex(h + pass, salt);
  return 'v1$' + salt + '$' + h;
}
function samePassword(pass, stored) {
  const m = str(stored).match(/^v1\$([0-9a-f]+)\$([0-9a-f]{64})$/);
  return !!m && sameText(hashPassword(pass, m[1]), stored);
}

/* เข้าด้วย อีเมล หรือ เบอร์โทรศัพท์ + รหัสผ่าน (ช่อง email รับได้ทั้งสองแบบ) */
async function emailLogin(p) {
  const id = str(p.email || p.phone).trim(), pass = str(p.password);
  const email = EMAIL_RE.test(id) ? id.toLowerCase() : '', phone = email ? '' : normalizePhone(id);
  if (!email && !phone) fail('bad_login_id', 'กรุณาใส่อีเมลหรือเบอร์โทรศัพท์ให้ถูกต้อง');
  if (!pass) {
    if (!email || !emailOnlyAllowed()) fail('need_password', 'กรุณาใส่รหัสผ่าน');
    return startSession(await loginRow(email));
  }
  const key = 'pwfail:' + (email || phone), fails = Number(cache.get(key) || 0);
  if (fails >= PASS_MAX_FAIL) fail('locked', 'ใส่รหัสผ่านผิดหลายครั้ง กรุณารอ 15 นาที');
  const row = email ? await findUser(email) : await findUserByPhone(phone);
  if (!row || !row.active || !samePassword(pass, row.pass_hash)) {
    cache.put(key, String(fails + 1), PASS_LOCK_SEC);
    fail('bad_login', row && row.active && !row.pass_hash
      ? 'บัญชีนี้ยังไม่ได้ตั้งรหัสผ่าน กรุณาให้ผู้ดูแลระบบตั้งรหัสผ่าน/PIN ให้'
      : (email ? 'อีเมล' : 'เบอร์โทรศัพท์') + 'หรือรหัสผ่านไม่ถูกต้อง');
  }
  cache.remove(key);
  // แท็บ "ผู้ดูแลระบบ" ที่หน้าแรก: รับเฉพาะบัญชีผู้ดูแล
  if (p.adminOnly && !(row.role === 'admin' || isAdminEmail(row.email))) fail('not_admin', 'บัญชีนี้ไม่ใช่ผู้ดูแลระบบ กรุณาเลือกแท็บ "พนักงาน"');
  return startSession(row);
}

async function setMyPassword(p, who) {
  const pass = str(p.password);
  checkPassword(pass);
  const row = await findUser(who.email);
  if (!row) fail('not_found', 'ไม่พบบัญชี');
  if (row.pass_hash && !samePassword(str(p.oldPassword), row.pass_hash)) fail('bad_login', 'รหัสผ่านเดิมไม่ถูกต้อง');
  await q('UPDATE users SET pass_hash = ? WHERE email = ?', [hashPassword(pass), row.email]);
  return {};
}

/* ---------- บัญชีผู้ใช้งาน ---------- */
async function listUsers() {
  const rows = await q('SELECT * FROM users ORDER BY created_at, email');
  return rows.map(r => ({
    email: r.email, name: r.name, phone: r.phone || '', role: r.role === 'admin' || isAdminEmail(r.email) ? 'admin' : 'user',
    active: !!r.active, lastLogin: dt(r.last_login), fixed: isAdminEmail(r.email), hasPassword: !!r.pass_hash
  }));
}

async function saveUserRow(p, who) {
  const email = str(p.email).trim().toLowerCase(), name = str(p.name).trim().slice(0, 200);
  const role = p.role === 'admin' ? 'admin' : 'user', active = p.active !== false;
  if (!EMAIL_RE.test(email) || email.length > 100) fail('bad_email', 'รูปแบบอีเมลไม่ถูกต้อง');
  if (!name) fail('no_name', 'กรุณาใส่ชื่อ-นามสกุล');
  if (who.email === email && (role !== 'admin' || !active)) fail('self_lock', 'ลดสิทธิ์หรือปิดบัญชีของตัวเองไม่ได้');
  if (isAdminEmail(email) && (role !== 'admin' || !active)) fail('fixed_admin', email + ' เป็นผู้ดูแลระบบถาวร ลดสิทธิ์หรือปิดบัญชีไม่ได้');
  const pass = str(p.password);
  if (pass) checkPassword(pass);
  const phone = str(p.phone).trim() ? normalizePhone(p.phone) : null;
  if (phone === '') fail('bad_phone', 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก ขึ้นต้นด้วย 0 (เช่น 0812345678)');
  if (phone) {
    const other = await findUserByPhone(phone);
    if (other && other.email !== email) fail('exists', 'เบอร์ ' + phone + ' เป็นของ ' + other.name + ' อยู่แล้ว');
  }
  const row = await findUser(email);
  if (p.isNew) {
    if (row) fail('exists', 'มีบัญชีอีเมล ' + email + ' อยู่แล้ว');
    await q('INSERT INTO users (email, name, phone, role, active, pass_hash) VALUES (?, ?, ?, ?, ?, ?)', [email, name, phone, role, active ? 1 : 0, pass ? hashPassword(pass) : '']);
  } else {
    if (!row) fail('not_found', 'ไม่พบบัญชีอีเมล ' + email);
    await q('UPDATE users SET name = ?, phone = ?, role = ?, active = ? WHERE email = ?', [name, phone, role, active ? 1 : 0, email]);
    if (pass) await q('UPDATE users SET pass_hash = ? WHERE email = ?', [hashPassword(pass), email]);
    else if (p.clearPassword) await q('UPDATE users SET pass_hash = "" WHERE email = ?', [email]);
    if (!active) await q('DELETE FROM sessions WHERE email = ?', [email]);
  }
  return {};
}

async function deleteUser(p, who) {
  const email = str(p.email).trim().toLowerCase();
  if (email === who.email) fail('self_lock', 'ลบบัญชีของตัวเองไม่ได้');
  if (isAdminEmail(email)) fail('fixed_admin', email + ' เป็นผู้ดูแลระบบถาวร ลบไม่ได้');
  const r = await q('DELETE FROM users WHERE email = ?', [email]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบบัญชีอีเมล ' + email);
  await q('DELETE FROM sessions WHERE email = ?', [email]);
  return {};
}

/* ---------- อุปกรณ์ ---------- */
async function getProducts() {
  const hit = cache.get('products');
  if (hit) return hit;
  const list = (await listAllProducts()).filter(p => p.active).map(p => ({ code: p.code, name: p.name, unit: p.unit }));
  cache.put('products', list, 60);
  return list;
}

async function listAllProducts() {
  const rows = await q('SELECT * FROM products ORDER BY code');
  return rows.map(r => ({ code: r.code.toUpperCase(), name: r.name, unit: r.unit || 'ชิ้น', active: !!r.active }));
}

/* รับได้ทั้งรหัสตรง ๆ และ URL ที่มี ?item=CODE (จาก QR) */
function parseCode(raw) {
  let s = str(raw).trim();
  const m = s.match(/[?&]item=([^&#]+)/i);
  if (m) s = decodeURIComponent(m[1]);
  return s.trim().toUpperCase();
}

async function findProduct(raw) {
  const code = parseCode(raw);
  if (!code) fail('no_code', 'ไม่ได้ส่งรหัสสินค้า');
  const p = (await getProducts()).find(x => x.code === code);
  if (!p) fail('not_found', 'ไม่พบสินค้ารหัส "' + code + '"');
  return p;
}

async function addProduct(p) {
  const code = parseCode(p.code), name = str(p.name).trim().slice(0, 200), unit = str(p.unit).trim().slice(0, 50) || 'ชิ้น';
  if (!/^[A-Z0-9_-]{1,32}$/.test(code)) fail('bad_code', 'รหัสสินค้าใช้ได้เฉพาะ A-Z 0-9 _ - ไม่เกิน 32 ตัว');
  if (!name) fail('no_name', 'กรุณาใส่ชื่อสินค้า');
  return withLock(async () => {
    if (await one('SELECT code FROM products WHERE code = ?', [code])) fail('exists', 'มีสินค้ารหัส ' + code + ' อยู่แล้ว');
    if (await one('SELECT code FROM products WHERE name = ?', [name])) fail('exists', 'มีสินค้าชื่อ "' + name + '" อยู่แล้ว');
    await q('INSERT INTO products (code, name, unit, active) VALUES (?, ?, ?, 1)', [code, name, unit]);
    cache.remove('products');
    return { product: { code, name, unit } };
  });
}

/* ลบอุปกรณ์ + ภาพอ้างอิงของอุปกรณ์นั้น (บันทึกการขนส่งเดิมเก็บชื่ออุปกรณ์ไว้แล้ว จึงไม่หาย) */
async function deleteProduct(p) {
  const code = parseCode(p.code);
  const r = await q('DELETE FROM products WHERE code = ?', [code]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบอุปกรณ์รหัส ' + code);
  const refs = await q('DELETE FROM refs WHERE code = ?', [code]);
  cache.remove('products');
  return { code, refsDeleted: refs.affectedRows };
}

async function saveProduct(p) {
  const code = parseCode(p.code), name = str(p.name).trim().slice(0, 200), unit = str(p.unit).trim().slice(0, 50) || 'ชิ้น';
  if (!name) fail('no_name', 'กรุณาใส่ชื่อสินค้า');
  const r = await q('UPDATE products SET name = ?, unit = ?, active = ? WHERE code = ?', [name, unit, p.active !== false ? 1 : 0, code]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบสินค้ารหัส ' + code);
  cache.remove('products');
  return {};
}

/* ---------- บันทึกการขนส่ง ---------- */
function moveResult(m, product) {
  const t = m.ts;
  return {
    product: product || { code: m.code, name: m.name, unit: m.unit }, qty: m.qty, mover: m.mover, pickup: m.pickup, dropoff: m.dropoff,
    method: m.method, score: m.score === null || m.score === undefined ? '' : m.score, date: fmt(t, 'dd/MM/yyyy'), time: fmt(t, 'HH:mm:ss')
  };
}

async function saveMove(p, who) {
  const product = await findProduct(p.code);
  const qty = Math.floor(Number(p.qty));
  if (!qty || qty < 1 || qty > 9999) fail('bad_qty', 'จำนวนชิ้นต้องอยู่ระหว่าง 1 – 9999');
  const mover = str(p.mover).trim().slice(0, 100) || (who.kind === 'user' || who.role === 'device' ? who.name : '');
  if (!mover) fail('no_mover', 'กรุณาใส่ชื่อผู้ขนส่ง');
  let pickup = str(p.pickup).trim().slice(0, 200), dropoff = str(p.dropoff).trim().slice(0, 200);
  // งานที่มอบหมาย: หน้าเว็บส่ง assignId มา / บอร์ด ESP32 ที่ไม่ส่งสถานที่ ใช้งานล่าสุดของเจ้าของบอร์ด
  let assign = null;
  const ownerEmail = who.kind === 'user' ? who.email : str(who.owner);
  if (p.assignId) {
    assign = await findAssignment(p.assignId);
    if (assign.email !== ownerEmail && who.role !== 'admin') fail('forbidden', 'งานนี้ไม่ได้มอบหมายให้คุณ');
  } else if (who.kind === 'token' && ownerEmail && (!pickup || !dropoff)) {
    assign = await one('SELECT * FROM assignments WHERE email = ? AND status = "open" ORDER BY created_at DESC LIMIT 1', [ownerEmail]);
  }
  if (assign) { pickup = pickup || assign.pickup; dropoff = dropoff || assign.dropoff; }
  if (who.kind === 'user' && (!pickup || !dropoff)) fail('no_place', 'กรุณาใส่สถานที่รับและสถานที่ส่ง');
  const method = str(p.method).trim().slice(0, 50) || (who.role === 'device' ? 'สแกน QR' : 'เลือกเอง');
  const score = p.score === undefined || p.score === null || p.score === '' ? null : Math.round(Number(p.score) * 100);
  const id = str(p.reqId).slice(0, 80) || 'm_' + randomHex().slice(0, 16);

  return withLock(async () => {
    // ส่งซ้ำด้วย reqId เดิม (เช่น เน็ตหลุดก่อนได้คำตอบ) จะไม่บันทึกซ้ำ
    const dup = await one('SELECT * FROM moves WHERE id = ?', [id]);
    if (dup) return Object.assign(moveResult(dup), { duplicate: true });
    const photo = p.photo ? savePhoto(p.photo, product.code) : '';
    const m = { id, ts: new Date(), code: product.code, name: product.name, qty, unit: product.unit, mover, pickup, dropoff,
      method, score: Number.isFinite(score) ? score : null, source: who.deviceId.slice(0, 120), photo, assign_id: assign ? assign.id : null };
    await q('INSERT INTO moves SET ?', [m]);
    return moveResult(m, product);
  });
}

/* เก็บภาพ (data URL) เป็นไฟล์ใน PHOTO_DIR แล้วคืนลิงก์ /photos/... */
function savePhoto(dataUrl, code) {
  const m = str(dataUrl).match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return '';
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const name = code + '_' + fmt(new Date(), 'yyyyMMdd_HHmmss') + '_' + randomHex().slice(0, 6) + '.' + m[1].replace('jpeg', 'jpg');
  fs.writeFileSync(path.join(PHOTO_DIR, name), Buffer.from(m[2], 'base64'));
  return '/photos/' + name;
}

function photoThumb(url) {
  url = str(url);
  if (url.startsWith('/photos/')) return url;
  const m = url.match(/\/d\/([\w-]+)/);   // ภาพเก่าจาก Google Drive
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w200' : '';
}

/* ---------- ผลการขนส่ง ---------- */
async function getDashboardData(range) {
  const DAY = 86400000, now = Date.now();
  const dayKey = t => fmt(new Date(t), 'yyyy-MM-dd');
  const fDate = t => fmt(new Date(t), 'dd/MM/yyyy'), fTime = t => fmt(new Date(t), 'HH:mm:ss');
  const today = dayKey(now), back = { today: 0, '7d': 6, '30d': 29 }[range];
  const start = back === undefined ? '0' : dayKey(now - back * DAY);
  const products = await getProducts();

  const rows = (await q('SELECT ts, code, name, unit, qty, mover, pickup, dropoff, method, score, photo FROM moves ORDER BY ts')).map(r => ({
    t: r.ts.getTime(), key: dayKey(r.ts), hour: Number(fmt(r.ts, 'H')),
    code: r.code, name: r.name, unit: r.unit, qty: Number(r.qty) || 0,
    mover: r.mover, pickup: r.pickup || '', dropoff: r.dropoff || '', method: r.method, score: r.score === null ? '' : r.score, photo: r.photo || ''
  }));
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
  (await q('SELECT code, COUNT(*) n FROM refs GROUP BY code')).forEach(r => refCount[r.code] = Number(r.n));
  const last = rows[rows.length - 1];

  return {
    updated: fDate(now) + ' ' + fTime(now),
    kpi: {
      totalQty: inR.reduce((s, r) => s + r.qty, 0), trips: inR.length, movers: Object.keys(byM).length,
      todayQty: rows.filter(r => r.key === today).reduce((s, r) => s + r.qty, 0),
      lastMove: last ? fDate(last.t) + ' ' + fTime(last.t) : '-', routes: Object.keys(byRoute).length
    },
    methods: byMethod,
    routes: Object.values(byRoute).sort((a, b) => b.trips - a.trips).map(r => Object.assign(r, { last: fDate(r.last) + ' ' + fTime(r.last) })),
    products: Object.keys(byP).map(c => Object.assign(byP[c], { refs: refCount[c] || 0 })),
    movers: Object.values(byM).sort((a, b) => b.qty - a.qty).map(m => Object.assign(m, { last: fTime(m.last) })),
    hours,
    daily: { labels: keys.map(k => k.slice(8) + '/' + k.slice(5, 7)), series: products.map(p => ({ name: p.name, data: daily[p.code] })) },
    recent: rows.slice(-30).reverse().map(r => ({
      date: fDate(r.t), time: fTime(r.t), name: r.name, qty: r.qty, unit: r.unit,
      mover: r.mover, pickup: r.pickup, dropoff: r.dropoff, method: r.method, score: r.score, photo: photoThumb(r.photo), photoUrl: r.photo
    }))
  };
}

/* ---------- สถานที่รับ / สถานที่ส่ง ---------- */
async function getPlaces() {
  const list = (await listPlaces()).filter(x => x.active);
  return { pickups: list.filter(x => x.type !== 'dropoff').map(x => x.name), dropoffs: list.filter(x => x.type !== 'pickup').map(x => x.name) };
}

async function listPlaces() {
  const rows = await q('SELECT * FROM places');
  return rows.map(r => ({ id: r.id, name: r.name, type: PLACE_TYPES[r.type] ? r.type : 'both', active: !!r.active, createdAt: dt(r.created_at) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

async function savePlace(p, who) {
  const name = str(p.name).trim().slice(0, 200), type = PLACE_TYPES[p.type] ? str(p.type) : 'both';
  if (!name) fail('no_name', 'กรุณาใส่ชื่อสถานที่');
  return withLock(async () => {
    const same = await one('SELECT id FROM places WHERE LOWER(name) = LOWER(?) AND id <> ?', [name, str(p.id)]);
    if (same) fail('exists', 'มีสถานที่ชื่อ "' + name + '" อยู่แล้ว');
    if (p.id) {
      const r = await q('UPDATE places SET name = ?, type = ?, active = ? WHERE id = ?', [name, type, p.active !== false ? 1 : 0, str(p.id)]);
      if (!r.affectedRows) fail('not_found', 'ไม่พบสถานที่นี้ (อาจถูกลบไปแล้ว)');
      return { id: p.id };
    }
    const id = 'p_' + randomHex().slice(0, 12);
    await q('INSERT INTO places (id, name, type, active, created_by) VALUES (?, ?, ?, ?, ?)', [id, name, type, p.active !== false ? 1 : 0, who.email || '']);
    return { id };
  });
}

async function deletePlace(p) {
  const r = await q('DELETE FROM places WHERE id = ?', [str(p.id)]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบสถานที่นี้ (อาจถูกลบไปแล้ว)');
  return {};
}

/* ---------- งานที่มอบหมาย ---------- */
async function listAssignments(p) {
  const email = str(p.email).toLowerCase(), status = str(p.status);
  const where = [], args = [];
  if (email) { where.push('a.email = ?'); args.push(email); }
  if (status) { where.push('a.status = ?'); args.push(status); }
  const rows = await q(`SELECT a.*, u.name AS user_name, COUNT(m.id) AS trips, COALESCE(SUM(m.qty), 0) AS qty
    FROM assignments a LEFT JOIN users u ON u.email = a.email LEFT JOIN moves m ON m.assign_id = a.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY a.id ORDER BY a.created_at DESC`, args);
  return rows.map(r => ({
    id: r.id, email: r.email, name: r.user_name || r.email, pickup: r.pickup, dropoff: r.dropoff, note: r.note || '',
    status: r.status || 'open', createdAt: dt(r.created_at), t: r.created_at ? r.created_at.getTime() : 0,
    trips: Number(r.trips) || 0, qty: Number(r.qty) || 0
  }));
}

async function findAssignment(id) {
  const row = await one('SELECT * FROM assignments WHERE id = ?', [str(id)]);
  if (!row) fail('not_found', 'ไม่พบงานที่มอบหมายนี้ (อาจถูกลบไปแล้ว)');
  row.email = row.email.toLowerCase();
  return row;
}

async function saveAssignment(p, who) {
  const email = str(p.email).trim().toLowerCase();
  if (!await findUser(email)) fail('not_found', 'ไม่พบพนักงาน ' + email);
  const pickup = str(p.pickup).trim().slice(0, 200), dropoff = str(p.dropoff).trim().slice(0, 200);
  if (!pickup || !dropoff) fail('no_place', 'กรุณาใส่สถานที่รับและสถานที่ส่ง');
  const note = str(p.note).trim().slice(0, 300), status = p.status === 'done' ? 'done' : 'open';
  if (p.id) {
    await findAssignment(p.id);
    await q('UPDATE assignments SET email = ?, pickup = ?, dropoff = ?, note = ?, status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [email, pickup, dropoff, note, status, str(p.id)]);
    return { id: p.id };
  }
  const id = 'a_' + randomHex().slice(0, 16);
  await q('INSERT INTO assignments (id, email, pickup, dropoff, note, status, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
    [id, email, pickup, dropoff, note, status, who.email || who.deviceId]);
  return { id };
}

async function deleteAssignment(p) {
  await findAssignment(p.id);
  await q('DELETE FROM assignments WHERE id = ?', [str(p.id)]);
  return {};
}

/* ---------- จัดการบันทึกการขนส่ง (ผู้ดูแล) ---------- */
async function listMoves(p) {
  const from = str(p.from), to = str(p.to || '9999'), q1 = str(p.q).trim().toLowerCase();
  const rows = await q('SELECT * FROM moves ORDER BY ts DESC');
  return rows.map(r => ({
    id: r.id, key: fmt(r.ts, 'yyyy-MM-dd'), when: fmt(r.ts, 'yyyy-MM-dd') + 'T' + fmt(r.ts, 'HH:mm'),
    date: fmt(r.ts, 'dd/MM/yyyy'), time: fmt(r.ts, 'HH:mm'), t: r.ts.getTime(),
    code: r.code, name: r.name, qty: Number(r.qty) || 0, unit: r.unit,
    mover: r.mover, pickup: r.pickup || '', dropoff: r.dropoff || '', source: r.source || '', photoUrl: r.photo || ''
  }))
    .filter(m => m.key >= from && m.key <= to && (!q1 || [m.mover, m.name, m.pickup, m.dropoff, m.code].join(' ').toLowerCase().indexOf(q1) >= 0))
    .slice(0, 500);
}

async function moveFields(p) {
  const product = await findProduct(p.code), qty = Math.floor(Number(p.qty));
  if (!qty || qty < 1 || qty > 9999) fail('bad_qty', 'จำนวนต้องอยู่ระหว่าง 1 – 9999');
  const mover = str(p.mover).trim(), pickup = str(p.pickup).trim(), dropoff = str(p.dropoff).trim();
  if (!mover || !pickup || !dropoff) fail('missing', 'กรุณากรอกผู้ขนส่ง สถานที่รับ และสถานที่ส่ง');
  const when = p.when ? new Date(str(p.when).slice(0, 16) + ':00+07:00') : new Date();
  if (isNaN(when.getTime())) fail('bad_date', 'วันที่และเวลาไม่ถูกต้อง');
  return { ts: when, code: product.code, name: product.name, qty, unit: product.unit,
    mover: mover.slice(0, 100), pickup: pickup.slice(0, 200), dropoff: dropoff.slice(0, 200) };
}

async function addMove(p, who) {
  const f = await moveFields(p), id = 'm_' + randomHex().slice(0, 16);
  await q('INSERT INTO moves SET ?', [Object.assign(f, { id, method: 'ผู้ดูแลเพิ่ม', source: ('admin:' + who.email).slice(0, 120) })]);
  return { id };
}

async function updateMove(p) {
  const f = await moveFields(p);
  const r = await q('UPDATE moves SET ? WHERE id = ?', [f, str(p.id)]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบรายการนี้ (อาจถูกลบไปแล้ว)');
  return { id: p.id };
}

async function deleteMove(p) {
  const r = await q('DELETE FROM moves WHERE id = ?', [str(p.id)]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบรายการนี้ (อาจถูกลบไปแล้ว)');
  return {};
}

/* ---------- ยืม-คืนรถเข็น ----------
   ขั้นตอน (หน้า /cart): ใส่เบอร์โทร → ระบบแสดงชื่อพนักงาน → เลือกรถเข็น → ยืนยันตัวตน → หน้าจอยืนยันการใช้
   คืน: ใส่เบอร์โทร → เห็นรถที่ยืมอยู่ → ยืนยันตัวตน → หน้าจอยืนยันการคืน
   ยืนยันตัวตน: พนักงานที่ตั้ง PIN/รหัสผ่านไว้ ต้องใส่ PIN (ผิด 5 ครั้งล็อก 15 นาที), ยังไม่ได้ตั้ง = กดยืนยันว่าเป็นตัวเอง
   กติกา: คนละ 1 คันในเวลาเดียวกัน, รถที่ถูกยืมอยู่ยืมซ้ำไม่ได้ */
/* หน้าแรก: ระบุตัวพนักงานด้วย เบอร์โทร 10 หลัก หรือ อีเมล (ส่งมาในช่อง phone) */
async function cartPerson(p, via) {
  const id = str(p.phone).trim();
  const email = EMAIL_RE.test(id) ? id.toLowerCase() : '', phone = email ? '' : normalizePhone(id);
  if (!email && !phone) fail('bad_phone', 'กรุณาใส่เบอร์โทร 10 หลัก หรืออีเมลให้ถูกต้อง');
  const key = 'cart:' + str(via.ip), n = Number(cache.get(key) || 0);
  if (n >= 60) fail('rate_limited', 'ใช้งานบ่อยเกินไป กรุณารอสักครู่');
  cache.put(key, String(n + 1), 300);
  const row = email ? await findUser(email) : await findUserByPhone(phone);
  if (!row || !row.active) fail('not_found', 'ไม่พบ' + (email ? 'อีเมล ' + email : 'เบอร์ ' + phone) + ' ในระบบ กรุณาแจ้งผู้ดูแลระบบให้ลงทะเบียน');
  return row;
}

/* หน้าแรก (แท็บพนักงาน): ยืนยันตัวตนด้วยการติ๊ก "ฉันคือ …" ไม่ต้องใส่ PIN
   (ผู้ดูแลระบบเข้าสู่ระบบได้เฉพาะแท็บผู้ดูแลระบบด้วยรหัสผ่าน ดู cartSession) */
async function verifyPerson(row, p) {
  if (p.confirm !== true) fail('need_confirm', 'กรุณาติ๊กยืนยันว่าคุณคือ ' + row.name);
  return 'confirm';
}

const openLoanOf = email => one('SELECT * FROM cart_loans WHERE email = ? AND returned_at IS NULL ORDER BY borrowed_at DESC LIMIT 1', [email]);
const loanOut = l => l && ({
  id: l.id, cartId: l.cart_id, cartName: l.cart_name, name: l.name, phone: l.phone, verifiedBy: l.verified_by,
  borrowedAt: dt(l.borrowed_at), since: fmt(l.borrowed_at, 'HH:mm'), returnedAt: dt(l.returned_at), returnedBy: l.returned_by || '',
  minutes: Math.max(0, Math.round(((l.returned_at || new Date()) - l.borrowed_at) / 60000))
});
const availableCarts = () => q(`SELECT c.id, c.name FROM carts c WHERE c.active = 1
  AND NOT EXISTS (SELECT 1 FROM cart_loans l WHERE l.cart_id = c.id AND l.returned_at IS NULL) ORDER BY c.id`);

async function cartLookup(p, who, via) {
  const row = await cartPerson(p, via);
  const admin = row.role === 'admin' || isAdminEmail(row.email);
  return { name: row.name, hasPin: false, admin, loan: await loanWithMoves(await openLoanOf(row.email)), carts: await availableCarts() };
}

/* หน้าแรก: เข้าสู่ระบบด้วยเบอร์โทร โดยไม่ยืม/คืนรถเข็น (ยืนยันตัวตนแบบเดียวกัน) */
async function phoneLogin(p, who, via) {
  const row = await cartPerson(p, via);
  const verified = await verifyPerson(row, p);
  const s = await cartSession(row, verified);
  if (!s.session) fail('use_admin_tab', 'ผู้ดูแลระบบกรุณาเข้าสู่ระบบที่แท็บ "ผู้ดูแลระบบ" ด้วยรหัสผ่าน');
  return s;
}

async function cartBorrow(p, who, via) {
  const row = await cartPerson(p, via);
  const verified = await verifyPerson(row, p);
  const loan = await borrowFor(row, p.cartId, verified);
  return Object.assign({ loan }, await cartSession(row, verified));
}

/* ยืมรถเข็นให้พนักงานคนนี้ (ใช้ทั้งหน้าแรกและปุ่มในแอป) */
function borrowFor(row, cartId0, verified) {
  const cartId = str(cartId0).trim().toUpperCase();
  return withLock(async () => {
    const mine = await openLoanOf(row.email);
    if (mine) fail('has_cart', 'คุณยืม ' + mine.cart_name + ' อยู่ กรุณาคืนก่อนยืมคันใหม่');
    const cart = await one('SELECT * FROM carts WHERE id = ?', [cartId]);
    if (!cart || !cart.active) fail('not_found', 'ไม่พบรถเข็น ' + cartId + ' หรือรถเข็นนี้ปิดใช้งานอยู่');
    const busy = await one('SELECT name FROM cart_loans WHERE cart_id = ? AND returned_at IS NULL', [cart.id]);
    if (busy) fail('cart_busy', cart.name + ' ถูกยืมโดย ' + busy.name + ' อยู่');
    const loan = { id: 'l_' + randomHex().slice(0, 16), cart_id: cart.id, cart_name: cart.name, email: row.email, name: row.name,
      phone: row.phone || '', verified_by: verified, borrowed_at: new Date() };
    await q('INSERT INTO cart_loans SET ?', [loan]);
    return loanOut(loan);
  });
}

/* คืนรถเข็นที่พนักงานคนนี้ยืมอยู่ */
/* จำนวนบันทึกการขนส่งที่พนักงานคนนี้บันทึกระหว่างยืมรถคันนี้ (บันทึกจากหน้าเว็บ = source web:อีเมล) */
async function loanMoves(loan) {
  const r = await one('SELECT COUNT(*) n FROM moves WHERE source = ? AND ts >= ?', ['web:' + loan.email, loan.borrowed_at]);
  return Number(r.n) || 0;
}
async function loanWithMoves(loan) {
  if (!loan) return null;
  return Object.assign(loanOut(loan), { moves: await loanMoves(loan) });
}

/* คืนรถเข็นที่พนักงานคนนี้ยืมอยู่: ต้องบันทึกการขนส่งอย่างน้อย 1 รายการระหว่างยืมก่อน */
function returnFor(row) {
  return withLock(async () => {
    const loan = await openLoanOf(row.email);
    if (!loan) fail('no_loan', 'คุณไม่มีรถเข็นที่ยืมอยู่');
    if (!await loanMoves(loan)) fail('need_move', 'กรุณาบันทึกการขนส่งก่อน จึงจะคืนรถเข็นได้');
    loan.returned_at = new Date(); loan.returned_by = 'self';
    await q('UPDATE cart_loans SET returned_at = ?, returned_by = ? WHERE id = ?', [loan.returned_at, 'self', loan.id]);
    return loanOut(loan);
  });
}

/* ในแอป (เข้าสู่ระบบแล้ว): ปุ่มยืม/คืนรถเข็น ไม่ต้องยืนยันตัวตนซ้ำ */
async function myCart(p, who) {
  return { loan: await loanWithMoves(await openLoanOf(who.email)), carts: await availableCarts() };
}
async function borrowMyCart(p, who) {
  const row = await findUser(who.email);
  return { loan: await borrowFor(row, p.cartId, 'login') };
}
async function returnMyCart(p, who) {
  const row = await findUser(who.email);
  return { loan: await returnFor(row) };
}

/* ยืนยันตัวตนแล้ว → เข้าสู่ระบบแอปหลัก (/app) ให้เลย (ผู้ดูแลต้องยืนยันด้วย PIN เท่านั้น การติ๊กชื่อไม่พอ) */
async function cartSession(row, verified) {
  const admin = row.role === 'admin' || isAdminEmail(row.email);
  if (admin && verified !== 'pin') return {};
  const s = await startSession(row);
  return { session: s.session, user: s.user };
}

async function cartReturn(p, who, via) {
  const row = await cartPerson(p, via);
  const verified = await verifyPerson(row, p);
  const loan = await returnFor(row);
  return Object.assign({ loan }, await cartSession(row, verified));
}

async function listCarts() {
  const rows = await q(`SELECT c.*, l.id loan_id, l.name loan_name, l.phone loan_phone, l.borrowed_at
    FROM carts c LEFT JOIN cart_loans l ON l.cart_id = c.id AND l.returned_at IS NULL ORDER BY c.id`);
  return rows.map(r => ({
    id: r.id, name: r.name, active: !!r.active,
    loan: r.loan_id ? { id: r.loan_id, name: r.loan_name, phone: r.loan_phone, borrowedAt: dt(r.borrowed_at) } : null
  }));
}

async function saveCart(p) {
  const id = str(p.id).trim().toUpperCase(), name = str(p.name).trim().slice(0, 100);
  if (!/^[A-Z0-9_-]{1,32}$/.test(id)) fail('bad_code', 'รหัสรถเข็นใช้ได้เฉพาะ A-Z 0-9 _ - ไม่เกิน 32 ตัว');
  if (!name) fail('no_name', 'กรุณาใส่ชื่อรถเข็น');
  const row = await one('SELECT id FROM carts WHERE id = ?', [id]);
  if (p.isNew) {
    if (row) fail('exists', 'มีรถเข็นรหัส ' + id + ' อยู่แล้ว');
    await q('INSERT INTO carts (id, name, active) VALUES (?, ?, ?)', [id, name, p.active !== false ? 1 : 0]);
  } else {
    if (!row) fail('not_found', 'ไม่พบรถเข็น ' + id);
    await q('UPDATE carts SET name = ?, active = ? WHERE id = ?', [name, p.active !== false ? 1 : 0, id]);
  }
  return { id };
}

async function deleteCart(p) {
  const id = str(p.id).trim().toUpperCase();
  if (await one('SELECT id FROM cart_loans WHERE cart_id = ? AND returned_at IS NULL', [id])) fail('cart_busy', 'รถเข็นนี้ถูกยืมอยู่ ต้องคืนก่อนจึงลบได้');
  const r = await q('DELETE FROM carts WHERE id = ?', [id]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบรถเข็น ' + id);
  return {};
}

async function listCartLoans(p) {
  const open = p.open ? ' WHERE returned_at IS NULL' : '';
  return (await q('SELECT * FROM cart_loans' + open + ' ORDER BY borrowed_at DESC LIMIT 200')).map(loanOut);
}

async function forceReturn(p, who) {
  const loan = await one('SELECT * FROM cart_loans WHERE id = ? AND returned_at IS NULL', [str(p.id)]);
  if (!loan) fail('not_found', 'ไม่พบรายการยืมที่ยังไม่คืน');
  await q('UPDATE cart_loans SET returned_at = UTC_TIMESTAMP(), returned_by = ? WHERE id = ?', [('admin:' + who.email).slice(0, 120), loan.id]);
  return {};
}

/* ---------- ภาพอ้างอิงและไฟล์โมเดล (จำภาพอุปกรณ์) ---------- */
async function getRefs(code) {
  const c = code ? parseCode(code) : '';
  const rows = await q('SELECT * FROM refs' + (c ? ' WHERE code = ?' : '') + ' ORDER BY ts', c ? [c] : []);
  return rows.filter(r => r.vec).map(r => ({ id: r.id, code: r.code, name: r.name, vec: r.vec, thumb: r.thumb || '', addedBy: r.added_by }));
}

async function addRef(p, who) {
  const product = await findProduct(p.code), vec = str(p.vec), thumb = str(p.thumb);
  if (!/^[A-Za-z0-9+/=]{100,49000}$/.test(vec)) fail('bad_vec', 'vec ต้องเป็น base64 จาก CargoVision.vecToB64');
  if (thumb && !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]{1,45000}$/.test(thumb)) fail('bad_thumb', 'ภาพย่อต้องเป็น JPEG ขนาดไม่เกิน ~33 KB');
  const id = randomHex().slice(0, 8);
  await q('INSERT INTO refs (id, code, name, vec, thumb, added_by) VALUES (?, ?, ?, ?, ?, ?)',
    [id, product.code, product.name, vec, thumb, str(p.addedBy || who.name).slice(0, 200)]);
  return { id };
}

async function deleteRef(p) {
  const r = await q('DELETE FROM refs WHERE id = ?', [str(p.id)]);
  if (!r.affectedRows) fail('not_found', 'ไม่พบภาพ ' + p.id);
  return {};
}

let MODEL_ = null;
function modelText() {
  if (!fs.existsSync(MODEL_PATH)) fail('no_model', 'ไม่พบไฟล์โมเดล ' + MODEL_PATH);
  const mtime = fs.statSync(MODEL_PATH).mtimeMs;
  if (!MODEL_ || MODEL_.mtime !== mtime) MODEL_ = { mtime, text: fs.readFileSync(MODEL_PATH, 'utf8') };
  return MODEL_.text;
}
function modelInfo() {
  const text = modelText();
  return { version: 'local-' + Math.round(MODEL_.mtime), chunks: Math.ceil(text.length / MODEL_CHUNK) };
}

module.exports = { handle, PHOTO_DIR, hashPassword, checkPassword, isAdminEmail };
