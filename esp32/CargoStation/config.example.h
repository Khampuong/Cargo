// คัดลอกไฟล์นี้เป็น config.h แล้วใส่ค่าจริง (config.h ไม่ถูก commit ขึ้น git)
#pragma once

#define WIFI_SSID     "your-wifi"
#define WIFI_PASS     "your-password"

// URL จาก Deploy > Web app ของ Apps Script (ลงท้ายด้วย /exec) หรือ https://<โดเมน Cloudflare>/api
#define API_URL       "https://script.google.com/macros/s/XXXXXXXXXXXX/exec"

// คัดลอกจากหน้าแอป เมนู "เชื่อมต่อ ESP32" (ผู้ดูแลระบบ)
// DEVICE_TOKEN = Token ระบบ ใช้ร่วมกันทุกบอร์ด / DEVICE_ID = รหัสบอร์ด ต้องไม่ซ้ำกันในแต่ละบอร์ด
#define DEVICE_ID     "ESP32-01"
#define DEVICE_TOKEN  "cb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

// ชื่อผู้ขนเริ่มต้น ("" = ใช้พนักงานที่ผู้ดูแลกำหนดให้บอร์ดนี้ หรือรหัสบอร์ด) เปลี่ยนได้ด้วยการสแกน QR "MOVER:ชื่อ"
#define DEFAULT_MOVER ""

// สถานที่รับ / สถานที่ส่งของสถานีนี้ ("" = ไม่ระบุ) เปลี่ยนได้ด้วยการสแกน QR "FROM:ชื่อสถานที่" และ "TO:ชื่อสถานที่"
#define DEFAULT_PICKUP  ""
#define DEFAULT_DROPOFF ""
