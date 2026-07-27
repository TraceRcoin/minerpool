#!/bin/bash
# STAGING test miners: 3 cpuminer instances authing via the portal as tracerfx123.rigNN.
# Each rig uses its portal-minted worker password from the creds file.
CREDS=/etc/tfx-staging/worker_creds.txt
PIDS=""
for W in rig01 rig02 rig03; do
  PW=$(grep "$W|" "$CREDS" | cut -d"|" -f2)
  /opt/cpuminer/minerd -a scrypt -o stratum+tcp://127.0.0.1:3032 -u "tracerfx123.$W" -p "$PW" -t 1 \
     >>/tmp/mine_$W.log 2>&1 &
  PIDS="$PIDS $!"
done
trap "kill $PIDS 2>/dev/null" TERM INT
wait
