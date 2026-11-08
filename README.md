# Cargo Bot — ระบบบันทึกการขนส่งอุปกรณ์

```
 หน้าแอป (URL ของ Web app) ── google.script.run ──┐
                                                  ├──> Google Apps Script ──> Google Sheet "Database Cargo (ระบบบันทึกการขนส่ง)"
 บอร์ด ESP32 ──────────────── HTTPS + Token ──────┘                     └─> Google Drive (ภาพถ่าย, ไฟล์จดจำภาพ)
```

**ฐานข้อมูล:** https://docs.google.com/spreadsheets/d/1_8C6v41tTDqwMaEhVT1ZM1j2VzEI-aZS3PfTtegj4Ko
(ตั้งไว้ใน `DEFAULT_SPREADSHEET_ID` ใน [gas/Code.gs](gas/Code.gs))

| ไฟล์ | หน้าที่ |
|---|---|
| [gas/Code.gs](gas/Code.gs) | เซิร์ฟเวอร์: เข้าสู่ระบบ, Token ของ ESP32, อ่าน/เขียน Google Sheet |
| [gas/Index.html](gas/Index.html) | หน้าแอป |
| [gas/Vision.html](gas/Vision.html) | ตัวจดจำอุปกรณ์จากภาพถ่าย |
| [model/cargo_model_weights.b64.txt](model/cargo_model_weights.b64.txt) | ไฟล์ของตัวจดจำภาพ (5.9 MB) อัปโหลดไว้ใน Google Drive |
| [esp32/CargoStation/](esp32/CargoStation/) | เฟิร์มแวร์บอร์ด ESP32 |
| [dev/preview.js](dev/preview.js) | รันหน้าแอปบนเครื่องเพื่อทดลอง |
| [cloudflare/](cloudflare/) | Cloudflare Worker: โดเมนของเราสำหรับหน้าแอป และ `/api` สำหรับ ESP32 |
| [dev/dump_schema.js](dev/dump_schema.js), [dev/build_db.py](dev/build_db.py) | สร้างไฟล์ฐานข้อมูลเปล่า (.xlsx) จากโครงสร้างใน Code.gs |

## เข้าสู่ระบบ

**ยืนยันตัวตนด้วย Google (Sign in with Google):**
- กดปุ่ม Google แล้วเลือกบัญชี
- Google ยืนยันว่าเป็นเจ้าของอีเมลจริง จากนั้นระบบตรวจว่าอีเมลลงทะเบียนในชีต `Users` แล้ว
- ไม่มีรหัสผ่าน

**ไม่ต้องพิมพ์อีเมล:** หน้าเข้าสู่ระบบมีแค่ปุ่ม Google และหน้าต่าง One Tap ("ดำเนินการต่อในชื่อ …")
- คนที่เคยเลือกบัญชีแล้ว เปิดหน้าแอปครั้งต่อไปจะ**เข้าระบบให้เอง** แม้เซสชันเดิมหมดอายุแล้ว
- หลังกด **ออกจากระบบ** ระบบจะไม่เข้าให้เองอีก จนกว่าจะกดปุ่ม Google เลือกบัญชีใหม่
- ถ้าเบราว์เซอร์ไม่แสดง One Tap ก็ยังกดปุ่ม Google ได้

ก่อนเปิดใช้ Google Sign-In ระบบจะใช้การพิมพ์อีเมลอย่างเดียว ซึ่งใช้ได้แค่ตอนตั้งค่าครั้งแรก เพราะใครรู้อีเมลที่ลงทะเบียนไว้ก็เข้าในชื่อนั้นได้

- **ผู้ดูแลระบบถาวร:** `phatthachada.k@gmail.com` (`ADMIN_EMAILS` ใน Code.gs) ลดสิทธิ์ ปิด หรือลบบัญชีนี้ไม่ได้
- อีเมลอื่นต้องให้ผู้ดูแลเพิ่มในแท็บ **ผู้ดูแลระบบ > บัญชีผู้ใช้งาน** ก่อน
- เซสชันหมดอายุเมื่อไม่ได้ใช้งาน 6 ชั่วโมง

