-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  last_login TEXT,
  credits INTEGER DEFAULT 5,
  gsc_refresh_token TEXT,
  gsc_connected INTEGER DEFAULT 0
);

-- GSC data storage
CREATE TABLE IF NOT EXISTS gsc_data (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  date_range TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Insights table
CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Credit usage logs
CREATE TABLE IF NOT EXISTS credit_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- User properties (GSC sites)
CREATE TABLE IF NOT EXISTS user_properties (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  display_name TEXT,
  added_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_gsc_data_user_site ON gsc_data (user_id, site_url);
CREATE INDEX IF NOT EXISTS idx_insights_user_date ON insights (user_id, date);
CREATE INDEX IF NOT EXISTS idx_credit_logs_user ON credit_logs (user_id);