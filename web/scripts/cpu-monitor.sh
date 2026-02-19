#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-4300}"
DURATION="${2:-30}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || ! [[ "$DURATION" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 [port=4300] [duration_seconds=30]" >&2
  exit 1
fi

total=0
count=0
max=0

echo "sampling TCP-established process CPU on :$PORT for ${DURATION}s ..."

for second in $(seq 1 "$DURATION"); do
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:ESTABLISHED 2>/dev/null | awk 'NR>1{print $2}' | sort -u | tr '\n' ' ')"
  if [[ -z "${pids// }" ]]; then
    cpu="0.00"
  else
    cpu="$(ps -p $pids -o %cpu= | awk '{s+=$1} END {printf "%.2f", s+0}')"
  fi

  printf "t=%02ds cpu_sum=%s%%\n" "$second" "$cpu"

  total="$(awk -v a="$total" -v b="$cpu" 'BEGIN {printf "%.4f", a+b}')"
  max="$(awk -v a="$max" -v b="$cpu" 'BEGIN {if (b > a) printf "%.2f", b; else printf "%.2f", a}')"
  count=$((count + 1))
  sleep 1
done

avg="$(awk -v total="$total" -v count="$count" 'BEGIN {if (count == 0) print "0.00"; else printf "%.2f", total / count}')"

echo "-----"
echo "avg_cpu_sum=${avg}%"
echo "max_cpu_sum=${max}%"
