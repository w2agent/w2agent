#!/bin/bash
# Shared helpers for run.sh and the checks-*.sh files (sourced, not executed).
# Needs RUN_ID, WORK and E2E_DIR from run.sh.

PREFIX="w2agent-e2e-$RUN_ID"
NET="$PREFIX-net"
CONTAINERS=()
FAILS=0
PASSES=0

chk() {
  if eval "$2"; then echo "ok   $1"; PASSES=$((PASSES + 1)); else echo "FAIL $1"; FAILS=$((FAILS + 1)); fi
}

pre() {
  if eval "$2"; then echo "pre  $1"; else echo "PRECONDITION-FAILED $1"; FAILS=$((FAILS + 1)); fi
}

free_port() {
  local p=$1
  while (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; do p=$((p + 1)); done
  echo "$p"
}

site_dir() { echo "$WORK/site-$1"; }

# WordPress root inside the container for a scenario (sub* installs live in /blog)
wp_path() {
  case "$1" in sub*) echo /var/www/html/blog ;; *) echo /var/www/html ;; esac
}

# Host path of the WordPress root for a scenario
wp_host_dir() {
  case "$1" in sub*) echo "$(site_dir "$1")/blog" ;; *) site_dir "$1" ;; esac
}

wpc() { # scenario, wp-cli args...
  local name=$1
  shift
  docker run --rm -i --network "$NET" --volumes-from "$PREFIX-wp-$name" --user 33:33 \
    -e HOME=/tmp \
    -e WORDPRESS_DB_HOST="$PREFIX-db-$name" -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp -e WORDPRESS_DB_NAME=wp \
    wordpress:cli-php8.3 wp --path="$(wp_path "$name")" "$@"
}

# up <root*|sub*|ms*> <port>: starts MariaDB + WordPress on the e2e network and installs WordPress
up() {
  local name=$1 port=$2
  local kind=root
  case "$name" in sub*) kind=sub ;; ms*) kind=ms ;; esac
  local db="$PREFIX-db-$name" wp="$PREFIX-wp-$name" site
  site=$(site_dir "$name")
  mkdir -p "$site"
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  CONTAINERS+=("$db")
  docker run -d --name "$db" --network "$NET" \
    -e MARIADB_ROOT_PASSWORD=root -e MARIADB_DATABASE=wp -e MARIADB_USER=wp -e MARIADB_PASSWORD=wp \
    mariadb:11 >/dev/null
  CONTAINERS+=("$wp")
  docker run -d --name "$wp" --network "$NET" -p "127.0.0.1:$port:80" -w "$(wp_path "$name")" \
    -v "$site:/var/www/html" \
    -e WORDPRESS_DB_HOST="$db" -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp -e WORDPRESS_DB_NAME=wp \
    -e WORDPRESS_DEBUG=1 -e "WORDPRESS_CONFIG_EXTRA=define('WP_DEBUG_LOG', true); define('WP_DEBUG_DISPLAY', false);" \
    wordpress:php8.3-apache >/dev/null
  local wpdir ready=0 i
  wpdir=$(wp_host_dir "$name")
  for i in $(seq 1 90); do
    if docker exec "$db" mariadb -uwp -pwp -e "select 1" wp >/dev/null 2>&1 && [ -f "$wpdir/wp-config.php" ]; then
      ready=1
      break
    fi
    sleep 2
  done
  [ "$ready" = 1 ] || { echo "FAIL $name did not become ready"; return 1; }
  # the host user writes plugin files into the bind mount; containers run as www-data
  docker exec "$wp" chmod -R a+rwX /var/www/html
  [ "$kind" = sub ] && cp "$E2E_DIR/htaccess-blog" "$wpdir/.htaccess"
  mkdir -p "$wpdir/wp-content/mu-plugins"
  cp "$E2E_DIR/mu/w2a-e2e.php" "$E2E_DIR/mu/w2a-members.php" "$wpdir/wp-content/mu-plugins/"
  local url="http://localhost:$port"
  [ "$kind" = sub ] && url="http://localhost:$port/blog"
  if [ "$kind" = ms ]; then
    wpc "$name" core multisite-install --subdomains --url=http://w2a.test --title=W2A --admin_user=admin --admin_password=admin --admin_email=admin@example.com --skip-email >/dev/null
  else
    wpc "$name" core install --url="$url" --title=W2A --admin_user=admin --admin_password=admin --admin_email=admin@example.com --skip-email >/dev/null
  fi
  wpc "$name" rewrite structure '/%postname%/' >/dev/null
  echo "up $name at $url"
}

cleanup() {
  local c rc=$?
  trap - EXIT
  for c in ${CONTAINERS[@]+"${CONTAINERS[@]}"}; do
    docker rm -f -v "$c" >/dev/null 2>&1
  done
  docker network rm "$NET" >/dev/null 2>&1
  if [ -d "$WORK" ]; then
    # site files are owned by the container user: clear them from inside, then drop the empty dir
    docker run --rm --entrypoint sh -v "$WORK:/w" wordpress:php8.3-apache -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1
    rmdir "$WORK" 2>/dev/null
  fi
  exit "$rc"
}
