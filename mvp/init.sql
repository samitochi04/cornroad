CREATE TABLE IF NOT EXISTS signups (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100)  NOT NULL,
  phone      VARCHAR(30)   NOT NULL UNIQUE,
  email      VARCHAR(254),
  source     VARCHAR(100)  DEFAULT 'landing',
  created_at TIMESTAMPTZ   DEFAULT NOW()
);
