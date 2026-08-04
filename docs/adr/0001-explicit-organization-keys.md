# Carry the Organization key through authoritative relationships

Every project-owned authoritative record carries its Organization identity,
and hierarchical relationships include that identity in the referenced key.
This duplicates a derivable value, but makes cross-Organization references
impossible at the database boundary instead of relying on application filters;
the trade-off is wider keys and more explicit persistence code.
