/*
 * เครื่องมือผู้ดูแลระบบ (รันบนเครื่องเซิร์ฟเวอร์)
 *   npm run passwd -- <อีเมล> <รหัสผ่าน>     ตั้งรหัสผ่าน (สร้างบัญชีผู้ดูแลถาวรให้ถ้ายังไม่มี)
 */
const db = require('./db');
const { hashPassword, checkPassword, isAdminEmail } = require('./actions');

(async () => {
  const [cmd, email0, pass] = process.argv.slice(2);
  if (cmd !== 'passwd' || !email0 || !pass) {
    console.log('ใช้: npm run passwd -- <อีเมล> <รหัสผ่าน>');
    process.exit(1);
  }
  const email = email0.trim().toLowerCase();
  try { checkPassword(pass); } catch (e) { console.error(e.message); process.exit(1); }
  await db.init();
  let u = await db.one('SELECT email FROM users WHERE email = ?', [email]);
  if (!u && isAdminEmail(email)) {
    await db.q('INSERT INTO users (email, name, role, active) VALUES (?, ?, "admin", 1)', [email, email]);
    u = { email };
  }
  if (!u) { console.error('ไม่พบบัญชี ' + email + ' (เพิ่มบัญชีในหน้าผู้ดูแลระบบก่อน)'); process.exit(1); }
  await db.q('UPDATE users SET pass_hash = ? WHERE email = ?', [hashPassword(pass), email]);
  console.log('ตั้งรหัสผ่านให้ ' + email + ' แล้ว');
  await db.pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
