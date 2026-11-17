-- Run this once to create the database and tables.
CREATE DATABASE IF NOT EXISTS greenhouse CHARACTER SET utf8mb4;
USE greenhouse;

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role          ENUM('user','admin') NOT NULL DEFAULT 'user',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(60) NOT NULL,
  api_key    VARCHAR(64) NOT NULL UNIQUE,
  last_seen  TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Which user may see which device. One device can have many users.
CREATE TABLE IF NOT EXISTS assignments (
  user_id   INT NOT NULL,
  device_id INT NOT NULL,
  PRIMARY KEY (user_id, device_id),
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Readings belong to a DEVICE (not a user), so shared devices are never counted twice.
CREATE TABLE IF NOT EXISTS readings (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id     INT NOT NULL,
  temperature   FLOAT NULL,
  humidity      FLOAT NULL,
  soil_moisture FLOAT NULL,
  state         VARCHAR(20) NULL,
  fan_on        BOOLEAN NULL,
  pump_on       BOOLEAN NULL,
  light_on      BOOLEAN NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_device_time (device_id, created_at),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Used in the next steps (settings from the website, alerts):
CREATE TABLE IF NOT EXISTS settings (
  device_id INT PRIMARY KEY,
  temp_on   FLOAT NOT NULL DEFAULT 30,
  temp_off  FLOAT NOT NULL DEFAULT 28,
  soil_low  FLOAT NOT NULL DEFAULT 40,
  version        INT NOT NULL DEFAULT 1,      -- increases every time a person changes a setting
  acked_version  INT NOT NULL DEFAULT 0,      -- last version the DEVICE confirmed it applied
  acked_at       TIMESTAMP NULL,
  updated_by     INT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Alert rules are managed by administrators (create / read / update / delete).
CREATE TABLE IF NOT EXISTS alert_rules (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  device_id  INT NOT NULL,
  metric     ENUM('temperature','humidity','soil_moisture') NOT NULL,
  operator   ENUM('>','<') NOT NULL,
  threshold  FLOAT NOT NULL,
  message    VARCHAR(120) NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alerts (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  device_id  INT NOT NULL,
  rule_id    INT NULL,
  type       VARCHAR(20) NOT NULL DEFAULT 'rule',   -- rule | sensor | fault
  severity   VARCHAR(10) NOT NULL DEFAULT 'warning', -- warning | critical
  message    VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_alert_device_time (device_id, created_at),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (rule_id)   REFERENCES alert_rules(id) ON DELETE SET NULL
);

-- Who did what (logins, setting changes, admin actions, denied attempts, AI requests).
CREATE TABLE IF NOT EXISTS activity_log (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NULL,
  device_id  INT NULL,
  action     VARCHAR(40) NOT NULL,
  detail     VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_activity_time (created_at),
  INDEX idx_activity_user (user_id, created_at)
);

-- Saved AI answers: the same data is never sent to the AI twice (saves quota).
CREATE TABLE IF NOT EXISTS ai_analyses (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  scope       VARCHAR(10) NOT NULL,          -- user | system
  kind        VARCHAR(12) NOT NULL,
  input_hash  CHAR(64) NOT NULL,
  model       VARCHAR(60) NULL,
  result_json MEDIUMTEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_hash (input_hash),
  INDEX idx_ai_user_time (user_id, created_at)
);

-- Manual commands from the website to the device (currently: run the pump once).
-- Flow: pending (queued) -> sent (device received it) -> done | rejected (device acknowledged) | expired (never picked up)
CREATE TABLE IF NOT EXISTS device_commands (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  device_id    INT NOT NULL,
  action       VARCHAR(20) NOT NULL DEFAULT 'pump_run',
  status       VARCHAR(12) NOT NULL DEFAULT 'pending',
  result       VARCHAR(100) NULL,
  requested_by INT NULL,
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sent_at      TIMESTAMP NULL,
  acked_at     TIMESTAMP NULL,
  INDEX idx_cmd_device (device_id, id),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);
