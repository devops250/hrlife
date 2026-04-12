CREATE TABLE IF NOT EXISTS events (
  id         SERIAL PRIMARY KEY,
  type       VARCHAR(50) NOT NULL,
  phone      VARCHAR(20),
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
