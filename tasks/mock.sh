#!/bin/sh
set -eu
output=${RUN_OUTPUT:-/out}
case "$1" in
  build)
    if [ "$2" = timeout ]; then
      echo 'Waiting for timeout'
      sleep 60
    fi
    if [ "$2" = verbose ]; then
      awk 'BEGIN { for (i=0; i<50000; i++) print "long diagnostic line for streaming verification" }'
      echo 'Last diagnostic line'
    fi
    if [ "$2" = build-failure ]; then
      echo 'Injected build failure'
      exit 7
    fi
    printf 'mock build\n' > "$output/artifact.txt"
    ;;
  test)
    test -s "$output/artifact.txt"
    if [ "$2" != missing-report ]; then
      printf '{"checked":1,"passed":1,"failed":0}\n' > "$output/test-report.json"
    fi
    ;;
  archive)
    printf 'archive step completed\n' > "$output/archive.txt"
    ;;
  *) exit 64 ;;
esac
