#!/bin/bash
# Status line: show quota % and burn rate from quota-status.json
# Written by cache-fix proxy's cache-telemetry extension on every API call.

input=$(cat)

QS="$HOME/.claude/quota-status.json"

if [ -f "$QS" ]; then
  result=$(python3 -c "
import sys, json, os
from datetime import datetime, timezone, timedelta

qs = json.load(open(os.path.expanduser('~/.claude/quota-status.json')))

q5h = qs.get('five_hour', {}).get('pct', 0)
q7d = qs.get('seven_day', {}).get('pct', 0)
q5h_reset = qs.get('five_hour', {}).get('resets_at', 0)
q7d_reset = qs.get('seven_day', {}).get('resets_at', 0)
status = qs.get('status', '')
overage = qs.get('overage_status', '')
ts = qs.get('timestamp', '')

now = datetime.fromisoformat(ts.replace('Z', '+00:00')) if ts else datetime.now(timezone.utc)

# Q5h burn rate
rate5 = ''
if q5h_reset > 0 and q5h > 0:
    window_start = datetime.fromtimestamp(q5h_reset, tz=timezone.utc) - timedelta(hours=5)
    elapsed_min = (now - window_start).total_seconds() / 60
    if elapsed_min > 1:
        rate5 = '{:+.1f}'.format(q5h / elapsed_min)

# Q7d burn rate
rate7 = ''
if q7d_reset > 0 and q7d > 0:
    window_start_7d = datetime.fromtimestamp(q7d_reset, tz=timezone.utc) - timedelta(days=7)
    elapsed_hr = (now - window_start_7d).total_seconds() / 3600
    if elapsed_hr > 0.1:
        rate7 = '{:+.1f}'.format(q7d / elapsed_hr)

label = 'Q5h: {}%'.format(q5h)
if rate5:
    label += ' ({}%/m)'.format(rate5)
label += ' | Q7d: {}%'.format(q7d)
if rate7:
    label += ' ({}%/hr)'.format(rate7)
if overage == 'active':
    label += ' | OVERAGE'

# TTL and cache stats
ttl = qs.get('cache', {}).get('ttl_tier', '')
hit = qs.get('cache', {}).get('hit_rate', '')
if ttl:
    if ttl == '5m':
        label += ' | \033[31mTTL:5m\033[0m'
    else:
        label += ' | TTL:' + ttl
if hit and hit != 'N/A':
    label += ' ' + hit + '%'

peak = qs.get('peak_hour', False)
if peak:
    label += ' | \033[33mPEAK\033[0m'

print(label)
" 2>/dev/null)

  [ -n "$result" ] && echo "$result"
fi
