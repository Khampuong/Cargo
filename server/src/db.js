/* เชื่อมต่อ MySQL (mysql2) และสร้างตารางจาก schema.sql ตอนเริ่ม */
const fs = require('fs'), path = require('path'), mysql = require('mysql2/promise');

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'cargo',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'cargo',
  charset: 'utf8mb4',
  timezone: 'Z'            // เก็บ/อ่าน DATETIME เป็น UTC
};

const pool = mysql.createPool(Object.assign({ waitForConnections: true, connectionLimit: 10 }, cfg));

async function q(sql, params) {
  const [rows] = await pool.query(sql, params || []);
  return rows;
}
async function one(sql, params) {
  return (await q(sql, params))[0] || null;
}

const SEED_PRODUCTS = [
  ['TABLE', 'โต๊ะ', 'ตัว'], ['CHAIR', 'เก้าอี้', 'ตัว'], ['SOFA', 'โซฟา', 'ตัว'],
  ['STAND', 'แท่น', 'แท่น'], ['WATER', 'ขวดน้ำ', 'ขวด']
];

/* สร้างตารางที่ยังไม่มี (ไม่ลบข้อมูลเดิม) + อุปกรณ์ตั้งต้นเมื่อยังว่าง รอ MySQL พร้อมสูงสุด ~60 วินาที */
async function init() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  let conn;
  for (let i = 0; ; i++) {
    try { conn = await mysql.createConnection(Object.assign({ multipleStatements: true }, cfg)); break; }
    catch (e) {
      if (i >= 30) throw new Error('เชื่อมต่อ MySQL ไม่ได้ (' + cfg.host + ':' + cfg.port + '): ' + e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  try {
    await conn.query(sql);
    // ปรับตารางจากเวอร์ชันก่อน: เพิ่มคอลัมน์ที่ยังไม่มี
    const [cols] = await conn.query("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'");
    if (!cols.some(x => x.c === 'phone')) {
      await conn.query("ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL COMMENT 'เบอร์โทรศัพท์ (ตัวเลขล้วน เช่น 0812345678) ใช้เข้าสู่ระบบแทนอีเมลได้' AFTER name, ADD UNIQUE KEY uq_users_phone (phone)");
    }
    const [[vb]] = await conn.query("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart_loans' AND COLUMN_NAME = 'verified_by'");
    if (vb && !/'login'/.test(vb.t)) {
      await conn.query("ALTER TABLE cart_loans MODIFY verified_by ENUM('pin','confirm','login') NOT NULL COMMENT 'pin / confirm = ติ๊กยืนยันชื่อที่หน้าแรก / login = กดจากในแอป (เข้าสู่ระบบแล้ว)'");
    }
    const [[c]] = await conn.query('SELECT COUNT(*) n FROM products');
    if (!c.n) await conn.query('INSERT INTO products (code, name, unit, active) VALUES ?', [SEED_PRODUCTS.map(r => r.concat([1]))]);
    const [[cc]] = await conn.query('SELECT COUNT(*) n FROM carts');
    if (!cc.n) await conn.query('INSERT INTO carts (id, name) VALUES ?', [[['CART-01', 'รถเข็น 1'], ['CART-02', 'รถเข็น 2'], ['CART-03', 'รถเข็น 3']]]);
  } finally {
    await conn.end();
  }
}

async function getSetting(name) {
  const r = await one('SELECT value FROM settings WHERE name = ?', [name]);
  return r ? r.value : '';
}
async function setSetting(name, value) {
  if (value === null || value === undefined || value === '') return q('DELETE FROM settings WHERE name = ?', [name]);
  return q('INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, String(value)]);
}

module.exports = { pool, q, one, init, getSetting, setSetting, cfg };
