-- Cargo Bot: ฐานข้อมูล MySQL 8 (utf8mb4)
-- เซิร์ฟเวอร์รันไฟล์นี้เองทุกครั้งที่เริ่ม (CREATE TABLE IF NOT EXISTS ไม่ลบข้อมูลเดิม)
-- เวลาทั้งหมดเก็บเป็น UTC (DATETIME) แสดงผลเป็นเวลาไทย (Asia/Bangkok)

-- อุปกรณ์ที่ขนส่ง
CREATE TABLE IF NOT EXISTS products (
  code        VARCHAR(32)  NOT NULL PRIMARY KEY COMMENT 'รหัสอุปกรณ์ (A-Z 0-9 _ -)',
  name        VARCHAR(200) NOT NULL COMMENT 'ชื่ออุปกรณ์',
  unit        VARCHAR(50)  NOT NULL DEFAULT 'ชิ้น' COMMENT 'หน่วยนับ',
  active      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'ใช้งานอยู่',
  UNIQUE KEY uq_products_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='อุปกรณ์ที่ขนส่ง';

-- บัญชีผู้ใช้งาน
CREATE TABLE IF NOT EXISTS users (
  email       VARCHAR(100) NOT NULL PRIMARY KEY COMMENT 'อีเมลที่ใช้เข้าสู่ระบบ (ตัวพิมพ์เล็ก)',
  name        VARCHAR(200) NOT NULL COMMENT 'ชื่อ-นามสกุล',
  role        ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT 'user = พนักงาน, admin = ผู้ดูแลระบบ',
  active      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'เปิดใช้งานบัญชี',
  pass_hash   VARCHAR(200) NOT NULL DEFAULT '' COMMENT 'รหัสผ่านที่เข้ารหัสแล้ว (v1$salt$hash) ว่าง = ยังไม่ได้ตั้ง',
  last_login  DATETIME     NULL COMMENT 'เข้าระบบล่าสุด',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่สร้างบัญชี'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='บัญชีผู้ใช้งาน';

-- สถานที่รับ / สถานที่ส่ง (ตัวเลือกในฟอร์ม)
CREATE TABLE IF NOT EXISTS places (
  id          VARCHAR(20)  NOT NULL PRIMARY KEY COMMENT 'รหัสสถานที่',
  name        VARCHAR(200) NOT NULL COMMENT 'ชื่อสถานที่',
  type        ENUM('pickup','dropoff','both') NOT NULL DEFAULT 'both' COMMENT 'pickup = สถานที่รับ, dropoff = สถานที่ส่ง, both = ทั้งสองแบบ',
  active      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'ใช้งานอยู่',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่เพิ่ม',
  created_by  VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'ผู้ดูแลที่เพิ่ม',
  UNIQUE KEY uq_places_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='สถานที่รับ / สถานที่ส่ง';

-- งานที่มอบหมาย (สถานที่รับ-ส่งของพนักงาน)
CREATE TABLE IF NOT EXISTS assignments (
  id          VARCHAR(20)  NOT NULL PRIMARY KEY COMMENT 'รหัสงาน',
  email       VARCHAR(100) NOT NULL COMMENT 'อีเมลพนักงานที่ได้รับมอบหมาย',
  pickup      VARCHAR(200) NOT NULL COMMENT 'สถานที่รับ',
  dropoff     VARCHAR(200) NOT NULL COMMENT 'สถานที่ส่ง',
  note        VARCHAR(300) NOT NULL DEFAULT '' COMMENT 'หมายเหตุจากผู้ดูแล',
  status      ENUM('open','done') NOT NULL DEFAULT 'open' COMMENT 'open = กำลังทำ, done = เสร็จแล้ว',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่มอบหมาย',
  created_by  VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'ผู้ดูแลที่มอบหมาย',
  updated_at  DATETIME     NULL COMMENT 'แก้ไขล่าสุด',
  KEY ix_assign_email (email, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='งานที่มอบหมาย';

-- บันทึกการขนส่ง
CREATE TABLE IF NOT EXISTS moves (
  id          VARCHAR(80)  NOT NULL PRIMARY KEY COMMENT 'รหัสรายการ (reqId จากหน้าเว็บ/ESP32 กันบันทึกซ้ำ)',
  ts          DATETIME     NOT NULL COMMENT 'วันเวลาที่บันทึก (UTC)',
  code        VARCHAR(32)  NOT NULL COMMENT 'รหัสอุปกรณ์',
  name        VARCHAR(200) NOT NULL COMMENT 'ชื่ออุปกรณ์ (ณ ตอนบันทึก)',
  qty         INT          NOT NULL COMMENT 'จำนวนที่ขนส่ง',
  unit        VARCHAR(50)  NOT NULL COMMENT 'หน่วยนับ',
  mover       VARCHAR(100) NOT NULL COMMENT 'ชื่อผู้ขนส่ง',
  pickup      VARCHAR(200) NOT NULL DEFAULT '' COMMENT 'สถานที่รับ',
  dropoff     VARCHAR(200) NOT NULL DEFAULT '' COMMENT 'สถานที่ส่ง',
  method      VARCHAR(50)  NOT NULL DEFAULT '' COMMENT 'ภาพถ่าย / เลือกเอง / สแกน QR / ผู้ดูแลเพิ่ม',
  score       INT          NULL COMMENT 'ความคล้ายของภาพถ่าย (%)',
  source      VARCHAR(120) NOT NULL DEFAULT '' COMMENT 'web:อีเมล / admin:อีเมล / รหัสบอร์ด ESP32',
  photo       VARCHAR(300) NOT NULL DEFAULT '' COMMENT 'ลิงก์ภาพถ่าย (/photos/...)',
  assign_id   VARCHAR(20)  NULL COMMENT 'งานที่มอบหมาย (assignments.id)',
  KEY ix_moves_ts (ts),
  KEY ix_moves_assign (assign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='บันทึกการขนส่ง';

-- บอร์ด ESP32 (Token ระบบอันเดียว ระบบเพิ่มบอร์ดให้เองเมื่อติดต่อครั้งแรก)
CREATE TABLE IF NOT EXISTS devices (
  device_id   VARCHAR(32)  NOT NULL PRIMARY KEY COMMENT 'รหัสบอร์ด (DEVICE_ID ใน config.h)',
  name        VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'ชื่อบอร์ด',
  active      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'อนุญาตให้ส่งข้อมูล (0 = บล็อก)',
  owner       VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'อีเมลพนักงานที่ใช้บอร์ดนี้',
  last_seen   DATETIME     NULL COMMENT 'ติดต่อล่าสุด',
  firmware    VARCHAR(50)  NOT NULL DEFAULT '' COMMENT 'เวอร์ชันเฟิร์มแวร์',
  info        VARCHAR(500) NOT NULL DEFAULT '' COMMENT 'สถานะล่าสุด (IP, WiFi, คิว)',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'ติดต่อครั้งแรก'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='บอร์ด ESP32';

-- ภาพที่ใช้จดจำอุปกรณ์
CREATE TABLE IF NOT EXISTS refs (
  id          VARCHAR(20)  NOT NULL PRIMARY KEY COMMENT 'รหัสภาพ',
  code        VARCHAR(32)  NOT NULL COMMENT 'รหัสอุปกรณ์',
  name        VARCHAR(200) NOT NULL COMMENT 'ชื่ออุปกรณ์',
  vec         MEDIUMTEXT   NOT NULL COMMENT 'ลักษณะเฉพาะของภาพ (base64)',
  thumb       MEDIUMTEXT   NULL COMMENT 'ภาพย่อ (data:image/jpeg)',
  added_by    VARCHAR(200) NOT NULL DEFAULT '' COMMENT 'ผู้เพิ่มภาพ',
  ts          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'วันที่เพิ่ม',
  KEY ix_refs_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='ภาพที่ใช้จดจำอุปกรณ์';

-- เซสชันหน้าเว็บ (เข้าระบบรอบเดียว) เก็บแฮชของ session ไม่เก็บค่าจริง
CREATE TABLE IF NOT EXISTS sessions (
  id_hash     CHAR(64)     NOT NULL PRIMARY KEY COMMENT 'SHA-256 ของ session',
  email       VARCHAR(100) NOT NULL COMMENT 'บัญชีที่เข้าระบบ',
  expires_at  DATETIME     NOT NULL COMMENT 'หมดอายุ (ต่ออายุเมื่อใช้งาน)',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sessions_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='เซสชันหน้าเว็บ';

-- ค่าตั้งระบบ: SYSTEM_TOKEN, GOOGLE_CLIENT_ID, PUBLIC_BASE_URL
CREATE TABLE IF NOT EXISTS settings (
  name        VARCHAR(64)  NOT NULL PRIMARY KEY,
  value       TEXT         NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='ค่าตั้งระบบ';
