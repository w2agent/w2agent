#!/bin/bash
# Sourced by run.sh. DESTRUCTIVE for the root site: deletes all content, so run it last.
# The crawl-time seed llms.txt may be served only while WordPress holds no posts of the listed
# types in any status (auto-draft aside, trash included).
SEED=$GEN_DIR/data/llms.txt
TYPES=post,page,w2a_book
STATUSES=publish,draft,private,pending,future,trash
all_ids() { wpc "$R" post list --post_type=$TYPES --post_status=$STATUSES --format=ids 2>/dev/null; }

KEEP=$(wpc "$R" post list --post_type=page --title=Contact --field=ID 2>/dev/null | head -1)
pre "kept page found ($KEEP)" '[ -n "$KEEP" ]'
OTHERS=""
for ID in $(all_ids); do [ "$ID" = "$KEEP" ] || OTHERS="$OTHERS $ID"; done
# shellcheck disable=SC2086
[ -n "$OTHERS" ] && wpc "$R" post delete $OTHERS --force >/dev/null 2>&1
pre "exactly one post left" '[ "$(all_ids | wc -w | tr -d " ")" = 1 ]'
pre "seed file exists" '[ -s "$SEED" ]'

wpc "$R" post update "$KEEP" --post_status=private >/dev/null 2>&1
wpc "$R" transient delete w2agent_site_llms_txt >/dev/null 2>&1
OUT=$(curl -s "http://localhost:$RP/llms.txt")
chk "C1 only post is private: llms.txt is not the seed" '[ "$OUT" != "$(cat "$SEED")" ]'
chk "C1 only post is private: its title is not served" '! grep -q "Contact" <<<"$OUT"'
chk "C1 only post is private: still a valid empty llms.txt" 'grep -q "^# " <<<"$OUT"'

wpc "$R" post update "$KEEP" --post_status=trash >/dev/null 2>&1
OUT=$(curl -s "http://localhost:$RP/llms.txt")
chk "C1 only post is in the trash: llms.txt is not the seed" '[ "$OUT" != "$(cat "$SEED")" ]'

# shellcheck disable=SC2046
wpc "$R" post delete $(all_ids) --force >/dev/null 2>&1
pre "no posts left in any status, trash included" '[ -z "$(all_ids)" ]'
OUT=$(curl -s "http://localhost:$RP/llms.txt")
chk "WP-7 a site without any post serves the seed llms.txt" '[ "$OUT" = "$(cat "$SEED")" ]'
