#!/bin/sh
# Container HEALTHCHECK. api/health.php is gated by <data dir>/probe_key.txt, which
# the operator writes (the app never creates it). With a key: run the full probe
# and require working SQLite in a writable data dir. Without one: health.php still
# answers its 404 JSON, which proves Apache is up and PHP is executing.
# The key never leaves the container: it goes to curl on stdin (-K -), not argv,
# percent-encoded byte by byte so any key is URL-safe; health.php is not logged.
base=http://127.0.0.1:8080
key=$(tr -d '[:space:]' 2>/dev/null < /var/www/beam/beamtm_data/probe_key.txt)
if [ -n "$key" ]; then
  enc=$(printf %s "$key" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g')
  body=$(printf 'url = "%s/api/health.php?k=%s"\n' "$base" "$enc" \
    | curl -fsS -m 4 -H 'X-Forwarded-Proto: https' -K -) || exit 1
  case "$body" in *'"sqlite_works":true'*) ;; *) exit 1 ;; esac
  case "$body" in *'"data_dir_writable":true'*) exit 0 ;; *) exit 1 ;; esac
fi
curl -sS -m 4 -H 'X-Forwarded-Proto: https' "$base/api/health.php" | grep -q '^{"error"' || exit 1
