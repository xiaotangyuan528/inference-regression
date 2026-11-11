#!/bin/sh
set -eu
output=${RUN_OUTPUT:?RUN_OUTPUT required}
case "$1" in
 build)
   if [ "$2" = timeout ]; then sleep 60; fi
   if [ "$2" = verbose ]; then
     awk 'BEGIN { for (i=0;i<50000;i++) print "diagnostic output for bounded log verification" }'
   fi
   if [ "$2" = build-failure ]; then echo 'injected build failure'; exit 7; fi
   echo 'mock artifact' > "$output/artifact.txt"
   ;;
 test)
   test -s "$output/artifact.txt"
   case "$2" in
     missing-report) ;;
     failed-test) echo '{"checked":1,"passed":0,"failed":1}' > "$output/test-report.json"; exit 1 ;;
     partial-skips) echo '{"checked":10,"passed":8,"failed":0,"skipped":2}' > "$output/test-report.json" ;;
     all-skipped) echo '{"checked":2,"passed":0,"failed":0,"skipped":2}' > "$output/test-report.json" ;;
     *) echo '{"checked":1,"passed":1,"failed":0}' > "$output/test-report.json" ;;
   esac
   ;;
 archive) echo 'archive complete' > "$output/archive.txt" ;;
 *) echo 'unknown task' >&2; exit 64 ;;
esac
