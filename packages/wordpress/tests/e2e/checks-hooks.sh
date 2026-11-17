#!/bin/bash
# Sourced by run.sh. The standalone plugin (slug "sa") and the generated plugin, which loads its
# webhook file from w2agent-site/ (slug "gen"), are both active on the root site.
LOG=$SITE/wp-content/w2a-http.log
reset_log() { docker exec "$PREFIX-wp-$R" sh -c ': > /var/www/html/wp-content/w2a-http.log'; }
count() { if [ -f "$LOG" ]; then grep -c "$1" "$LOG" || true; else echo 0; fi; }

step() { # name, expected standalone requests, expected generated requests, command...
  local name=$1 esa=$2 egen=$3
  shift 3
  reset_log
  "$@" >/dev/null 2>&1
  local sa gen
  sa=$(count "webhook/sa ")
  gen=$(count "webhook/gen ")
  chk "WP-9 $name (standalone=$sa generated=$gen; want $esa/$egen)" '[ "$sa" = "$esa" ] && [ "$gen" = "$egen" ]'
}

DRAFT=$(wpc "$R" post create --post_status=draft --post_title=HookDraft --porcelain 2>/dev/null)
wpc "$R" menu create hookmenu >/dev/null 2>&1
step "draft create" 0 0 wpc "$R" post create --post_status=draft --post_title=HookDraft2
step "publish post" 1 1 wpc "$R" post create --post_status=publish --post_title=HookPub
PUB=$(wpc "$R" post list --title=HookPub --field=ID 2>/dev/null | head -1)
step "update published" 1 1 wpc "$R" post update "$PUB" --post_content=changed
step "unpublish to draft" 1 1 wpc "$R" post update "$PUB" --post_status=draft
step "republish" 1 1 wpc "$R" post update "$PUB" --post_status=publish
step "delete draft permanently" 0 0 wpc "$R" post delete "$DRAFT" --force
step "nav menu item" 0 0 wpc "$R" menu item add-custom hookmenu Foo http://example.com
step "builder template publish" 0 0 wpc "$R" post create --post_type=w2a_tmpl --post_status=publish --post_title=Tpl
step "listed custom type publish" 1 1 wpc "$R" post create --post_type=w2a_book --post_status=publish --post_title=HookBook
step "trash published" 1 1 wpc "$R" post delete "$PUB"
step "empty trash (delete trashed)" 0 0 wpc "$R" post delete "$PUB" --force
PUB2=$(wpc "$R" post create --post_status=publish --post_title=HookPub2 --porcelain 2>/dev/null)
step "delete published permanently" 1 1 wpc "$R" post delete "$PUB2" --force
