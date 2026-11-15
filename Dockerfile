# beam — PHP + SQLite, served by Apache (mod_php) as www-data on :8080, behind a
# TLS-terminating proxy. The base image already ships pdo_sqlite, sqlite3 and curl.
#
# Rebuild monthly and on every PHP security release. To bump the pin:
#   docker pull php:8.3-apache
#   docker image inspect php:8.3-apache --format '{{index .RepoDigests 0}}'   # php@sha256:...
#   docker run --rm php:8.3-apache php -r 'echo PHP_VERSION;'                 # 8.3.x
# then set FROM to php:<8.3.x>-apache@sha256:<digest>, keep CI's setup-php on the
# same minor, and run CI.
FROM php:8.3.36-apache@sha256:a800bbd2c0aa322702259ed475556b2cbc311076a8d3c4bba9bfe96838745472

RUN a2enmod rewrite headers \
 && a2disconf other-vhosts-access-log \
 && cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && echo 'Listen 8080' > /etc/apache2/ports.conf

COPY docker/beam.conf /etc/apache2/sites-available/000-default.conf
COPY docker/php-beam.ini "$PHP_INI_DIR/conf.d/zz-beam.ini"
COPY --chmod=755 docker/healthcheck.sh /usr/local/bin/beam-healthcheck

# Web files are the docroot (root-owned, read-only to www-data); the data dir sits
# one level above it, where api/_lib.php expects it (dirname(api, 2)/beamtm_data).
# See .dockerignore for what is left out; docker/ is only build input, removed below.
COPY . /var/www/beam/public

# The repo's .htaccess starts with a cPanel handler block (AddHandler
# application/x-httpd-ea-php81) that would make stock Apache serve .php as source.
# Strip it here; the repo copy stays as-is for the cPanel host.
RUN sed -i '/# php -- BEGIN cPanel-generated handler/,/# php -- END cPanel-generated handler/d' \
      /var/www/beam/public/.htaccess \
 && ! grep -q 'x-httpd-ea-php' /var/www/beam/public/.htaccess \
 && rm -rf /var/www/beam/public/docker \
 && mkdir -p /var/www/beam/beamtm_data \
 && chown www-data:www-data /var/www/beam/beamtm_data \
 && chmod 700 /var/www/beam/beamtm_data

# Apache's pid/lock files go to /tmp (a tmpfs under read_only), so nothing else
# needs to be writable at runtime; logs are already symlinked to stdout/stderr.
ENV APACHE_RUN_DIR=/tmp/apache2/run \
    APACHE_LOCK_DIR=/tmp/apache2/lock \
    APACHE_PID_FILE=/tmp/apache2/run/apache2.pid

# mcp.php calls agent.php over loopback inside the container.
ENV BEAM_AGENT_URL=http://127.0.0.1:8080/api/agent.php

VOLUME /var/www/beam/beamtm_data

USER www-data
EXPOSE 8080

# Full probe when <data dir>/probe_key.txt exists, else "PHP is executing" (see script).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/beam-healthcheck"]
