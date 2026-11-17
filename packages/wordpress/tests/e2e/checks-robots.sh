#!/bin/bash
# Sourced by run.sh after the root site has both plugins installed. WP-5: the robots.txt filter.
# Fetches the live /robots.txt and judges it with the real robots-parser (robots-query.mjs).
# Leaves both plugins active, blog_public=1 and no test mu-plugin behind.

rq() { node "$E2E_DIR/robots-query.mjs" "$@"; }                  # <file> <agent> <path> ...
ra() { rq "$1" "$2" "$3"; }                                       # one answer
cnt() { grep -cFx -- "$2" "$1" || true; }                         # exact whole-line count
rget() { curl -s "$B/robots.txt" >"$1"; }
robots_state() { # none|generated|standalone|both
  wpc "$R" plugin deactivate w2agent w2agent-site >/dev/null 2>&1
  case "$1" in
    generated) wpc "$R" plugin activate w2agent-site >/dev/null 2>&1 ;;
    standalone) wpc "$R" plugin activate w2agent >/dev/null 2>&1 ;;
    both) wpc "$R" plugin activate w2agent w2agent-site >/dev/null 2>&1 ;;
  esac
}

robots_default_checks() { # <state> <plain file>
  local state=$1 plain=$2 f="$WORK/robots-default-$1.txt" n
  robots_state "$state"
  rget "$f"
  n=$(wc -c <"$plain" | tr -d ' ')
  chk "WP-5 [$state] default site: 'Disallow: /wp-admin/' once" '[ "$(cnt "$f" "Disallow: /wp-admin/")" = 1 ]'
  chk "WP-5 [$state] default site: 'Allow: /wp-admin/admin-ajax.php' once" '[ "$(cnt "$f" "Allow: /wp-admin/admin-ajax.php")" = 1 ]'
  chk "WP-5 [$state] default site: one Sitemap line" '[ "$(grep -c "^Sitemap:" "$f" || true)" = 1 ]'
  chk "WP-5 [$state] default site: exactly one 'User-agent: *'" '[ "$(grep -ci "^User-agent: \*" "$f" || true)" = 1 ]'
  chk "WP-5 [$state] default site: no w2agent agent group" '! grep -qiE "^User-agent: (OAI-SearchBot|ChatGPT-User|Claude-User|Googlebot)" "$f"'
  chk "WP-5 [$state] default site: output is the plugin-less output" 'head -c "$n" "$f" | cmp -s - "$plain"'
  chk "WP-5 [$state] default site: only an llms.txt comment is added" '[ "$(tail -c +$((n + 1)) "$f" | grep -v "^$" | grep -vc "^# llms.txt: " || true)" = 0 ]'
  chk "WP-5 [$state] default site: llms.txt mentioned at most once" '[ "$(grep -c "llms.txt" "$f" || true)" -le 1 ]'
  chk "WP-5 [$state] default site: ChatGPT-User allowed at /" '[ "$(ra "$f" ChatGPT-User /)" = allowed ]'
}

robots_owner_checks() { # <state> <owner-only file>
  local state=$1 owner=$2 f="$WORK/robots-owner-$1.txt" n
  robots_state "$state"
  rget "$f"
  n=$(wc -c <"$owner" | tr -d ' ')
  chk "WP-5 [$state] owner: owner text kept verbatim at the start" 'head -c "$n" "$f" | cmp -s - "$owner"'
  chk "WP-5 [$state] owner: one 'User-agent: *'" '[ "$(cnt "$f" "User-agent: *")" = 1 ]'
  chk "WP-5 [$state] owner: ChatGPT-User and GPTBot named once each" '[ "$(cnt "$f" "User-agent: ChatGPT-User")" = 1 ] && [ "$(cnt "$f" "User-agent: GPTBot")" = 1 ]'
  chk "WP-5 [$state] owner: three 'Disallow: /' lines (owner only)" '[ "$(cnt "$f" "Disallow: /")" = 3 ]'
  chk "WP-5 [$state] owner: w2agent group appears once" '[ "$(cnt "$f" "User-agent: Claude-User")" = 1 ] && [ "$(cnt "$f" "User-agent: OAI-SearchBot")" = 1 ] && [ "$(cnt "$f" "Allow: /")" = 1 ]'
  chk "WP-5 [$state] owner: llms.txt mentioned at most once" '[ "$(grep -c "llms.txt" "$f" || true)" -le 1 ]'
  local out
  out=$(rq "$f" ChatGPT-User / GPTBot / Claude-User / Claude-User /private/x OAI-SearchBot / OAI-SearchBot /private/x zz-unknown-bot / ClaudeBot / ChatGPT-User /private/x | tr '\n' ' ')
  chk "WP-5 [$state] owner: ChatGPT-User, GPTBot, unknown bot and a training bot stay blocked; Claude-User and OAI-SearchBot allowed at / but not /private/x (got: $out)" \
    '[ "$out" = "blocked blocked allowed blocked allowed blocked blocked blocked blocked " ]'
}

