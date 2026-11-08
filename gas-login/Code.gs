/*
 * Cargo Bot: แอปยืนยันตัวตนด้วยอีเมล Google
 * Deploy แบบ Execute as: User accessing the web app / Who has access: Anyone with a Google account
 * → Google ให้คนที่เปิดลงชื่อเข้าใช้ Google แล้วบอกอีเมลให้แอปนี้ (ขอสิทธิ์แค่ "ดูอีเมลของคุณ")
 * แล้วส่ง ticket ที่เซ็นด้วย LOGIN_SECRET กลับไปที่ Cargo Bot (MAIN_APP_URL?t=...) ใช้ได้ครั้งเดียว ภายใน 5 นาที
 * LOGIN_SECRET และ MAIN_APP_URL อยู่ใน Secret.gs (สร้างโดย dev/deploy.js ไม่เก็บใน git)
 */
const TICKET_MS = 5 * 60 * 1000;

function doGet() {
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const page = HtmlService.createTemplateFromFile('Login');
  page.email = email;
  page.link = email ? MAIN_APP_URL + '?t=' + encodeURIComponent(ticket_(email)) : '';
  return page.evaluate()
    .setTitle('เข้าสู่ระบบ Cargo Bot')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function ticket_(email) {
  const body = email + '~' + (Date.now() + TICKET_MS);
  const sig = Utilities.computeHmacSha256Signature(body, LOGIN_SECRET)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  return body + '~' + sig;
}
