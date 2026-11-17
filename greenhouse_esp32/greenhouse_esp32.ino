/*
  Smart Greenhouse - ESP32 controller
  ---------------------------------------------------------------
  Inputs   : DHT11 (temperature, humidity), soil moisture (analog), LDR (digital)
  Outputs  : pump relay (K1), fan relay (K2), LED light (GPIO27), fan LED, buzzer
  States   : IDLE, COOLING, WATERING, FAULT
  Network  : POST /api/device/readings every SEND_MS; the reply carries new settings
  Safety   : everything below works WITHOUT Wi-Fi, the website or the AI.

  Setup: copy secrets.example.h to secrets.h and fill it in.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include "DHT.h"
#include "secrets.h"      // WIFI_SSID, WIFI_PASS, SERVER_URL, DEVICE_KEY

// =====================================================================
// 1. PINS
// =====================================================================
#define DHTPIN  4
#define DHTTYPE DHT11
const int SOIL_PIN    = 34;   // analog, input only
const int LDR_PIN     = 35;   // LDR module DO (digital), input only
const int PUMP_RELAY  = 25;   // D25 -> relay IN1 (K1) -> pump
const int FAN_RELAY   = 26;   // D26 -> relay IN2 (K2) -> fan
const int LIGHT_RELAY = 27;   // LED light straight on the pin (resistor in series), no relay
const int FAN_LED     = 23;   // mirrors the fan until the real fan is installed
const int BUZZER_PIN  = 22;

const bool RELAY_ACTIVE_LOW = true;   // pump/fan relays: most kit relays switch ON when the pin is LOW
const bool LIGHT_ACTIVE_LOW = false;  // LED wired straight to the pin: false.  Light on a RELAY: true
const bool FAN_ACTIVE_LOW   = true;   // fan on a RELAY: true.  Fan on a transistor/MOSFET driver: false
const bool DARK_IS_HIGH     = true;   // LDR module output (DO) is HIGH when dark. Light reacts backwards? set false

// =====================================================================
// 2. CALIBRATION AND TIMING
// =====================================================================
const int SOIL_DRY_RAW = 3270;        // sensor in dry soil    = 0 %
const int SOIL_WET_RAW = 2316;        // sensor in soaked soil = 100 %

const unsigned long READ_MS      = 2000;    // temperature + soil check
const unsigned long LDR_READ_MS  = 200;     // light check
const unsigned long SEND_MS      = 10000;   // upload interval
const unsigned long WIFI_RETRY_MS = 10000;
const unsigned long COMM_LOSS_MS = 60000;   // no successful upload for this long = communication lost

const int DARK_CONFIRM = 3;                 // same light reading this many times in a row

const unsigned long PUMP_RUN_MS  = 5000;    // pump safety timeout
const unsigned long SOAK_WAIT_MS = 30000;   // wait before watering again
const int           SOIL_EMPTY_PCT = 0;     // soil at this level or below = completely dry
const unsigned long EMPTY_SOAK_MS  = 10000; // completely dry soil: water again after a shorter wait
const unsigned long MANUAL_MIN_GAP_MS = 3000;  // website Pump ON is refused this soon after the pump stopped
const unsigned long MANUAL_MAX_MS  = 60000;  // a website Pump ON run stops by itself after this long
const unsigned long MANUAL_COMM_MS = 15000;  // ...or when the server has not answered for this long
const unsigned long SEND_MANUAL_MS = 3000;   // upload interval while a manual run is active (so OFF arrives fast)
const int MAX_WATER_TRIES = 3;              // still dry after this many waterings = FAULT
const int MAX_FAILS       = 3;              // bad sensor reads in a row = FAULT

// Limits are the same as the website (server.js SETTING_LIMITS).
const float TEMP_ON_MIN = 10, TEMP_ON_MAX = 50;
const float TEMP_OFF_MIN = 5, TEMP_OFF_MAX = 49;
const int   SOIL_LOW_MIN = 5, SOIL_LOW_MAX = 90;

// =====================================================================
// 3. SETTINGS (defaults; the website can change them, flash remembers them)
// =====================================================================
float TEMP_ON  = 30.0;   // fan ON at or above (C)
float TEMP_OFF = 28.0;   // fan OFF at or below (C)
int   SOIL_LOW = 40;     // water when soil is below this (%)
int   appliedVersion = 0;   // settings version in use; sent back as the acknowledgment

// =====================================================================
// 4. STATE
// =====================================================================
enum State { IDLE, COOLING, WATERING, FAULT };
const char* STATE_NAMES[] = { "IDLE", "COOLING", "WATERING", "FAULT" };

DHT dht(DHTPIN, DHTTYPE);
Preferences prefs;

State state = IDLE;
bool fanOn = false, pumpOn = false, lightOn = false;
bool isDark = false;
int  ldrLevel = 0;            // raw LDR module level, shown in the status line to check the wiring
int  darkCount = 0, brightCount = 0;

float temp = NAN, hum = NAN;
int   soilRaw = 0, soilPct = 0;
int   dhtFails = 0, soilFails = 0, waterTries = 0;
const char* faultReason = "";

unsigned long lastRead = 0, lastLdr = 0, lastSend = 0, lastWifiTry = 0;
unsigned long pumpStart = 0, lastWatering = 0;
bool hasWatered = false;
bool manualPump = false;   // pump was switched on from the website (runs until OFF or a safety limit)

// Manual pump command from the website
int         lastCmdId = 0;          // last command already handled (saved in flash)
int         reportCmdId = 0;        // command whose result still has to be reported
const char* reportCmdResult = "";   // done | rejected_fault | rejected_busy

bool wifiWasUp = false;
bool commLost = false;
unsigned long lastServerOk = 0;
bool serverEverOk = false;     // true after the first successful upload
int  lastHttpCode = 0;

// =====================================================================
// 5. SMALL HELPERS
// =====================================================================
void relayWrite(int pin, bool on) {
  bool level = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(pin, level ? HIGH : LOW);
}

void setLight(bool on) {
  if (on != lightOn) Serial.printf("[LIGHT] %s\n", on ? "ON (it is dark)" : "OFF (there is light)");
  lightOn = on;
  bool level = LIGHT_ACTIVE_LOW ? !on : on;
  digitalWrite(LIGHT_RELAY, level ? HIGH : LOW);
}

void setOutputs(bool fan, bool pump) {
  if (fan != fanOn)   Serial.printf("[FAN]   %s\n", fan ? "ON" : "OFF");
  if (pump != pumpOn) Serial.printf("[PUMP]  %s\n", pump ? "ON" : "OFF");
  fanOn = fan;
  pumpOn = pump;
  if (!pump) manualPump = false;      // any stop (OFF, timeout, fault) ends a manual run
  digitalWrite(FAN_RELAY, (FAN_ACTIVE_LOW ? !fan : fan) ? HIGH : LOW);
  relayWrite(PUMP_RELAY, pump);
  digitalWrite(FAN_LED, fan ? HIGH : LOW);
}

int readAvg(int pin, int samples) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delay(3);
  }
  return sum / samples;
}

// Number -> text, or "--" when the sensor gave no value.
void fmtFloat(char* out, size_t n, float v, const char* fmt) {
  if (isnan(v)) strlcpy(out, "--", n); else snprintf(out, n, fmt, v);
}

// =====================================================================
// 6. SETTINGS FROM FLASH AND FROM THE WEBSITE
// =====================================================================
void loadSettings() {
  prefs.begin("greenhouse", false);
  float on  = prefs.getFloat("temp_on", TEMP_ON);
  float off = prefs.getFloat("temp_off", TEMP_OFF);
  int   low = prefs.getInt("soil_low", SOIL_LOW);
  // Use saved values only if they are still valid, otherwise keep the defaults.
  if (on >= TEMP_ON_MIN && on <= TEMP_ON_MAX && off >= TEMP_OFF_MIN && off <= on - 1 &&
      low >= SOIL_LOW_MIN && low <= SOIL_LOW_MAX) {
    TEMP_ON = on; TEMP_OFF = off; SOIL_LOW = low;
    appliedVersion = prefs.getInt("version", 0);
  }
  lastCmdId = prefs.getInt("last_cmd", 0);
  Serial.printf("[CFG]   loaded v%d: fan on %.1f C, fan off %.1f C, soil below %d %%\n",
                appliedVersion, TEMP_ON, TEMP_OFF, SOIL_LOW);
}

// Finds  "key":<number>  in the server's JSON reply.
bool jsonNum(const String& s, const char* key, float& out) {
  String k = String("\"") + key + "\":";
  int i = s.indexOf(k);
  if (i < 0) return false;
  out = s.substring(i + k.length()).toFloat();
  return true;
}

// Applies settings from the server only when they are valid.
void applyServerSettings(const String& resp) {
  float on, off, low, ver;
  if (!(jsonNum(resp, "temp_on", on) && jsonNum(resp, "temp_off", off) &&
        jsonNum(resp, "soil_low", low) && jsonNum(resp, "version", ver))) {
    Serial.println("[CFG]   reply had no settings");
    return;
  }
  if (on < TEMP_ON_MIN || on > TEMP_ON_MAX || off < TEMP_OFF_MIN || off > on - 1 ||
      low < SOIL_LOW_MIN || low > SOIL_LOW_MAX) {
    Serial.println("[CFG]   REJECTED: values out of range");
    return;
  }
  if ((int)ver == appliedVersion) return;          // nothing new

  TEMP_ON = on; TEMP_OFF = off; SOIL_LOW = (int)low; appliedVersion = (int)ver;
  prefs.putFloat("temp_on", TEMP_ON);
  prefs.putFloat("temp_off", TEMP_OFF);
  prefs.putInt("soil_low", SOIL_LOW);
  prefs.putInt("version", appliedVersion);
  Serial.printf("[CFG]   APPLIED v%d: fan on %.1f C, fan off %.1f C, soil below %d %%\n",
                appliedVersion, TEMP_ON, TEMP_OFF, SOIL_LOW);
  // The next upload sends settings_version = appliedVersion: that is the acknowledgment.
}

// Pump ON / OFF from the website. The server puts  "pump_command_id":N,"pump_command_on":1|0
// in its reply. Safety always wins: a sensor fault refuses ON, and a manual run stops by itself
// after MANUAL_MAX_MS or when the server stops answering.
void handleServerCommand(const String& resp, unsigned long now) {
  float id, wantOn;
  if (!jsonNum(resp, "pump_command_id", id) || id <= 0) return;
  if (!jsonNum(resp, "pump_command_on", wantOn)) return;
  int cmdId = (int)id;
  if (cmdId == lastCmdId) return;                  // already handled (its result may still be on the way)
  lastCmdId = cmdId;
  prefs.putInt("last_cmd", cmdId);
  reportCmdId = cmdId;

  if (wantOn < 0.5f) {                             // ---- OFF: always allowed ----
    if (pumpOn) setOutputs(fanOn, false);
    manualPump = false;
    lastWatering = now;
    hasWatered = true;
    reportCmdResult = "done";
    Serial.printf("[CMD]   website command #%d: pump OFF\n", cmdId);
    return;
  }

  // ---- ON ----
  bool sensorFault = (dhtFails >= MAX_FAILS) || (soilFails >= MAX_FAILS);
  bool tooSoon     = !pumpOn && hasWatered && (now - lastWatering < MANUAL_MIN_GAP_MS);

  if (sensorFault) {
    reportCmdResult = "rejected_fault";
    Serial.printf("[CMD]   website command #%d: pump ON REJECTED (sensor fault)\n", cmdId);
  } else if (tooSoon) {
    reportCmdResult = "rejected_busy";
    Serial.printf("[CMD]   website command #%d: pump ON REJECTED (just stopped)\n", cmdId);
  } else {
    waterTries = 0;                                // a person asked for it: clears a "still dry" fault
    pumpStart = now;                               // the manual time limit counts from now
    if (!pumpOn) setOutputs(fanOn, true);
    manualPump = true;                             // set after setOutputs (which clears it on a stop)
    state = WATERING;
    reportCmdResult = "done";
    Serial.printf("[CMD]   website command #%d: pump ON (stops at OFF, after %lu s, or if the server stops answering)\n",
                  cmdId, MANUAL_MAX_MS / 1000);
  }
}

// =====================================================================
// 7. WI-FI AND UPLOAD  (never blocks the control logic for long)
// =====================================================================
void serviceWifi(unsigned long now) {
  bool up = (WiFi.status() == WL_CONNECTED);
  if (up && !wifiWasUp) Serial.printf("[WIFI]  connected, IP %s\n", WiFi.localIP().toString().c_str());
  if (!up && wifiWasUp) Serial.println("[WIFI]  connection lost, retrying in background");
  wifiWasUp = up;

  if (!up && now - lastWifiTry >= WIFI_RETRY_MS) {
    lastWifiTry = now;
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  // Communication-loss supervision: control keeps running on the saved settings.
  bool lost = (now - lastServerOk > COMM_LOSS_MS);
  if (lost && !commLost) Serial.println("[COMM]  server not reachable: running on saved settings");
  if (!lost && commLost) Serial.println("[COMM]  server reachable again");
  commLost = lost;
}

void sendReading() {
  if (WiFi.status() != WL_CONNECTED) {
    lastHttpCode = 0;
    Serial.println("[UPLOAD] skipped (no Wi-Fi)");
    return;
  }

  // null tells the website that a sensor failed (it raises a critical alert).
  char t[16], h[16], s[16];
  if (isnan(temp)) strcpy(t, "null"); else snprintf(t, sizeof(t), "%.1f", temp);
  if (isnan(hum))  strcpy(h, "null"); else snprintf(h, sizeof(h), "%.1f", hum);
  if (soilFails > 0) strcpy(s, "null"); else snprintf(s, sizeof(s), "%d", soilPct);

  // Result of the last website pump command (only while one is waiting to be reported).
  int sentCmdId = reportCmdId;
  char cmd[72] = "";
  if (sentCmdId > 0)
    snprintf(cmd, sizeof(cmd), ",\"command_id\":%d,\"command_result\":\"%s\"", sentCmdId, reportCmdResult);

  char body[480];
  snprintf(body, sizeof(body),
    "{\"device_key\":\"%s\",\"temperature\":%s,\"humidity\":%s,\"soil_moisture\":%s,"
    "\"state\":\"%s\",\"fan_on\":%s,\"pump_on\":%s,\"light_on\":%s,\"settings_version\":%d%s}",
    DEVICE_KEY, t, h, s, STATE_NAMES[state],
    fanOn ? "true" : "false", pumpOn ? "true" : "false", lightOn ? "true" : "false",
    appliedVersion, cmd);

  HTTPClient http;
  http.setConnectTimeout(1500);
  http.setTimeout(2000);
  if (!http.begin(SERVER_URL)) {
    Serial.println("[UPLOAD] bad SERVER_URL");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  lastHttpCode = code;

  String resp = (code > 0) ? http.getString() : "";
  http.end();

  if (code == 200) {
    lastServerOk = millis();
    serverEverOk = true;
    if (sentCmdId > 0 && reportCmdId == sentCmdId) reportCmdId = 0;   // the server has the result
    Serial.printf("[UPLOAD] OK (ack v%d)\n", appliedVersion);
    applyServerSettings(resp);
    handleServerCommand(resp, millis());
  } else if (code > 0) {
    Serial.printf("[UPLOAD] server answered %d: %s\n", code, resp.c_str());   // 400 / 401 / 500 reason
  } else {
    Serial.printf("[UPLOAD] failed: %s\n", http.errorToString(code).c_str());
  }
}

// =====================================================================
// 8. SERIAL STATUS LINE  (one readable line every READ_MS)
// =====================================================================
int statusLines = 0;

void printStatus(unsigned long now) {
  if (statusLines % 15 == 0) {
    Serial.println();
    Serial.println("  time |  temp  hum | soil raw  | ldr  dark | fan pump light | state     | wifi comm cfg");
    Serial.println("-------+------------+-----------+-----------+----------------+-----------+--------------");
  }
  statusLines++;

  char tt[12], hh[12], ss[12];
  fmtFloat(tt, sizeof(tt), temp, "%.1f");
  fmtFloat(hh, sizeof(hh), hum, "%.0f");
  if (soilFails > 0) strcpy(ss, "--"); else snprintf(ss, sizeof(ss), "%d", soilPct);

  Serial.printf("%5lus | %5s %3s | %4s %4d | %-4s %-4s | %-3s %-4s %-5s | %-9s | %-4s %-4s v%d\n",
    now / 1000, tt, hh, ss, soilRaw,
    ldrLevel ? "HIGH" : "LOW", isDark ? "YES" : "no",
    fanOn ? "ON" : "off", pumpOn ? "ON" : "off", lightOn ? "ON" : "off",
    STATE_NAMES[state],
    WiFi.status() == WL_CONNECTED ? "ok" : "--",
    commLost ? "LOST" : (serverEverOk ? "ok" : "wait"),   // "wait" = no upload has succeeded yet
    appliedVersion);

  if (state == FAULT) Serial.printf("        >>> FAULT: %s\n", faultReason);
}

// =====================================================================
// 9. SETUP
// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("=== Smart Greenhouse ESP32 ===");

  // Relays off BEFORE they become outputs, so nothing clicks on at boot.
  digitalWrite(PUMP_RELAY,  RELAY_ACTIVE_LOW ? HIGH : LOW);
  digitalWrite(LIGHT_RELAY, LIGHT_ACTIVE_LOW ? HIGH : LOW);
  digitalWrite(FAN_RELAY,   FAN_ACTIVE_LOW ? HIGH : LOW);
  pinMode(PUMP_RELAY, OUTPUT);
  pinMode(LIGHT_RELAY, OUTPUT);
  pinMode(FAN_RELAY, OUTPUT);
  pinMode(FAN_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LDR_PIN, INPUT);
  setOutputs(false, false);
  setLight(false);

  dht.begin();
  analogReadResolution(12);
  loadSettings();

  Serial.printf("[LIGHT] LDR %s = dark; light output is %s\n",
                DARK_IS_HIGH ? "HIGH" : "LOW", LIGHT_ACTIVE_LOW ? "active-low (relay)" : "active-high (LED on pin)");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);     // does not wait: the greenhouse works without Wi-Fi
  Serial.printf("[WIFI]  connecting to \"%s\" in the background\n", WIFI_SSID);
}

// =====================================================================
// 10. LOOP
// =====================================================================
void loop() {
  unsigned long now = millis();

  // ---- Light: fast check, independent of the other sensors ----
  if (now - lastLdr >= LDR_READ_MS) {
    lastLdr = now;
    ldrLevel = digitalRead(LDR_PIN);
    isDark = (ldrLevel == (DARK_IS_HIGH ? HIGH : LOW));
    if (isDark) { darkCount++; brightCount = 0; } else { brightCount++; darkCount = 0; }
    if (darkCount > 1000)   darkCount = 1000;
    if (brightCount > 1000) brightCount = 1000;
    if (darkCount >= DARK_CONFIRM && !lightOn)   setLight(true);
    if (brightCount >= DARK_CONFIRM && lightOn)  setLight(false);
  }

  // ---- Pump safety: the pump ALWAYS stops by itself ----
  //      automatic watering: after PUMP_RUN_MS      manual run from the website: after MANUAL_MAX_MS
  //      manual run: also stops when the server has not answered for MANUAL_COMM_MS (OFF could not arrive)
  if (pumpOn) {
    unsigned long limit = manualPump ? MANUAL_MAX_MS : PUMP_RUN_MS;
    bool lostContact = manualPump && (now - lastServerOk > MANUAL_COMM_MS);
    if (now - pumpStart >= limit || lostContact) {
      Serial.println(lostContact ? "[PUMP]  lost contact with the website, stopping manual run"
                                 : "[PUMP]  safety timeout reached, stopping");
      setOutputs(fanOn, false);
      lastWatering = now;
      hasWatered = true;
    }
  }

  // ---- Temperature, soil, fan, pump, state ----
  if (now - lastRead >= READ_MS) {
    lastRead = now;

    temp = dht.readTemperature();
    hum  = dht.readHumidity();
    soilRaw = readAvg(SOIL_PIN, 30);
    soilPct = constrain(map(soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW, 0, 100), 0, 100);

    // Sensor checks
    if (isnan(temp) || isnan(hum)) dhtFails++; else dhtFails = 0;
    if (soilRaw < 50 || soilRaw > 4000) soilFails++; else soilFails = 0;
    if (soilFails == 0 && soilPct >= SOIL_LOW) waterTries = 0;     // soil recovered

    bool dhtFault   = dhtFails  >= MAX_FAILS;
    bool soilFault  = soilFails >= MAX_FAILS;
    bool waterFault = waterTries >= MAX_WATER_TRIES && !pumpOn;   // only after the last watering has finished
    bool pumpFault  = soilFault || waterFault;
    bool anyFault   = dhtFault || pumpFault;

    // A fault only stops the actuator that depends on the broken part:
    //   temperature sensor broken -> fan stops      soil sensor / pump problem -> pump stops
    if (anyFault) {
      faultReason = dhtFault   ? "temperature/humidity sensor not responding"
                  : soilFault  ? "soil moisture sensor out of range"
                               : "soil still dry after repeated watering (pump, tank or sensor?)";
      if (state != FAULT) {
        const char* stopped = (dhtFault && pumpFault) ? "fan and pump stopped" : (dhtFault ? "fan stopped" : "pump stopped");
        Serial.printf("[FAULT] %s -> %s\n", faultReason, stopped);
      }
    } else if (state == FAULT) {
      Serial.println("[FAULT] cleared, resuming automatic control");
    }

    // Fan with two thresholds (hysteresis). Needs a working temperature sensor.
    bool fan = fanOn;
    if (dhtFault) {
      fan = false;
    } else {
      if (!isnan(temp) && temp >= TEMP_ON)  fan = true;
      if (!isnan(temp) && temp <= TEMP_OFF) fan = false;
    }

    // Pump: starts by itself when the soil is dry (including 0 %) and the sensor is valid.
    // Completely dry soil (0 %) only waits EMPTY_SOAK_MS between waterings instead of SOAK_WAIT_MS.
    bool pump = pumpOn;
    if (pumpFault) {
      pump = false;
    } else {
      bool soilValid = (soilFails == 0);
      bool soilEmpty = soilValid && soilPct <= SOIL_EMPTY_PCT;
      bool soilDry   = soilValid && soilPct < SOIL_LOW;
      unsigned long soakNeeded = soilEmpty ? EMPTY_SOAK_MS : SOAK_WAIT_MS;
      bool soakDone = !hasWatered || (now - lastWatering >= soakNeeded);

      static const char* lastWhy = "";
      const char* why = "";
      if (!pumpOn && soilDry) {
        if (soakDone) {
          pump = true;
          pumpStart = now;
          waterTries++;
          Serial.printf("[PUMP]  soil %d %% < %d %%%s, watering (try %d of %d)\n",
                        soilPct, SOIL_LOW, soilEmpty ? " (EMPTY)" : "", waterTries, MAX_WATER_TRIES);
        } else {
          why = "waiting for the last watering to soak in";
        }
      }
      if (why != lastWhy && why[0]) Serial.printf("[PUMP]  soil is dry but not watering yet: %s\n", why);
      lastWhy = why;
    }

    setOutputs(fan, pump);
    state = anyFault ? FAULT : (pumpOn ? WATERING : (fanOn ? COOLING : IDLE));

    printStatus(now);
  }

  // ---- Wi-Fi reconnect and communication supervision ----
  serviceWifi(now);

  // ---- Upload. Skipped while an AUTOMATIC watering runs so its short timeout is never delayed.
  //      During a manual run it continues, faster, so that the OFF button reacts quickly. ----
  unsigned long sendEvery = manualPump ? SEND_MANUAL_MS : SEND_MS;
  if (now - lastSend >= sendEvery && (!pumpOn || manualPump)) {
    lastSend = now;
    sendReading();
  }

  // ---- Buzzer beeps in FAULT without blocking ----
  digitalWrite(BUZZER_PIN, (state == FAULT && (now / 300) % 2 == 0) ? HIGH : LOW);
}
