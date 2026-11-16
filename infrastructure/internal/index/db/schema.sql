CREATE TABLE IF NOT EXISTS advertisements (
  id CHAR(64) PRIMARY KEY,
  functionality CHAR(64) NOT NULL,
  publisher VARCHAR(128) NOT NULL,
  advertisement JSON NOT NULL,
  ingress_time BIGINT NOT NULL,
  INDEX search_functionality (functionality, ingress_time, id)
);
