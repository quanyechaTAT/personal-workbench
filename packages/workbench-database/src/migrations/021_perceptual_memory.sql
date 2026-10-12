ALTER TABLE knowledge_documents ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE knowledge_representations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  content_version INTEGER NOT NULL,
  model_fingerprint TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE INDEX knowledge_representations_document ON knowledge_representations(project_id, document_id);
CREATE TABLE knowledge_perceptual_vectors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  content_version INTEGER NOT NULL,
  space_id TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE INDEX knowledge_perceptual_vectors_space ON knowledge_perceptual_vectors(project_id, space_id, dimension);
