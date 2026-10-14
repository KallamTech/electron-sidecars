# minimal-app

Boots Postgres + pgvector, PostgREST and Redis inside Electron and lists their
endpoints plus a row read through PostgREST.

```sh
npm install
npm run bin     # builds ./pg (Postgres 15 + pgvector) and ./bin (postgrest, redis-server)
npm start
```

`npm run bin` needs a PG15 dev install for pgvector's build (`PG_CONFIG`; on
macOS `brew install postgresql@15`). `db/` shows the prelude/migrations/postlude
layout: roles and extensions in the prelude, tables in migrations.