robots_checks() {
  echo "=== WP-5 robots.txt filter (real WordPress, real robots-parser)"
  local plain="$WORK/robots-plain.txt" owner="$WORK/robots-owner-plain.txt" mu="$SITE/wp-content/mu-plugins/w2a-robots-owner.php"
  local state

  robots_state none
  rget "$plain"
  pre "plugin-less default robots.txt has the core lines and a sitemap" 'grep -qx "Disallow: /wp-admin/" "$plain" && grep -q "^Sitemap:" "$plain"'
  for state in generated standalone both; do robots_default_checks "$state" "$plain"; done

  echo "--- blog_public=0 on the real core output (WordPress $(wpc "$R" core version 2>/dev/null | tr -d '\r\n'))"
  wpc "$R" option update blog_public 0 >/dev/null
  robots_state none
  rget "$WORK/robots-private-core.txt"
  echo "core emits for blog_public=0: $(tr '\n' '|' <"$WORK/robots-private-core.txt")"
  pre "core serves its normal robots.txt for blog_public=0 (this WordPress adds no site-wide block; the owner scenario below supplies one)" 'grep -qx "Disallow: /wp-admin/" "$WORK/robots-private-core.txt"'
  for state in generated standalone both; do
    robots_state "$state"
    rget "$WORK/robots-private-$state.txt"
    chk "WP-5 [$state] blog_public=0 (core output): unchanged" 'cmp -s "$WORK/robots-private-$state.txt" "$WORK/robots-private-core.txt"'
  done
  wpc "$R" option update blog_public 1 >/dev/null

  echo "--- an owner who blocks everyone and names two AI agents (mu-plugin at priority 10)"
  cp "$E2E_DIR/robots-owner.php" "$mu"
  robots_state none
  rget "$owner"
  pre "owner mu-plugin controls the plugin-less output" '[ "$(cnt "$owner" "User-agent: ChatGPT-User")" = 1 ] && [ "$(cnt "$owner" "Disallow: /private/")" = 1 ]'
  for state in generated both standalone; do robots_owner_checks "$state" "$owner"; done

  echo "--- the same owner with blog_public=0"
  wpc "$R" option update blog_public 0 >/dev/null
  robots_state none
  rget "$WORK/robots-owner-private-none.txt"
  for state in generated standalone both; do
    robots_state "$state"
    rget "$WORK/robots-owner-private-$state.txt"
    chk "WP-5 [$state] owner + blog_public=0: identical to the plugin-less output" 'cmp -s "$WORK/robots-owner-private-$state.txt" "$WORK/robots-owner-private-none.txt"'
  done
  wpc "$R" option update blog_public 1 >/dev/null
  docker exec "$PREFIX-wp-$R" rm -f /var/www/html/wp-content/mu-plugins/w2a-robots-owner.php
  pre "owner mu-plugin removed" '[ ! -e "$mu" ]'

  echo "--- PHP matcher table: both plugin copies against robots-parser"
  robots_state both
  cp "$E2E_DIR/robots-cases.json" "$SITE/w2a-robots-cases.json"
  cp "$E2E_DIR/robots-matrix.php" "$SITE/w2a-robots-matrix.php"
  wpc "$R" eval-file /var/www/html/w2a-robots-matrix.php >"$WORK/robots-matrix.json" 2>"$WORK/robots-matrix.err"
  pre "matrix ran inside WordPress with both plugin copies" 'node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf-8\"))" "$WORK/robots-matrix.json"'
  node "$E2E_DIR/robots-matrix.mjs" "$E2E_DIR/robots-cases.json" "$WORK/robots-matrix.json" >"$WORK/robots-matrix.out" 2>&1
  local total bad
  total=$(grep -c "^ok\|^FAIL" "$WORK/robots-matrix.out" || true)
  bad=$(grep -c "^FAIL" "$WORK/robots-matrix.out" || true)
  grep "^FAIL" "$WORK/robots-matrix.out" | head -20
  chk "WP-5 matcher table: $total assertions, $bad disagree with robots-parser" '[ "$total" -gt 500 ] && [ "$bad" = 0 ]'
  rm -f "$SITE/w2a-robots-cases.json" "$SITE/w2a-robots-matrix.php"

  robots_state both
}
