#!/bin/bash
# Sourced by run.sh. Usage: cache_context <port> <plugin slug> <transient name>
# w2a-members.php hides "Members only post" unless the current user can edit posts. The shared llms.txt
# cache must be built without a user, so the text an admin triggers must not leak to anonymous visitors.
cache_context() {
  local port=$1 plugin=$2 transient=$3 B=http://localhost:$1
  local jar="$WORK/jar-$plugin.txt" pjar="$WORK/pjar-$plugin.txt"
  wpc "$R" plugin deactivate --all >/dev/null 2>&1
  wpc "$R" plugin activate "$plugin" >/dev/null 2>&1
  curl -s -c "$jar" -b "wordpress_test_cookie=WP%20Cookie%20check" -o /dev/null \
    --data "log=admin&pwd=admin&wp-submit=Log+In&testcookie=1" "$B/wp-login.php"
  curl -s -c "$pjar" -o /dev/null --data "post_password=pw" "$B/wp-login.php?action=postpass"
  pre "$plugin: admin login cookie" '[ "$(grep -c wordpress_logged_in "$jar")" -ge 1 ]'
  pre "$plugin: post-password cookie" '[ "$(grep -c wp-postpass "$pjar")" -ge 1 ]'
  wpc "$R" transient delete "$transient" >/dev/null 2>&1
  curl -s -b "$jar" "$B/llms.txt" >/dev/null
  chk "cache: $plugin admin-built text hides members-only item from anonymous" '! curl -s "$B/llms.txt" | grep -q "Members only post"'
  wpc "$R" transient delete "$transient" >/dev/null 2>&1
  curl -s -b "$pjar" "$B/llms.txt" >/dev/null
  chk "cache: $plugin post-password-built text lists no locked page" '! curl -s "$B/llms.txt" | grep -q "Locked page\|SECRET"'
  wpc "$R" transient delete "$transient" >/dev/null 2>&1
  curl -s "$B/llms.txt" >/dev/null
  chk "cache: $plugin anonymous-built text still lists public posts" 'curl -s "$B/llms.txt" | grep -q "Newest post marker"'
}
