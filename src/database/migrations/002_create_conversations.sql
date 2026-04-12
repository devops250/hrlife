CREATE TABLE IF NOT EXISTS conversations (
  id         SERIAL PRIMARY KEY,
  phone      VARCHAR(20) NOT NULL,
  role       VARCHAR(20) NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
