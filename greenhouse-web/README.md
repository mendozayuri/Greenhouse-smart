# Smart Greenhouse web app

Express + MySQL backend and a plain HTML/JS front end (no build step).
Arduino/ESP32 → backend → database → dashboards + AI analytics.

## What is included
- **Public landing page** explaining the system, with login/register.
- **User side:** live dashboard (stale/offline marking), charts per measurement, history by date range,
  alerts, analytics + AI insights, device settings with **device acknowledgment**.
- **Admin side:** overview, system monitoring, accounts (activate/deactivate/roles), devices (create/rename/
  new key/delete), assignments (assign/move/remove), alert rules (CRUD), activity record,
  system-wide analytics with **filter by user / prototype / date range**, comparison, and AI.
- **AI (Gemini, server side only):** summarize trends, explain anomalies, compare with previous period,
  recommend adjustments. Numbers are calculated in `lib/stats.js`; the AI only interprets them.
  Results show Measured / Calculated / AI-interpretation separately, with range, scope and timestamp.

## Setup (Windows + XAMPP)
1. Install **Node.js LTS** and **XAMPP**, start **MySQL** in XAMPP.
2. `npm install`
3. Copy `.env.example` to `.env`; set `JWT_SECRET` (and `GEMINI_API_KEY` for AI). Never upload `.env`.
4. `npm start` -> open http://localhost:3000
   On first start the server creates the database, tables, the tables by itself.

**Accounts:** there is no built-in admin. On the Register tab choose *User* or *Administrator*. At most 2 administrators and 10 users can register (`MAX_ADMINS`, `MAX_USERS` in `.env`). The first administrator creates greenhouses under *Devices & rules* (the device key is shown once) and assigns users to them.

Optional demo data: `node seed-demo.js` (alice@demo.test / bob@demo.test, password `Demo12345!`). `npm test` runs the unit tests.
If you used the old step-1 schema, drop the `greenhouse` database first (or run `migrate_v2.sql`).

## ESP32 contract
`POST /api/device/readings` (JSON):

    {"device_key":"...","temperature":29.5,"humidity":60,"soil_moisture":42,"state":"IDLE",
     "fan_on":false,"pump_on":false,"light_on":true,"settings_version":2}

- `state`: IDLE | COOLING | WATERING | FAULT. Send `null` for a sensor that failed (raises a critical alert).
- Reply: `{"ok":true,"settings":{"version":3,"temp_on":30,"temp_off":28,"soil_low":40}}`.
  Apply the settings and send the new `version` back as `settings_version` in the next reading: that is the **acknowledgment** the website shows.
- `GET /api/device/settings` with header `x-device-key` also returns the settings.
- Safety (FAULT, sensor failure, timeouts) must stay on the device and not depend on the website or AI.

### Manual pump control (Pump ON / Pump OFF buttons)
1. A user (or an administrator) presses **Pump ON** or **Pump OFF**. The server queues one command (`POST /api/my/pump` or `POST /api/admin/devices/:id/pump`, body `{"device_id":1,"action":"on"|"off"}`). It is refused when the device is offline, when the device is not assigned to the user, or (for ON) when another command is still waiting. **OFF always goes through** and replaces anything still waiting.
2. The next reading reply carries it: `{"ok":true,"settings":{...},"pump_command_id":7,"pump_command_on":1}` (`1` = switch on, `0` = switch off). A command that is not picked up within `COMMAND_TTL_SECONDS` (default 60) expires.
3. The ESP32 acts and reports in its next reading: `"command_id":7,"command_result":"done"` — or `"rejected_fault"` (sensor fault active) / `"rejected_busy"` (pump had only just stopped).
4. The page shows the live pump state and the command status: Waiting for device -> Device received it -> **Acknowledged** (or Rejected / Not delivered).

Safety on the ESP32 (independent of the website): a manual run stops by itself after 60 s, when the server stops answering for 15 s, or when a sensor fault appears. While a manual run is active the ESP32 reports every 3 s so that OFF reacts quickly.

The command is a human decision. Automatic watering (soil below the threshold, including 0 %) and every safety rule stay on the ESP32 and never depend on this command or on the website.

## API summary
| Endpoint | Who | What |
|---|---|---|
| POST /api/register, /api/login, GET /api/me | anyone / user | accounts (bcrypt, JWT) |
| POST /api/device/readings, GET /api/device/settings | device key | store reading, fetch/ack settings |
| GET /api/my/devices, overview, readings, series, alerts, rules, analytics | user | only assigned devices (403 otherwise, logged) |
| GET/PUT /api/my/settings | user | validated thresholds, ack status |
| POST /api/my/pump, POST /api/admin/devices/:id/pump | user (assigned) / admin | pump ON / OFF command, acknowledged by the device |
| POST /api/my/ai | user | AI analysis `{device_id, from, to, kind}` |
| /api/admin/overview, users, devices, assignments, assign, rules, monitor, alerts, activity, series, analytics, ai | admin | everything above, system-wide |

`kind`: summary, anomalies, compare, recommend. All admin routes check the role in the database on every request.

## How shared prototypes are not double counted
Readings belong to a **device**, never a user. Assignments only decide who may see a device. Analytics query
devices (de-duplicated with DISTINCT) and each reading is counted once, whichever users share it.

## Rules the AI part follows
- Statistics computed in code; AI gets only those numbers. Figures in the AI text that are not in the data are flagged.
- Needs `MIN_READINGS_FOR_AI` readings, else "insufficient data" (no API call).
- API failure, timeout, usage limit (HTTP 429), bad format → clear message; statistics stay visible.
- Cache for identical data, 15 s cooldown, 20 generations/user/day (`.env`).
- Suggested settings are only loaded into the settings form; a person must press Save.

## Tests to run for the report
`npm test` (statistics, anomaly detection, AI validation, fake-AI failures). Manual: login as Alice and open
Greenhouse 2 (rejected, appears in Admin → Activity as `access_denied`); call an `/api/admin/...` URL as a user (403).
