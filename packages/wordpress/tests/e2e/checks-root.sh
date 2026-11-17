#!/bin/bash
# Sourced by run.sh with both plugins active on the root site. Needs RP (port), R (scenario), SITE.
B=http://localhost:$RP
GEN_DIR=$SITE/wp-content/plugins/w2agent-site

L=$(curl -s "$B/llms.txt")
pre "pages listed at all" 'grep -q "Cache probe page" <<<"$L"'
pre "books listed at all" 'grep -q "Public book" <<<"$L"'
chk "WP-3 no password page/book" '! grep -q "SECRET-EXCERPT\|SECRET-CONTENT\|Locked page\|Locked book" <<<"$L"'
chk "WP-3 no builder template CPT" '! grep -q "Header template\|TEMPLATE-CONTENT" <<<"$L"'
chk "WP-3 shortcode stripped" '! grep -q "\[gallery" <<<"$L"'
chk "WP-3 no draft/private" '! grep -q "DRAFT-CONTENT\|PRIVATE-CONTENT\|Draft post\|Private post" <<<"$L"'
chk "WP-4 newest post listed" 'grep -q "Newest post marker" <<<"$L"'

H=$(curl -s "$B/")
pre "webmcp file installed" '[ -f "$GEN_DIR/w2agent-webmcp.php" ]'
chk "WP-2 webmcp script in the front page" 'grep -q "modelContext" <<<"$H"'
WM=$(curl -s "$B/?w2a_log_probe=1" | grep -c "modelContext" || true)
chk "WP-2 webmcp script appears once per page ($WM line(s) mention it)" '[ "$WM" -ge 1 ] && [ "$WM" = "$(grep -c "modelContext" <<<"$H" || true)" ]'

chk "WP-7 llms-full served 200" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$B/llms-full.txt")" = 200 ]'
F=$(curl -s "$B/llms-full.txt")
chk "WP-7 llms-full no secret" '! grep -q "SECRET-CONTENT" <<<"$F"'
chk "WP-7 llms-full is the crawl snapshot file" '[ "$F" = "$(cat "$GEN_DIR/data/llms-full.txt")" ]'

# cache: a direct DB edit must not show until a WordPress update clears the cache
PID=$(wpc "$R" post list --post_type=page --title="Cache probe page" --field=ID 2>/dev/null | head -1)
pre "probe id found ($PID)" '[ -n "$PID" ]'
curl -s "$B/llms.txt" >/dev/null
wpc "$R" db query "UPDATE wp_posts SET post_title='DB-EDIT-TITLE' WHERE ID=$PID" >/dev/null
pre "db edit applied" '[ "$(wpc "$R" post get "$PID" --field=post_title 2>/dev/null)" = DB-EDIT-TITLE ]'
L2=$(curl -s "$B/llms.txt")
chk "WP-7 cached (direct DB edit not visible)" '! grep -q "DB-EDIT-TITLE" <<<"$L2"'
wpc "$R" post update "$PID" --post_title="Updated via WP" >/dev/null
L3=$(curl -s "$B/llms.txt")
chk "WP-7 cache cleared on update" 'grep -q "Updated via WP" <<<"$L3"'
