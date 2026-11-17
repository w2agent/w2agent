#!/bin/bash
# Sourced by run.sh. Needs the generated plugin in the root site (from integrate --install).
# sub_checks <scenario> <port>, ms_checks <scenario> <port>

sub_checks() {
  local sub=$1 port=$2
  local src=$GEN_DIR dest
  dest=$(wp_host_dir "$sub")/wp-content/plugins/w2agent-site
  echo "=== subdirectory install (/blog)"
  cp -R "$src" "$dest"
  wpc "$sub" plugin activate w2agent-site 2>&1 | tail -1
  wpc "$sub" post create --post_status=publish --post_title=SubdirPost >/dev/null 2>&1
  pre "blog home 200" '[ "$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/blog/")" = 200 ]'
  local code
  code=$(curl -s -o "$WORK/sub-llms.txt" -w "%{http_code}" "http://localhost:$port/blog/llms.txt")
  chk "WP-6 /blog/llms.txt 200 (got $code)" '[ "$code" = 200 ]'
  chk "WP-6 /blog/llms.txt lists subdir post" 'grep -q SubdirPost "$WORK/sub-llms.txt"'
  local h
  h=$(curl -s "http://localhost:$port/blog/")
  chk "WP-6 head link points at /blog/llms.txt" 'grep -q "href=\"http://localhost:$port/blog/llms.txt\"" <<<"$h"'
  chk "WP-7 /blog/llms-full.txt 200" '[ "$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/blog/llms-full.txt")" = 200 ]'
  chk "WP-2 webmcp script on the subdirectory front page" 'grep -q modelContext <<<"$h"'
}

ms_checks() {
  local ms=$1 port=$2
  local src=$GEN_DIR
  echo "=== multisite (subdomain network, Host header)"
  cp -R "$src" "$(wp_host_dir "$ms")/wp-content/plugins/w2agent-site"
  wpc "$ms" site create --slug=second >/dev/null 2>&1
  wpc "$ms" plugin activate w2agent-site --network 2>&1 | tail -1
  wpc "$ms" --url=second.w2a.test post create --post_status=publish --post_title=SecondSitePost >/dev/null 2>&1
  wpc "$ms" post create --post_status=publish --post_title=MainSitePost >/dev/null 2>&1
  M() { curl -s -H "Host: $1" "http://localhost:$port$2"; }
  MC() { curl -s -o /dev/null -w "%{http_code}" -H "Host: $1" "http://localhost:$port$2"; }
  pre "main card present in data" '[ -f "$GEN_DIR/data/agent-card.json" ]'
  chk "main site serves agent card" '[ "$(MC w2a.test /.well-known/agent-card.json)" = 200 ]'
  chk "WP-6 second site does not serve main card" '[ "$(MC second.w2a.test /.well-known/agent-card.json)" != 200 ]'
  chk "WP-7 second site does not serve main llms-full" '[ "$(MC second.w2a.test /llms-full.txt)" != 200 ]'
  chk "WP-7 main site serves llms-full" '[ "$(MC w2a.test /llms-full.txt)" = 200 ]'
  local l2 r2
  l2=$(M second.w2a.test /llms.txt)
  chk "second site llms lists own post" 'grep -q SecondSitePost <<<"$l2"'
  chk "second site llms omits main post" '! grep -q MainSitePost <<<"$l2"'
  r2=$(M second.w2a.test /robots.txt)
  chk "WP-6 second site robots has no crawled rules copy" '! grep -q "w2agent: suggested" <<<"$r2"'
  chk "WP-2 second site front page has no webmcp script" '! M second.w2a.test / | grep -q modelContext'
  chk "WP-2 main site front page has the webmcp script" 'M w2a.test / | grep -q modelContext'
}
