/*
 * CargoAPI — เรียก Cargo Bot API (Google Apps Script) จากหน้าเว็บ
 * ใช้ token สิทธิ์ "web" (คนที่เปิดหน้าเว็บมองเห็น token นี้ได้ จึงอย่าใช้ token สิทธิ์ admin)
 *
 *   CargoAPI.init({ url: 'https://script.google.com/macros/s/XXXX/exec', token: 'cb_...' });
 *   const r = await CargoAPI.saveMove('TABLE', 2, 'สมชาย', { method: 'ภาพถ่าย', score: 0.71, photo: dataUrl });
 *   const d = await CargoAPI.dashboard('7d');   // โครงสร้างเดียวกับ getDashboardData() ในหน้าเว็บ
 */
(function (root) {
  'use strict';
  let cfg = { url: '', token: '' };

  function reqId() {
    return (root.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  async function call(action, params) {
    if (!cfg.url) throw new Error('ยังไม่ได้ตั้งค่า CargoAPI.init({ url, token })');
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // text/plain เพื่อไม่ให้เกิด CORS preflight
      body: JSON.stringify(Object.assign({ action: action, token: cfg.token }, params))
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) { const e = new Error(data.message || data.error); e.code = data.error; throw e; }
    return data;
  }

  root.CargoAPI = {
    init(c) { cfg = Object.assign({}, cfg, c); },
    call,
    ping: () => call('ping'),
    products: () => call('products').then(r => r.products),
    lookup: code => call('lookup', { code }).then(r => r.product),
    saveMove: (code, qty, mover, extra) => call('saveMove', Object.assign({ code, qty, mover, reqId: reqId() }, extra)),
    dashboard: range => call('dashboard', { range }),
    refs: code => call('refs', { code }).then(r => r.refs),
    addRef: (code, vec, addedBy) => call('addRef', { code, vec, addedBy }).then(r => r.id),
    addProduct: (code, name, unit) => call('addProduct', { code, name, unit }).then(r => r.product)
  };
})(typeof window !== 'undefined' ? window : globalThis);
