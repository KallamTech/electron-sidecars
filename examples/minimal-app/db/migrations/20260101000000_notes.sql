CREATE TABLE notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  body text NOT NULL,
  embedding extensions.vector(3),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON notes TO web_anon;
INSERT INTO notes (body, embedding) VALUES ('hello from embedded Postgres', '[1,0,0]');
