CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'completed', 'void')),
  order_mode TEXT NOT NULL DEFAULT 'parallel' CHECK (order_mode IN ('parallel', 'sequential')),
  message TEXT NOT NULL DEFAULT '',
  original_key TEXT NOT NULL,
  completed_key TEXT,
  page_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  completed_at TEXT,
  voided_at TEXT
);

CREATE TABLE signers (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'signed')),
  order_index INTEGER NOT NULL,
  signed_at TEXT,
  viewed_at TEXT
);

CREATE TABLE fields (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  signer_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('signature', 'initials', 'text', 'date', 'checkbox')),
  page INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT ''
);

CREATE TABLE field_values (
  field_id TEXT PRIMARY KEY,
  signer_id TEXT NOT NULL,
  text_value TEXT,
  image_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_signers_document ON signers (document_id, order_index);
CREATE INDEX idx_fields_document ON fields (document_id);
CREATE INDEX idx_audit_document ON audit_events (document_id, at);
