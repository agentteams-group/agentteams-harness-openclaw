#!/bin/sh
# Read only cgroup counters and filesystem capacity, never Agent state.
printf 'timestamp '; date -u '+%Y-%m-%dT%H:%M:%SZ'
for name in memory.current memory.peak memory.max memory.events memory.events.local memory.swap.current memory.swap.peak memory.swap.max memory.swap.events; do
  printf '\n%s\n' "$name"
  if [ -r "/sys/fs/cgroup/$name" ]; then cat "/sys/fs/cgroup/$name"; else printf 'unavailable\n'; fi
done
printf '\nguest_disk_kib\n'; df -Pk / | tail -1
printf '\nvm_memory_kib\n'; awk '/MemAvailable:|SwapFree:/{print}' /proc/meminfo
