/*
 * Cargo Bot — Cloudflare Worker หน้าบ้านของ Google Apps Script
 *
 *   /            แสดงหน้าแอป (ฝัง URL /exec ของ Apps Script เต็มจอ) บนโดเมนของเรา
 *   /api         API สำหรับ ESP32 / ระบบภายนอก: ส่งต่อไปที่ Apps Script แล้วตาม redirect ให้
 *                บอร์ดได้ JSON กลับทันที (ไม่ต้องจัดการ 302 ของ Google เอง)
 *   /health      ตรวจว่า Worker ทำงานและตั้งค่าแล้ว
 *
 * ตั้งค่าใน wrangler.toml: APPS_SCRIPT_URL = URL ของ Web app (ลงท้ายด้วย /exec)
 */

const REDIRECTS = [301, 302, 303, 307, 308];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = String(env.APPS_SCRIPT_URL || '');
    if (!/^https?:\/\/.+\/exec$/.test(target)) {
      return text('ยังไม่ได้ตั้ง APPS_SCRIPT_URL ใน wrangler.toml (ต้องลงท้ายด้วย /exec)', 500);
    }
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/api' || url.pathname === '/exec') return cors(await proxyApi(request, url, target));
    if (url.pathname === '/health') return cors(json({ ok: true, target: new URL(target).host }));
    if (url.pathname === '/' && request.method === 'GET') return page(target, env.APP_TITLE || 'Cargo Bot');
    return text('ไม่พบหน้านี้', 404);
  }
};

/* ส่งคำขอต่อไปที่ Apps Script: POST ทำงานที่ /exec แล้ว Google ตอบ 302 ไปหน้าผลลัพธ์ จึงตามไปอ่านด้วย GET */
async function proxyApi(request, url, target) {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ ok: false, error: 'method', message: 'ใช้ได้เฉพาะ GET / POST' }, 405);
  const dest = new URL(target);
  url.searchParams.forEach((v, k) => dest.searchParams.set(k, v));
  const init = { method: request.method, redirect: 'manual', headers: { 'Content-Type': 'text/plain;charset=utf-8' } };
  if (request.method === 'POST') {
    init.body = await request.text();
    if (init.body.length > 2000000) return json({ ok: false, error: 'too_large', message: 'ข้อมูลใหญ่เกิน 2 MB' }, 413);
  }
  let res;
  try {
    res = await fetch(dest.toString(), init);
    for (let i = 0; i < 4 && REDIRECTS.includes(res.status); i++) {
      const loc = res.headers.get('Location');
      if (!loc) break;
      res = await fetch(new URL(loc, dest).toString(), { method: 'GET', redirect: 'manual' });
    }
  } catch (e) {
    return json({ ok: false, error: 'upstream', message: 'ติดต่อ Google Apps Script ไม่ได้: ' + e.message }, 502);
  }
  const body = await res.text();
  if (res.status !== 200 || !body.trim().startsWith('{')) {
    return json({ ok: false, error: 'upstream_' + res.status, message: 'Apps Script ตอบกลับผิดปกติ (ตรวจว่า Deploy เป็น Anyone แล้ว)' }, 502);
  }
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/* หน้าแอป: ฝัง Apps Script เต็มจอ (Code.gs ตั้ง XFrameOptionsMode.ALLOWALL ไว้แล้ว) */
function page(target, title) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  html, body { margin:0; height:100%; background:#f3f5f7; }
  @media (prefers-color-scheme: dark) { html, body { background:#0f151c; } }
  iframe { border:0; width:100%; height:100%; display:block; }
</style></head>
<body><iframe src="${esc(target)}" title="${esc(title)}" allow="clipboard-write; camera"></iframe></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function text(msg, status) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