### เปิดใช้ Google Sign-In (ทำครั้งเดียวหลัง Deploy)

1. เข้าแอปด้วยอีเมลผู้ดูแล แล้วไปที่ **ผู้ดูแลระบบ > ยืนยันตัวตนด้วย Google** ระบบจะแสดง origin ของแอปให้คัดลอก
2. ที่ [Google Cloud Console › Clients](https://console.cloud.google.com/auth/clients) สร้าง Client ชนิด **Web application**
   - ใส่ origin จากข้อ 1 ใน **Authorized JavaScript origins**
   - ไปที่ **Audience** แล้วกด **Publish app**
3. วาง Client ID แล้วกด **ทดสอบด้วยบัญชี Google ของฉัน** จากนั้นกดปุ่ม Google และเลือกบัญชีเดียวกับที่เข้าระบบอยู่ ถ้าผ่าน ระบบจะเปิดใช้ทันที และปิดการเข้าด้วยอีเมลอย่างเดียว

- **กันล็อกตัวเอง:** ระบบไม่ยอมบันทึก Client ID จนกว่าการทดสอบในข้อ 3 จะผ่าน ตั้ง Client ID ผิดจึงไม่ทำให้ใครเข้าไม่ได้
- **ปิดใช้งาน:** กดปุ่มปิดในการ์ดเดียวกัน
- **กู้คืน:** ถ้าเข้าระบบไม่ได้จริง ๆ ให้รันฟังก์ชัน `resetGoogleLogin` ในหน้าแก้ไขสคริปต์
- **ถ้าใช้ Cloudflare Worker:** origin ที่ต้องลงทะเบียนยังเป็นของ Apps Script (`https://n-…-script.googleusercontent.com`) เพราะปุ่ม Google อยู่ในหน้าแอปที่ฝังมา ใช้ค่าที่การ์ดแสดงได้เลย

## สิทธิ์และเมนู

| เมนู | พนักงาน | ผู้ดูแลระบบ |
|---|:-:|:-:|
| **บันทึกอุปกรณ์**: ชื่อผู้ขนส่ง (ระบบจำไว้ให้), สถานที่รับ, สถานที่ส่ง (กรอกใหม่ทุกครั้ง) → ถ่ายภาพหรือเลือกอุปกรณ์ → จำนวน → บันทึก | ✓ | ✓ |
| **ผลการขนส่ง**: สรุปตามวัน, อุปกรณ์, เส้นทาง, ผู้ขนส่ง | ✓ | ✓ |
| **เชื่อมต่อ ESP32**: Token ระบบอันเดียว (แสดง/คัดลอก/สร้างใหม่), config.h, รายการบอร์ด, กำหนดพนักงานให้บอร์ด, บล็อกบอร์ด | | ✓ |
| **ผู้ดูแลระบบ > สถานที่รับ / สถานที่ส่ง**: เพิ่ม/แก้ไข/ลบ/ปิดสถานที่ และกำหนดว่าใช้เป็นสถานที่รับ สถานที่ส่ง หรือทั้งสองแบบ รายการนี้ขึ้นเป็นตัวเลือกในทุกช่องสถานที่ | | ✓ |
| **ผู้ดูแลระบบ > มอบหมายสถานที่รับ-ส่งให้พนักงาน**: เลือกพนักงาน + สถานที่รับ + สถานที่ส่ง + หมายเหตุ, ดูจำนวนเที่ยวที่ขนแล้ว, ปิดงาน/แก้ไข/ลบ | | ✓ |
| **ผู้ดูแลระบบ**: จัดการบันทึกการขนส่งของพนักงาน (ค้นหา/เพิ่ม/แก้ไข/ลบ), บัญชี, อุปกรณ์ | | ✓ |

### งานที่มอบหมาย (สถานที่รับ-ส่ง)

- **พนักงาน:** เห็น "งานที่ได้รับมอบหมาย" ในหน้าบันทึกอุปกรณ์ กดเลือกแล้วระบบจะกรอกสถานที่รับ-ส่งให้
  - ถ้าไม่เลือกงาน ก็ยังกรอกสถานที่เองได้
  - หลังบันทึก สถานที่และงานที่เลือกจะถูกล้างทุกครั้ง
- **บอร์ด ESP32:** ถ้าบอร์ดไม่ได้ส่งสถานที่มา ระบบจะใช้งานที่กำลังทำล่าสุดของเจ้าของบอร์ด
- **เก็บข้อมูล:** บันทึกที่มาจากงานที่มอบหมายจะเก็บรหัสงานไว้ในฟิลด์ `Moves.AssignId` ผู้ดูแลจึงเห็นได้ว่าแต่ละงานขนไปแล้วกี่เที่ยว
- **ปิดงาน:** เมื่อผู้ดูแลตั้งงานเป็น "เสร็จแล้ว" พนักงานจะไม่เห็นงานนั้นอีก

## เชื่อมต่อบอร์ด ESP32

บอร์ดทุกตัวใช้ **Token ระบบอันเดียว** และแยกบอร์ดด้วย `DEVICE_ID`

1. ผู้ดูแลระบบเข้าเมนู **เชื่อมต่อ ESP32** (พนักงานไม่เห็นเมนูนี้)
2. ใส่ **รหัสบอร์ด** (เช่น `ESP32-01`) ให้ไม่ซ้ำกับบอร์ดอื่น แล้วกด **คัดลอก config.h**
3. วางเป็นไฟล์ `esp32/CargoStation/config.h` แล้วใส่ชื่อและรหัส WiFi
4. Upload เฟิร์มแวร์ขึ้นบอร์ด (ต้องใช้บอร์ด **esp32 (Espressif)** และไลบรารี **ArduinoJson 7.x**)
5. เมื่อบอร์ดติดต่อเข้ามาครั้งแรก จะขึ้นในตาราง **บอร์ดที่เชื่อมต่อ** เอง

ผู้ดูแลทำอะไรได้บ้าง:
- **แสดง / คัดลอก Token ระบบ** ได้ตลอดเวลา (Token เก็บใน Script Properties ชื่อ `SYSTEM_TOKEN` ไม่ได้อยู่ในชีต)
- **สร้าง Token ใหม่:** ต้องกดยืนยันซ้ำ Token เก่าจะใช้ไม่ได้ทันที บอร์ดทุกตัวต้องอัปเดต `DEVICE_TOKEN`
- **กำหนดพนักงานที่ใช้บอร์ด:** บันทึกจากบอร์ดนั้นจะเป็นชื่อพนักงานคนนั้น และถ้าบอร์ดไม่ได้ส่งสถานที่มา จะใช้งานที่มอบหมายของเขา ถ้าไม่ได้กำหนด จะใช้รหัสบอร์ดเป็นชื่อผู้ขนส่ง
- **บล็อก / ปลดบล็อก** บอร์ดแต่ละตัวได้ บอร์ดที่ถูกบล็อกส่งข้อมูลไม่ได้ แม้ใช้ Token ถูก
- **ลบ** บอร์ดออกจากรายการ ถ้าบอร์ดนั้นยังติดต่อเข้ามาด้วย Token ปัจจุบัน จะถูกเพิ่มกลับเอง

คู่มือต่อขาและวิธีใช้บอร์ดอยู่ในคอมเมนต์ต้นไฟล์ [CargoStation.ino](esp32/CargoStation/CargoStation.ino)

API ที่บอร์ดเรียกคือ `POST <URL /exec>` โดยส่ง body เป็น JSON ซึ่งต้องมี `token` และ `action` เสมอ

| action | ใช้ทำอะไร |
|---|---|
| `ping` | ตรวจว่าเชื่อมต่อได้ |
| `heartbeat` | ส่งสถานะบอร์ด |
| `products` | ขอรายการอุปกรณ์ |
| `saveMove` | บันทึกการขนส่ง: `code`, `qty`, `pickup`, `dropoff`, `reqId` |

## ฐานข้อมูล Google Sheet

ไฟล์ **Database Cargo (ระบบบันทึกการขนส่ง)** มีทุกชีตและฟิลด์พร้อมใช้งาน:
- ตั้งบัญชีผู้ดูแลไว้แล้ว
- มีอุปกรณ์เริ่มต้น 5 รายการ
- มีชีต **คำอธิบายฟิลด์** อธิบายทุกฟิลด์เป็นภาษาไทยพร้อมตัวอย่าง

**ฟิลด์ใหม่:** เมื่อโค้ดเพิ่มชีตหรือฟิลด์ใหม่ (เช่น `Assignments`, `AssignId`) ระบบจะเพิ่มลงใน Google Sheet ให้เองตอนมีการใช้งานครั้งแรกหลัง Deploy ข้อมูลเดิมไม่หาย ถ้าต้องการรันเอง ให้รันฟังก์ชัน `setup` ในหน้าแก้ไขสคริปต์

| ชีต | ฟิลด์ |
|---|---|
| **Moves** (บันทึกการขนส่ง) | Timestamp, Code, Name, Qty, Unit, Mover, Pickup, Dropoff, Method, Score, Source, Photo, ReqId, AssignId |
| **Places** (สถานที่รับ / สถานที่ส่ง) | Id, Name, Type (`pickup` = สถานที่รับ / `dropoff` = สถานที่ส่ง / `both` = ทั้งสองแบบ), Active, CreatedAt, CreatedBy |
| **Assignments** (งานที่มอบหมาย) | Id, Email, Pickup, Dropoff, Note, Status (`open` = กำลังทำ / `done` = เสร็จแล้ว), CreatedAt, CreatedBy, UpdatedAt |
| **Users** (บัญชีผู้ใช้งาน) | Email, Name, Role (`user` = พนักงาน / `admin` = ผู้ดูแลระบบ), Active, LastLogin, CreatedAt |
| **Products** (อุปกรณ์ที่ขนส่ง) | Code, Name, Unit, Active |
| **Devices** (บอร์ด ESP32 — เพิ่มเองเมื่อบอร์ดติดต่อครั้งแรก) | DeviceId, Name, Role, TokenHash (ไม่ใช้แล้ว), Active (FALSE = บล็อก), LastSeen, Firmware, Info, CreatedAt, Owner (พนักงานที่ใช้บอร์ด) |
| **Refs** (ภาพที่ใช้จดจำอุปกรณ์) | Id, Code, Name, Vec, Thumb, AddedBy, Timestamp |

สร้างไฟล์ฐานข้อมูลเปล่าใหม่ได้จากโครงสร้างใน Code.gs:

```sh
node dev/dump_schema.js > schema.json
python dev/build_db.py schema.json "Database Cargo.xlsx"    # อัปโหลดขึ้น Google Drive แล้วเปิดเป็น Google Sheet
```

## ติดตั้ง

1. ไปที่ https://script.google.com แล้วกด **New project** ด้วยบัญชี `phatthachada.k@gmail.com` ซึ่งเป็นเจ้าของ Sheet ฐานข้อมูล
2. สร้างไฟล์ในโปรเจกต์ให้ชื่อตรงกับในโฟลเดอร์ [gas/](gas/) แล้ววางโค้ดลงไป
   - `Code.gs`
   - `Index` (ใช้ปุ่ม + > HTML)
   - `Vision` (ใช้ปุ่ม + > HTML)
3. อัปโหลด `model/cargo_model_weights.b64.txt` ขึ้น Google Drive ของบัญชีเดียวกัน โดยไม่ต้องเปลี่ยนชื่อไฟล์
4. **Deploy > New deployment > Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - กดอนุญาตสิทธิ์
5. เปิด URL `/exec` แล้วเข้าระบบด้วย `phatthachada.k@gmail.com` จากนั้นเพิ่มอีเมลพนักงานในแท็บ **ผู้ดูแลระบบ**

> แก้โค้ดแล้วต้องไปที่ **Deploy > Manage deployments > Edit > Version: New version** ทุกครั้ง

## Cloudflare

### ใช้งานจริง: Cloudflare Worker หน้าบ้านของ Apps Script

ไฟล์อยู่ใน [cloudflare/](cloudflare/) ใช้ทำ 2 อย่าง:

| URL บนโดเมนของคุณ | ทำอะไร |
|---|---|
| `https://cargo.example.com/` | แสดงหน้าแอปเต็มจอ แทน URL ยาวของ `script.google.com` |
| `https://cargo.example.com/api` | API สำหรับ ESP32: Worker ส่งต่อไปที่ Apps Script และตาม redirect ของ Google ให้ บอร์ดจึงได้ JSON กลับทันที |
| `https://cargo.example.com/health` | ตรวจว่า Worker ทำงานและตั้งค่าแล้ว |

1. Deploy Apps Script ตามหัวข้อ **ติดตั้ง** ให้เสร็จก่อน แล้วคัดลอก URL `/exec`
2. แก้ [cloudflare/wrangler.toml](cloudflare/wrangler.toml)
   - ใส่ URL `/exec` ใน `APPS_SCRIPT_URL`
   - ถ้ามีโดเมนใน Cloudflare ให้เปิดบรรทัด `routes` แล้วใส่ชื่อโดเมน
3. Deploy:
   ```sh
   cd cloudflare
   npx wrangler login      # เปิดเบราว์เซอร์ให้ล็อกอิน Cloudflare
   npx wrangler deploy
   ```
   ถ้าไม่ใส่ `routes` จะได้ URL แบบ `https://cargo-bot.<ชื่อบัญชี>.workers.dev`
4. ให้ config.h ของ ESP32 ใช้ URL ของ Cloudflare:
   - ใน Apps Script ไปที่ **Project Settings > Script properties** แล้วเพิ่ม `PUBLIC_BASE_URL` = `https://cargo.example.com` (หรือใส่ในค่าคงที่ `PUBLIC_BASE_URL` ใน Code.gs)
   - จากนั้นเมนู **เชื่อมต่อ ESP32** จะสร้าง config.h ที่มี `API_URL` เป็น `https://cargo.example.com/api`

> Code.gs ตั้ง `XFrameOptionsMode.ALLOWALL` ไว้แล้ว เพื่อให้หน้า Worker แสดงแอปได้ ถ้าแก้ Code.gs ต้อง Deploy เวอร์ชันใหม่ด้วย

### ทดลอง: Cloudflare Tunnel ไปที่ระบบบนเครื่อง

ใช้ให้มือถือหรือบอร์ด ESP32 จริงเข้าถึงระบบทดลองบนเครื่องนี้ได้ ไม่ต้องล็อกอิน Cloudflare:

```sh
cloudflared tunnel --url http://localhost:8080          # ได้ URL https://xxxx.trycloudflare.com
PUBLIC_URL=https://xxxx.trycloudflare.com node dev/preview.js
```

- `PUBLIC_URL` ทำให้ config.h ในเมนู ESP32 ชี้ไปที่ `https://xxxx.trycloudflare.com/api`
- URL ของ Quick Tunnel **เปลี่ยนทุกครั้งที่เปิดใหม่** และใช้ได้เฉพาะตอนที่เครื่องนี้เปิด tunnel อยู่ จึงเหมาะกับการทดลองเท่านั้น

## ทดลองบนเครื่อง

```sh
node dev/preview.js      # เปิด http://localhost:8080
```

- ใช้ Google Sheet จำลองในหน่วยความจำ ไม่ได้เขียนลงไฟล์จริง และปิดโปรแกรมแล้วข้อมูลหาย
- `MOCK_GOOGLE=1 node dev/preview.js` จำลอง Google Sign-In โดยไม่ต้องมี Client ID จริง
  - เปิดใช้ Google Sign-In ไว้ตั้งแต่เริ่ม
  - กดปุ่ม "(จำลอง)" แล้วจะได้หน้าเลือกบัญชี ซึ่งมีบัญชีในชีต Users และผู้ดูแลถาวร
  - One Tap จำลองจำบัญชีล่าสุด แล้วเข้าระบบให้เอง
- API สำหรับทดสอบบอร์ดอยู่ที่ `http://localhost:8080/exec`
