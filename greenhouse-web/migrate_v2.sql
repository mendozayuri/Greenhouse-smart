-- Run this ONLY if you already imported the step-1 schema.sql and want to keep your data.
-- It needs MariaDB (XAMPP) because of "IF NOT EXISTS" on columns.
-- Simpler alternative: drop the `greenhouse` database, import the new schema.sql, run seed.js again.
USE greenhouse;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS acked_version INT NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS acked_at TIMESTAMP NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS updated_by INT NULL;

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS rule_id INT NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'rule';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity VARCHAR(10) NOT NULL DEFAULT 'warning';

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

CREATE TABLE IF NOT EXISTS ai_analyses (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  scope       VARCHAR(10) NOT NULL,
  kind        VARCHAR(12) NOT NULL,
  input_hash  CHAR(64) NOT NULL,
  model       VARCHAR(60) NULL,
  result_json MEDIUMTEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_hash (input_hash),
  INDEX idx_ai_user_time (user_id, created_at)
);
