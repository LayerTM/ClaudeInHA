#!/usr/bin/env bash
# Tests for the deterministic proactive-alerts loop (rootfs/usr/local/bin/cc-alerts).
#
# Drives `cc-alerts --once` against JSON state fixtures with an isolated data dir
# and a stub notifier, and asserts:
#   1. anomalies (low battery + water leak + door open at night) are all reported;
#   2. running again on the SAME state notifies nothing (dedupe works);
#   3. when the leak clears and then reappears, it re-alerts.
#
# Requires: bash + jq (same tools the script uses). No live Home Assistant needed.
#
# Run:  bash claude-code/app/test/cc-alerts.test.sh
#   or, from claude-code/app:  npm run test:alerts   (see package.json)
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"           # claude-code/
script="${repo}/rootfs/usr/local/bin/cc-alerts"
fixtures="${here}/fixtures"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }
[ -x "${script}" ] || { echo "FAIL: ${script} is not executable"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# Isolated /data with the master switch on.
printf '{"proactive_alerts": true}\n' > "${work}/options.json"

# Stub notifier: append each call's message to $NOTIFY_OUT so we can inspect it.
notify_out="${work}/notify.txt"
stub="${work}/ha-notify-stub"
cat > "${stub}" <<'STUB'
#!/usr/bin/env bash
printf '%s\n---\n' "$1" >> "${NOTIFY_OUT}"
STUB
chmod +x "${stub}"

fails=0
pass() { printf '  ok  - %s\n' "$1"; }
fail() { printf '  NOT ok - %s\n' "$1"; fails=$((fails + 1)); }

# Run one cycle. $1 = fixture file, $2 = "now" HH:MM. Result message → $notify_out
# (cleared first, so absence of the file means "no notification was sent").
run() {
    rm -f "${notify_out}"
    CC_ALERTS_DATA_DIR="${work}" \
    CC_ALERTS_STATES_FILE="${fixtures}/$1" \
    CC_ALERTS_NOW="$2" \
    CC_ALERTS_NOTIFY_CMD="${stub}" \
    NOTIFY_OUT="${notify_out}" \
        "${script}" --once
}
notified() { [ -s "${notify_out}" ]; }
msg() { cat "${notify_out}" 2>/dev/null; }

echo "cc-alerts --once tests"

# --- 1. First cycle: all three anomalies fire (23:30 is inside the night window) ---
run alerts-anomalies.json "23:30"
if notified; then pass "notified on first anomaly cycle"; else fail "expected a notification on first cycle"; fi
m="$(msg)"
case "${m}" in *"Low battery"*) pass "reports low battery";;      *) fail "missing low-battery line";; esac
case "${m}" in *"WATER LEAK"*)  pass "reports water leak";;        *) fail "missing water-leak line";; esac
case "${m}" in *"Open at night"*) pass "reports door open at night";; *) fail "missing open-at-night line";; esac
case "${m}" in *"Phone battery"*) pass "uses friendly_name";;     *) fail "missing friendly_name";; esac
# Robustness: unavailable/unknown and the healthy 80% battery must NOT alert.
case "${m}" in *"Kitchen sensor"*) fail "healthy 80% battery should not alert";; *) pass "ignores healthy battery";; esac
case "${m}" in *"Garden leak"*) fail "unavailable leak sensor should be ignored";; *) pass "ignores unavailable entity";; esac

# --- 2. Same state again: dedupe → nothing new ---
run alerts-anomalies.json "23:30"
if notified; then fail "dedupe: expected NO notification on unchanged state (got: $(msg))"; else pass "dedupe: no re-notify on unchanged state"; fi

# --- 3a. Leak clears (still door + battery active) → nothing new ---
run alerts-leak-cleared.json "23:30"
if notified; then fail "cleared leak should not notify (got: $(msg))"; else pass "cleared leak drops silently"; fi

# --- 3b. Leak reappears → re-alerts ONLY the leak (door/battery still active) ---
run alerts-anomalies.json "23:30"
if notified; then pass "leak re-alerts after clearing"; else fail "expected leak to re-alert after clearing"; fi
m="$(msg)"
case "${m}" in *"WATER LEAK"*) pass "re-alert contains the leak";;       *) fail "re-alert missing the leak";; esac
case "${m}" in *"Low battery"*) fail "battery should still be deduped on re-alert";; *) pass "battery stays deduped on re-alert";; esac
case "${m}" in *"Open at night"*) fail "door should still be deduped on re-alert";;  *) pass "door stays deduped on re-alert";; esac

# --- 4. CO2 + offline/network checks ---
# Reconfigure: enable the high-CO2 check (>1400 ppm) and watch two entities for
# going offline (the default internet gateway plus a NAS sensor). Fresh state so
# the diff for this block is easy to reason about.
rm -f "${work}/alerts-state.json"
cat > "${work}/options.json" <<'OPT'
{
  "proactive_alerts": true,
  "alert_co2_above": 1400,
  "alert_offline": true,
  "alert_offline_entities": ["device_tracker.ucg_fiber", "sensor.nas"]
}
OPT

run alerts-co2-offline.json "14:00"
if notified; then pass "notified on co2/offline cycle"; else fail "expected a co2/offline notification"; fi
m="$(msg)"
case "${m}" in *"High CO2: Bedroom CO2 (1850 ppm)"*) pass "reports high CO2 above threshold";; *) fail "missing high-CO2 line";; esac
case "${m}" in *"Office CO2"*) fail "CO2 below threshold should not alert";;             *) pass "ignores CO2 below threshold";; esac
case "${m}" in *"Offline: UniFi Gateway"*) pass "reports device_tracker not_home as offline";; *) fail "missing offline gateway (not_home) line";; esac
case "${m}" in *"Offline: NAS"*) pass "reports unavailable watched entity as offline";; *) fail "missing offline NAS (unavailable) line";; esac
case "${m}" in *"My Phone"*) fail "a device_tracker that is home should not alert";;     *) pass "ignores device_tracker that is home";; esac
case "${m}" in *"Garden leak"*) fail "unavailable entity not on the watch list should not alert";; *) pass "ignores unavailable entity not on the watch list";; esac

# --- 5. Dedupe: same CO2/offline state again → nothing new ---
run alerts-co2-offline.json "14:00"
if notified; then fail "dedupe: expected NO co2/offline re-notify on unchanged state (got: $(msg))"; else pass "dedupe: co2/offline stay quiet while still active"; fi

# --- 6. Options off → silent even with a triggering fixture ---
rm -f "${work}/alerts-state.json"
cat > "${work}/options.json" <<'OPT'
{
  "proactive_alerts": true,
  "alert_co2_above": 0,
  "alert_offline": false
}
OPT
run alerts-co2-offline.json "14:00"
if notified; then fail "co2 off (0) + offline off should be silent (got: $(msg))"; else pass "silent when co2/offline checks are disabled"; fi

echo
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all cc-alerts checks passed"
    exit 0
else
    echo "FAIL: ${fails} cc-alerts check(s) failed"
    exit 1
fi
