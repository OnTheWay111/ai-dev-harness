# Preserve planning history as append-only revisions

Clarifications and Decisions are stored as immutable revision chains rather than mutable rows because later approvals must prove exactly which question, answer, subject version, outcome, and reason existed at the time. This costs additional rows and requires callers to follow predecessor links, but prevents edits from rewriting the evidence behind a Spec Revision or Issue plan; PostgreSQL rejects updates and deletes while application services append successors.
