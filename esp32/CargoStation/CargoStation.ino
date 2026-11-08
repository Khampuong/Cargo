/*
 * Cargo Bot — สถานีบันทึกการขนสินค้า (ESP32)
 * สแกน QR สินค้า -> กด +/- ตั้งจำนวน -> กด OK -> ส่งเข้า Google Sheet ผ่าน Apps Script API (ยืนยันด้วย Token)
 *
 * บอร์ด:    ESP32 Dev Module (Arduino-ESP32 core 2.x หรือ 3.x)
 * ไลบรารี:  ArduinoJson 7.x (ติดตั้งจาก Library Manager)
 * ตั้งค่า:   คัดลอก config.example.h เป็น config.h แล้วใส่ WiFi / API_URL / DEVICE_TOKEN
 *
 * ทดสอบโดยไม่มีเครื่องสแกน: พิมพ์ใน Serial Monitor (115200, Newline) เช่น
 *   TABLE        เลือกสินค้า (สแกนซ้ำ = +1)
 *   TABLE 5      ส่งทันที 5 ชิ้น
 *   + / - / ok / cancel / status / products / mover สมชาย / help
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <vector>
#include <deque>
#include "config.h"

#define FW_VERSION "1.0.0"

// ---------- ขา (ปรับตามวงจรจริง) ----------
const int PIN_BTN_PLUS = 32, PIN_BTN_MINUS = 33, PIN_BTN_OK = 25;   // ปุ่มต่อลง GND (ใช้ pull-up ภายใน)
const int PIN_LED = 2, PIN_BUZZER = 26;
const int PIN_SCAN_RX = 16, PIN_SCAN_TX = 17;                        // เครื่องสแกน QR แบบ UART เช่น GM65, 9600 bps

const uint32_t HEARTBEAT_MS = 60000;
const size_t QUEUE_MAX = 30;

enum class ApiResult { Ok, Retry, Rejected };

struct Product { String code, name, unit; };
struct Move { String reqId, code, mover, pickup, dropoff, method; int qty; uint8_t tries; };
struct Button { int pin; bool down; uint32_t t; };

std::vector<Product> products;
std::deque<Move> queue;                 // รายการที่รอส่ง (ส่งไม่ผ่านจะลองใหม่อัตโนมัติ)
String mover = DEFAULT_MOVER, pickup = DEFAULT_PICKUP, dropoff = DEFAULT_DROPOFF;
Product pending;
bool hasPending = false;
int pendingQty = 1;
uint32_t lastBeat = 0, nextSend = 0, lastWifiTry = 0;
String serialBuf, scanBuf;
Button btnPlus = { PIN_BTN_PLUS, false, 0 }, btnMinus = { PIN_BTN_MINUS, false, 0 }, btnOk = { PIN_BTN_OK, false, 0 };

// ---------- เสียง / ไฟ ----------
void beepOk() { tone(PIN_BUZZER, 2000, 70); delay(110); tone(PIN_BUZZER, 2600, 70); }
void beepErr() { tone(PIN_BUZZER, 300, 400); }
void beepTick() { tone(PIN_BUZZER, 1500, 30); }

// ---------- API ----------
// POST ไปที่ Apps Script แล้วตาม redirect (302) ไปอ่านผลด้วย GET
// ทำ redirect เอง เพราะ HTTPClient จะส่ง POST ซ้ำไปยังปลายทาง ซึ่ง Google ไม่รับ
ApiResult apiCall(JsonDocument& req, JsonDocument& res, String& err) {
  if (WiFi.status() != WL_CONNECTED) { err = "no_wifi"; return ApiResult::Retry; }
  req["token"] = DEVICE_TOKEN;
  req["deviceId"] = DEVICE_ID;
  req["fw"] = FW_VERSION;
  String body;
  serializeJson(req, body);

  WiFiClientSecure client;
  client.setInsecure();   // ไม่ตรวจใบรับรอง ดูหมายเหตุใน README
  HTTPClient http;
  http.setTimeout(20000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  const char* keep[] = { "Location" };
  if (!http.begin(client, API_URL)) { err = "begin_failed"; return ApiResult::Retry; }
  http.collectHeaders(keep, 1);
  http.addHeader("Content-Type", "text/plain");
  int code = http.POST(body);
  if (code == 301 || code == 302 || code == 303 || code == 307) {
    String loc = http.header("Location");
    http.end();
    if (!http.begin(client, loc)) { err = "redirect_failed"; return ApiResult::Retry; }
    code = http.GET();
  }
  String payload = code == 200 ? http.getString() : String();
  http.end();
  if (code != 200) { err = "http_" + String(code); return ApiResult::Retry; }

  DeserializationError de = deserializeJson(res, payload);
  if (de) { err = String("bad_json: ") + de.c_str(); return ApiResult::Retry; }
  if (res["ok"] | false) return ApiResult::Ok;
  String code_ = res["error"] | "error";
  err = code_ + ": " + (res["message"] | "");
  return code_ == "server_error" ? ApiResult::Retry : ApiResult::Rejected;
}

bool ping() {
  JsonDocument req, res;
  String err;
  req["action"] = "ping";
  if (apiCall(req, res, err) != ApiResult::Ok) {
    Serial.println("[API] เชื่อมต่อไม่สำเร็จ: " + err);
    if (err.startsWith("unauthorized")) Serial.println("      ตรวจ DEVICE_TOKEN ใน config.h และสถานะ Active ในชีต Devices");
    return false;
  }
  Serial.println("[API] เชื่อมต่อสำเร็จ เวลาเซิร์ฟเวอร์ " + String(res["serverTime"] | ""));
  return true;
}

bool loadProducts() {
  JsonDocument req, res;
  String err;
  req["action"] = "products";
  if (apiCall(req, res, err) != ApiResult::Ok) { Serial.println("[API] โหลดรายการสินค้าไม่ได้: " + err); return false; }
  products.clear();
  for (JsonObject p : res["products"].as<JsonArray>())
    products.push_back({ p["code"].as<String>(), p["name"].as<String>(), p["unit"].as<String>() });
  Serial.printf("[API] สินค้า %u รายการ\n", (unsigned)products.size());
  return true;
}

void heartbeat() {
  JsonDocument req, res;
  String err;
  req["action"] = "heartbeat";
  req["ip"] = WiFi.localIP().toString();
  req["rssi"] = WiFi.RSSI();
  req["uptime"] = millis() / 1000;
  req["queue"] = queue.size();
  req["heap"] = ESP.getFreeHeap();
  if (apiCall(req, res, err) != ApiResult::Ok) Serial.println("[heartbeat] " + err);
}

// ส่งรายการแรกในคิว ถ้าเน็ตหรือเซิร์ฟเวอร์มีปัญหาจะรอแล้วลองใหม่ (reqId เดิม เซิร์ฟเวอร์จึงไม่บันทึกซ้ำ)
void processQueue() {
  if (queue.empty() || (int32_t)(millis() - nextSend) < 0 || WiFi.status() != WL_CONNECTED) return;
  Move& m = queue.front();
  JsonDocument req, res;
  String err;
  req["action"] = "saveMove";
  req["reqId"] = m.reqId;
  req["code"] = m.code;
  req["qty"] = m.qty;
  req["mover"] = m.mover;
  req["pickup"] = m.pickup;
  req["dropoff"] = m.dropoff;
  req["method"] = m.method;
  digitalWrite(PIN_LED, HIGH);
  ApiResult r = apiCall(req, res, err);
  digitalWrite(PIN_LED, LOW);

  if (r == ApiResult::Ok) {
    Serial.printf("[บันทึกแล้ว] %s %d %s โดย %s เวลา %s%s\n", res["product"]["name"].as<const char*>(), m.qty,
                  res["product"]["unit"].as<const char*>(), res["mover"].as<const char*>(), res["time"].as<const char*>(),
                  (res["duplicate"] | false) ? " (ซ้ำ ไม่บันทึกเพิ่ม)" : "");
    beepOk();
    queue.pop_front();
  } else if (r == ApiResult::Rejected) {
    Serial.println("[ถูกปฏิเสธ] " + m.code + " x" + String(m.qty) + " — " + err);
    beepErr();
    queue.pop_front();
  } else {
    m.tries++;
    uint32_t wait = min<uint32_t>(60000, 2000UL << min<uint8_t>(m.tries, 5));
    Serial.printf("[ส่งไม่สำเร็จ] %s ลองใหม่ใน %lu วินาที (คิว %u)\n", err.c_str(), (unsigned long)(wait / 1000), (unsigned)queue.size());
    nextSend = millis() + wait;
  }
}

// ---------- การทำงานของสถานี ----------
// รับได้ทั้งรหัสตรง ๆ และ URL ที่มี ?item=CODE
String parseCode(String s) {
  s.trim();
  int i = s.indexOf("item=");
  if (i >= 0) {
    s = s.substring(i + 5);
    int e = s.indexOf('&');
    if (e >= 0) s = s.substring(0, e);
    e = s.indexOf('#');
    if (e >= 0) s = s.substring(0, e);
  }
  s.trim();
  s.toUpperCase();
  return s;
}

int findProduct(const String& code) {
  for (size_t i = 0; i < products.size(); i++) if (products[i].code == code) return i;
  return -1;
}

void showPending() {
  if (!hasPending) { Serial.println("ไม่มีรายการรอยืนยัน — สแกนสินค้าก่อน"); return; }
  Serial.printf("รอยืนยัน: %s x%d %s (ผู้ขน: %s, %s → %s) — กด OK เพื่อส่ง\n", pending.name.c_str(), pendingQty, pending.unit.c_str(),
                mover.length() ? mover.c_str() : "ตามชื่ออุปกรณ์", pickup.length() ? pickup.c_str() : "-", dropoff.length() ? dropoff.c_str() : "-");
}

void setQty(int q) {
  if (!hasPending) return;
  pendingQty = constrain(q, 1, 9999);
  beepTick();
  showPending();
}

void cancelPending() {
  if (!hasPending) return;
  hasPending = false;
  Serial.println("ยกเลิกรายการ");
  beepErr();
}

void confirmPending() {
  if (!hasPending) { beepErr(); showPending(); return; }
  if (queue.size() >= QUEUE_MAX) { Serial.println("คิวเต็ม — ตรวจการเชื่อมต่อ WiFi"); beepErr(); return; }
  String reqId = String(DEVICE_ID) + "-" + String(esp_random(), HEX) + String(millis(), HEX);
  queue.push_back({ reqId, pending.code, mover, pickup, dropoff, "สแกน QR", pendingQty, 0 });
  hasPending = false;
  nextSend = millis();
  Serial.printf("เข้าคิวส่ง: %s x%d (คิว %u)\n", pending.code.c_str(), pendingQty, (unsigned)queue.size());
}

void handleScan(String s) {
  s.trim();
  if (!s.length()) return;
  if (s.startsWith("MOVER:")) {          // บัตรพนักงาน: QR "MOVER:ชื่อ"
    mover = s.substring(6);
    mover.trim();
    Serial.println("ผู้ขน: " + mover);
    beepOk();
    return;
  }
  if (s.startsWith("FROM:") || s.startsWith("TO:")) {   // QR สถานที่รับ / สถานที่ส่ง
    bool from = s.startsWith("FROM:");
    String place = s.substring(from ? 5 : 3);
    place.trim();
    (from ? pickup : dropoff) = place;
    Serial.println(String(from ? "สถานที่รับ: " : "สถานที่ส่ง: ") + place);
    beepOk();
    return;
  }
  String code = parseCode(s);
  int i = findProduct(code);
  if (i < 0 && loadProducts()) i = findProduct(code);   // อาจเพิ่งเพิ่มสินค้าในชีต
  if (i < 0) { Serial.println("ไม่รู้จักรหัสสินค้า: " + code); beepErr(); return; }
  if (hasPending && pending.code == code) { setQty(pendingQty + 1); return; }   // สแกนซ้ำ = +1
  pending = products[i];
  pendingQty = 1;
  hasPending = true;
  beepTick();
  showPending();
}

void printHelp() {
  Serial.println("คำสั่ง: <รหัส> | <รหัส> <จำนวน> | + | - | ok | cancel | mover <ชื่อ> | from <สถานที่รับ> | to <สถานที่ส่ง> | status | products | help");
}

void printStatus() {
  Serial.printf("WiFi: %s  IP: %s  RSSI: %d\n", WiFi.status() == WL_CONNECTED ? "เชื่อมต่อ" : "หลุด",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  Serial.printf("อุปกรณ์: %s  FW %s  คิวรอส่ง: %u  สินค้า: %u\n", DEVICE_ID, FW_VERSION, (unsigned)queue.size(), (unsigned)products.size());
  showPending();
}

void handleSerialCommand(String line) {
  line.trim();
  String lower = line;
  lower.toLowerCase();
  if (lower == "help") printHelp();
  else if (lower == "status") printStatus();
  else if (lower == "products") { loadProducts(); for (auto& p : products) Serial.println("  " + p.code + " — " + p.name + " (" + p.unit + ")"); }
  else if (lower == "+") setQty(pendingQty + 1);
  else if (lower == "-") setQty(pendingQty - 1);
  else if (lower == "ok") confirmPending();
  else if (lower == "cancel") cancelPending();
  else if (lower.startsWith("mover ")) handleScan("MOVER:" + line.substring(6));
  else if (lower.startsWith("from ")) handleScan("FROM:" + line.substring(5));
  else if (lower.startsWith("to ")) handleScan("TO:" + line.substring(3));
  else {
    int sp = line.lastIndexOf(' ');
    int n = sp > 0 ? line.substring(sp + 1).toInt() : 0;
    if (n > 0) {                       // "TABLE 5" ส่งทันที
      handleScan(line.substring(0, sp));
      if (hasPending) { pendingQty = constrain(n, 1, 9999); confirmPending(); }
    } else {
      handleScan(line);
    }
  }
}

bool readLine(Stream& s, String& buf, String& out) {
  while (s.available()) {
    char c = s.read();
    if (c == '\r' || c == '\n') {
      if (buf.length()) { out = buf; buf = ""; return true; }
    } else if (buf.length() < 200) {
      buf += c;
    }
  }
  return false;
}

bool pressed(Button& b) {
  bool down = digitalRead(b.pin) == LOW;
  if (down != b.down && millis() - b.t > 40) {
    b.down = down;
    b.t = millis();
    return down;
  }
  return false;
}

void connectWifi(uint32_t waitMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("กำลังต่อ WiFi " WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < waitMs) { delay(300); Serial.print('.'); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " สำเร็จ IP " + WiFi.localIP().toString() : String(" ยังไม่สำเร็จ จะลองใหม่ภายหลัง"));
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(9600, SERIAL_8N1, PIN_SCAN_RX, PIN_SCAN_TX);
  pinMode(PIN_BTN_PLUS, INPUT_PULLUP);
  pinMode(PIN_BTN_MINUS, INPUT_PULLUP);
  pinMode(PIN_BTN_OK, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  delay(300);
  Serial.println("\n=== Cargo Bot Station " DEVICE_ID " FW " FW_VERSION " ===");

  connectWifi(20000);
  if (WiFi.status() == WL_CONNECTED && ping()) {
    loadProducts();
    heartbeat();
    beepOk();
  } else {
    beepErr();
  }
  lastBeat = millis();
  printHelp();
}

void loop() {
  String line;
  if (readLine(Serial2, scanBuf, line)) handleScan(line);
  if (readLine(Serial, serialBuf, line)) handleSerialCommand(line);

  if (pressed(btnPlus)) setQty(pendingQty + 1);
  if (pressed(btnMinus)) { if (hasPending && pendingQty <= 1) cancelPending(); else setQty(pendingQty - 1); }   // - ที่จำนวน 1 = ยกเลิก
  if (pressed(btnOk)) confirmPending();

  if (WiFi.status() != WL_CONNECTED) {
    digitalWrite(PIN_LED, (millis() / 500) % 2);   // ไฟกะพริบ = WiFi หลุด
    if (millis() - lastWifiTry > 10000) { lastWifiTry = millis(); WiFi.reconnect(); }
    return;
  }
  if (products.empty() && millis() - lastWifiTry > 10000) { lastWifiTry = millis(); loadProducts(); }

  processQueue();
  if (millis() - lastBeat > HEARTBEAT_MS) { lastBeat = millis(); heartbeat(); }
}
