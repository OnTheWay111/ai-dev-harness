# Keep large artifacts outside PostgreSQL

Evidence, audit details, idempotent responses, and later prompts or reports store immutable object references plus SHA-256 digests instead of large content in PostgreSQL. This introduces an object-store dependency and dereference step, but keeps transactions and backups bounded while allowing content integrity, retention, and access policy to be managed explicitly.
