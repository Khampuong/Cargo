/*
 * Cargo Bot: เซิร์ฟเวอร์ Node.js + MySQL
 *
 *   GET  /                หน้าแรก: ระบบการใช้รถเข็น (views/cart.html) ไม่ต้องเข้าสู่ระบบ
 *   GET  /app             แอปบันทึกการขนส่ง + ผู้ดูแลระบบ (gas/Index.html) หน้าเว็บเรียก google.script.run.rpc → POST /rpc
 *   POST /rpc             { action, params, session }
 *   GET|POST /api         API สำหรับ ESP32 / ระบบภายนอก (เหมือน /exec ของ Apps Script) /exec ใช้ได้ด้วย
 *                         POST body JSON: {"token":"cb_...","deviceId":"ESP32-01","action":"saveMove","code":"TABLE","qty":2}
 *   GET  /photos/<ไฟล์>   ภาพถ่ายที่บันทึกไว้
 *   GET  /health          ตรวจว่าเซิร์ฟเวอร์และฐานข้อมูลพร้อม
 */
const fs = require('fs'), path = require('path'), express = require('express');
const db = require('./db');
const { handle, PHOTO_DIR } = require('./actions');

const PORT = Number(process.env.PORT || 3100);
const GAS = path.join(__dirname, '..', '..', 'gas');

/* google.script.run จำลองบนเบราว์เซอร์: หน้าเว็บเดิมใช้ได้โดยไม่ต้องแก้ */
const SHIM = `<script>
window.google = window.google || {};
google.script = { run: (function () {
  function runner() {
    let ok = function () {}, fail = function () {};
    const r = {
      withSuccessHandler(f) { ok = f; return r; },
      withFailureHandler(f) { fail = f; return r; },
      rpc(action, params, session) {
        fetch('rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, params, session }) })
          .then(res => res.json()).then(ok, fail);
      }
    };
    return r;
  }
  return new Proxy({}, { get: (t, k) => runner()[k] });
})() };
</script>`;

function renderIndex() {
  const html = fs.readFileSync(path.join(GAS, 'Index.html'), 'utf8')
    .replace(/<\?!=\s*include_\('(\w+)'\)\s*\?>/g, (_, n) => fs.readFileSync(path.join(GAS, n + '.html'), 'utf8'));
  return html.replace('<head>', '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Cargo Bot · ระบบรถขนส่งอเนกประสงค์</title>\n' + SHIM);
}

const baseUrl = req => (req.headers['x-forwarded-proto'] || req.protocol) + '://' + (req.headers['x-forwarded-host'] || req.headers.host);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* หน้าแรก = ยืม-คืนรถเข็น (ไม่ต้องเข้าสู่ระบบ) ปุ่ม "ผู้ดูแลระบบ" ไปที่ /app */
const cartPage = (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, '..', 'views', 'cart.html'));
app.get('/', cartPage);
/* แอปหลัก (บันทึกการขนส่ง / ผู้ดูแลระบบ) ต้องเข้าสู่ระบบ */
app.get('/app', (req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(renderIndex());
});

/* หน้ายืม-คืนรถเข็น (ใช้เบอร์โทร ไม่ต้องเข้าสู่ระบบ) /cart?cart=CART-01 = เลือกรถคันนี้ให้เลย (ใช้ทำ QR ติดรถ) */
app.get('/cart', cartPage);

app.post('/rpc', express.json({ limit: '12mb' }), async (req, res) => {
  const { action, params, session } = req.body || {};
  const p = Object.assign({}, params, { action: String(action || ''), session: session || '' });
  res.json(await handle(p, { baseUrl: baseUrl(req), ip: req.ip }));
});

/* API ของ ESP32: รับ body เป็น text/plain หรือ application/json (เหมือน Apps Script) */
async function api(req, res) {
  let body = {};
  if (req.method === 'POST' && req.body && String(req.body).trim()) {
    try { body = typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(String(req.body)); }
    catch (e) { return res.json({ ok: false, error: 'bad_json', message: 'body ต้องเป็น JSON' }); }
  }
  const p = Object.assign({}, req.query, body);
  delete p.session;   // API ใช้ token เท่านั้น
  res.set('Access-Control-Allow-Origin', '*').json(await handle(p, { baseUrl: baseUrl(req) }));
}
const apiBody = express.text({ type: () => true, limit: '12mb' });
app.options(['/api', '/exec'], (req, res) => res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }).sendStatus(204));
app.get(['/api', '/exec'], api);
app.post(['/api', '/exec'], apiBody, api);

app.use('/photos', express.static(PHOTO_DIR, { maxAge: '7d', fallthrough: false }));

app.get('/health', async (req, res) => {
  try { await db.q('SELECT 1'); res.json({ ok: true, db: db.cfg.host + ':' + db.cfg.port + '/' + db.cfg.database }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.use((req, res) => res.status(404).type('text').send('ไม่พบหน้านี้'));

db.init().then(() => {
  app.listen(PORT, () => {
    console.log('Cargo Bot (Node.js + MySQL): http://localhost:' + PORT);
    console.log('ฐานข้อมูล: mysql://' + db.cfg.user + '@' + db.cfg.host + ':' + db.cfg.port + '/' + db.cfg.database);
    console.log('API สำหรับ ESP32: http://localhost:' + PORT + '/api');
  });
}).catch(e => { console.error(e.message); process.exit(1); });
