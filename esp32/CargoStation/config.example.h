// คัดลอกไฟล์นี้เป็น config.h แล้วใส่ค่าจริง (config.h ไม่ถูก commit ขึ้น git)
#pragma once

#define WIFI_SSID     "your-wifi"
#define WIFI_PASS     "your-password"

// URL จาก Deploy > Web app ของ Apps Script (ลงท้ายด้วย /exec)
#define API_URL       "https://script.google.com/macros/s/XXXXXXXXXXXX/exec"

// สร้างจากเมนู Cargo Bot > สร้าง Token ในชีต (สิทธิ์ device)
#define DEVICE_ID     "ESP32-01"
#define DEVICE_TOKEN  "cb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

// ชื่อผู้ขนเริ่มต้น ("" = ใช้ชื่ออุปกรณ์ในชีต Devices) เปลี่ยนได้ด้วยการสแกน QR "MOVER:ชื่อ"
#define DEFAULT_MOVER ""

// สถานที่รับ / สถานที่ส่งของสถานีนี้ ("" = ไม่ระบุ) เปลี่ยนได้ด้วยการสแกน QR "FROM:ชื่อสถานที่" และ "TO:ชื่อสถานที่"
#define DEFAULT_PICKUP  ""
#define DEFAULT_DROPOFF ""
