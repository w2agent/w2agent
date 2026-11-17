#!/bin/bash
# Sourced by run.sh. DESTRUCTIVE for the root site: deletes all content, so run it last.
SEED=$GEN_DIR/data/llms.txt
for T in post page w2a_book; do
  IDS=$(wpc "$R" post list --post_type=$T --post_status=publish --format=ids 2>/dev/null)
  F=""
  [ "$T" = w2a_book ] && F=--force
  # shellcheck disable=SC2086
  [ -n "$IDS" ] && wpc "$R" post delete $IDS $F >/dev/null 2>&1
done
pre "no published content left" '[ -z "$(wpc "$R" post list --post_type=post,page,w2a_book --post_status=publish --format=ids 2>/dev/null)" ]'
pre "seed file exists" '[ -s "$SEED" ]'
OUT=$(curl -s "http://localhost:$RP/llms.txt")
chk "WP-7 empty site serves the seed llms.txt" '[ "$OUT" = "$(cat "$SEED")" ]'
