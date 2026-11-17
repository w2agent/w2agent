#!/bin/bash
# Sourced by run.sh. Usage: escape_checks <port> <plugin slug> <transient name>
# GEN-7 class: a post title or excerpt with Markdown syntax, a newline and a line starting with "## "
# must stay inside one llms.txt list item as escaped text.
escape_checks() {
  local port=$1 plugin=$2 transient=$3 B=http://localhost:$1 id body line
  local title
  title=$(printf 'Evil ]x[ ](javascript:alert(1))\n## Injected heading\n* _em_ <b>&')
  wpc "$R" plugin deactivate --all >/dev/null 2>&1
  wpc "$R" plugin activate "$plugin" >/dev/null 2>&1
  id=$(wpc "$R" post create --post_status=publish --post_title="$title" \
    --post_excerpt="$(printf 'Ex [x](javascript:alert(2))\n# Heading <i>')" --porcelain 2>/dev/null)
  pre "$plugin: escape probe post created" '[ -n "$id" ]'
  pre "$plugin: WordPress kept the newline and brackets in the title" \
    '[ "$(wpc "$R" post get "$id" --field=post_title 2>/dev/null | wc -l | tr -d " ")" -ge 3 ] && wpc "$R" post get "$id" --field=post_title 2>/dev/null | grep -qF "](javascript:alert(1))"'
  wpc "$R" transient delete "$transient" >/dev/null 2>&1
  body=$(curl -s "$B/llms.txt")
  line=$(grep -F "Evil" <<<"$body")
  chk "GEN-7 $plugin: probe item is one list line" '[ "$(grep -c "Evil" <<<"$body")" = 1 ] && [ "${line#- \[}" != "$line" ]'
  chk "GEN-7 $plugin: link text is the escaped title" \
    'grep -qF -- "- [Evil \\]x\\[ \\](javascript:alert(1)) ## Injected heading \\* \\_em\\_ \\<b\\>\\&](" <<<"$line"'
  chk "GEN-7 $plugin: no injected heading" '! grep -q "^## Injected" <<<"$body" && ! grep -q "^# Heading" <<<"$body"'
  chk "GEN-7 $plugin: excerpt brackets escaped, newline folded" 'grep -qF -- "Ex \\[x\\](javascript:alert(2)) # Heading" <<<"$line"'
  chk "GEN-7 $plugin: no unescaped javascript link" '! grep -qE "(^|[^\\\\])\]\(javascript:" <<<"$body"'
  wpc "$R" post delete "$id" --force >/dev/null 2>&1
  wpc "$R" transient delete "$transient" >/dev/null 2>&1
  wpc "$R" plugin activate w2agent w2agent-site >/dev/null 2>&1
}
