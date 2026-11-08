// พิมพ์โครงสร้างฐานข้อมูลจาก gas/Code.gs เป็น JSON (ใช้กับ dev/build_db.py)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8'), ctx);
const get = expr => vm.runInContext(expr, ctx);
process.stdout.write(JSON.stringify({
  sheets: get('SHEETS'), products: get('SEED_PRODUCTS'), admins: get('ADMIN_EMAILS'),
  docSheet: get('DOC_SHEET'), docs: get('fieldDocRows_()')
}));
