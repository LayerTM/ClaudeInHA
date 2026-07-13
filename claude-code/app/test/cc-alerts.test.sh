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

# --- 4b. Persisted state now ALSO carries the full anomaly objects (.items) for
#         exactly the active set, so the prompt server can serve them on
#         /api/status without re-running detection. Same set as .active, just full
#         {key,critical,line} objects instead of bare keys. ---
state="${work}/alerts-state.json"
if [ -s "${state}" ]; then pass "state file persisted"; else fail "expected a persisted alerts-state.json"; fi
ni="$(jq '.items | length' "${state}" 2>/dev/null)"
na="$(jq '.active | length' "${state}" 2>/dev/null)"
if [ -n "${ni}" ] && [ "${ni}" = "${na}" ] && [ "${ni}" -ge 1 ] 2>/dev/null; then
    pass ".items length matches .active length (${ni})"
else
    fail ".items length must equal .active length (items=${ni} active=${na})"
fi
if jq -e 'all(.items[]; has("key") and has("critical") and has("line")) and (([.items[].key] | sort) == (.active | sort))' "${state}" >/dev/null 2>&1; then
    pass ".items are full {key,critical,line} objects whose keys match .active"
else
    fail ".items must be full {key,critical,line} objects consistent with .active (got: $(cat "${state}"))"
fi

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

# --- 7. Quiet hours: critical (offline) is still sent; non-critical (CO2) is
#        withheld, then fires once the quiet window ends. Guards the exact
#        critical/quiet-hours safety behaviour the alerts advertise. ---
rm -f "${work}/alerts-state.json"   # fresh dedupe memory for this scenario
printf '%s\n' '{"proactive_alerts": true, "alert_quiet_hours": "13:00-15:00", "alert_offline": true, "alert_offline_entities": ["sensor.nas", "device_tracker.ucg_fiber"], "alert_co2_above": 1400}' > "${work}/options.json"
run alerts-co2-offline.json "14:00"   # inside the quiet window
m="$(msg)"
case "${m}" in *"Offline: NAS"*) pass "quiet hours: critical offline still sent";;  *) fail "quiet: critical offline must still send (got: ${m})";; esac
case "${m}" in *"High CO2"*) fail "quiet: non-critical CO2 must be withheld (got: ${m})";;  *) pass "quiet hours: non-critical CO2 withheld";; esac
run alerts-co2-offline.json "16:00"   # after the quiet window, same state
m="$(msg)"
case "${m}" in *"High CO2: Bedroom CO2 (1850 ppm)"*) pass "withheld CO2 fires once quiet hours end";;  *) fail "CO2 must fire after quiet ends (got: ${m})";; esac
case "${m}" in *"Offline: NAS"*) fail "already-sent offline must not re-fire after quiet (got: ${m})";;  *) pass "critical offline deduped after quiet ends";; esac

# --- 8. Default gateway watch-list, out of the box. With alert_offline on but
#        NO alert_offline_entities set, the built-in default
#        (["device_tracker.ucg_fiber"]) must be injected and catch the gateway
#        going not_home. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true}' > "${work}/options.json"
run alerts-offline-default-gateway.json "14:00"
case "$(msg)" in *"Offline: UniFi Gateway"*) pass "default watch-list catches the gateway with no entities configured";; *) fail "default gateway watch missed the offline gateway (got: $(msg))";; esac

# --- 8b. Explicit empty list watches NOTHING. `[]` is truthy to jq, so the
#         default gateway is NOT re-injected (the `// empty` fallback is only for
#         an ABSENT list) — an explicit way to disable offline without flipping
#         alert_offline off. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": []}' > "${work}/options.json"
run alerts-offline-default-gateway.json "14:00"
if notified; then fail "explicit empty alert_offline_entities must watch nothing (got: $(msg))"; else pass "explicit empty alert_offline_entities watches nothing"; fi

# --- 9. CO2 exactly AT the threshold stays silent (the check is strict `>`, not
#        `>=`). Guards against a future `>=` regression. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_co2_above": 1400, "alert_offline": false}' > "${work}/options.json"
run alerts-co2-threshold.json "14:00"
if notified; then fail "CO2 exactly at the threshold must stay silent (strict >), got: $(msg)"; else pass "CO2 at the exact threshold does not alert"; fi

# --- 10. Offline guard: `not_home` only counts for device_trackers. A watched
#         NON-device_tracker that is not_home must NOT be flagged offline, while
#         the same non-tracker reporting unavailable still IS. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": ["sensor.foo", "sensor.bar"], "alert_co2_above": 0}' > "${work}/options.json"
run alerts-offline-non-tracker.json "14:00"
m="$(msg)"
case "${m}" in *"Foo Sensor"*) fail "not_home on a non-device_tracker must not flag offline (got: ${m})";; *) pass "non-device_tracker not_home is not treated as offline";; esac
case "${m}" in *"Offline: Bar Sensor"*) pass "non-device_tracker reporting unavailable still flags offline";; *) fail "unavailable non-tracker should still flag offline (got: ${m})";; esac

# --- 11. A WATCHED device_tracker that is home stays silent. Distinct from the
#         existing unwatched-exclusion case: this one IS on the watch list but is
#         healthy, so it must not alert. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": ["device_tracker.watched_router"], "alert_co2_above": 0}' > "${work}/options.json"
run alerts-tracker-home.json "14:00"
if notified; then fail "a watched device_tracker that is home must not alert (got: $(msg))"; else pass "a watched device_tracker at home stays silent"; fi

# --- 12. Offline clear-then-re-alert: a watched device_tracker goes not_home
#         (alerts), returns home (goes quiet), then drops again (re-alerts) —
#         the same clear/re-alert cycle the water-leak test proves. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": ["device_tracker.garage_pi"], "alert_co2_above": 0}' > "${work}/options.json"
run alerts-offline-down.json "14:00"
case "$(msg)" in *"Offline: Garage Pi"*) pass "offline alerts when the watched device drops";; *) fail "expected an offline alert when the device dropped (got: $(msg))";; esac
run alerts-offline-up.json "14:00"
if notified; then fail "offline must go quiet when the device returns home (got: $(msg))"; else pass "offline clears silently when the device returns home"; fi
run alerts-offline-down.json "14:00"
case "$(msg)" in *"Offline: Garage Pi"*) pass "offline re-alerts after the device returns and drops again";; *) fail "expected offline to re-alert after clearing (got: $(msg))";; esac

# --- 13. Room humidity alert (mirror of CO2). Below-low and above-high both
#         flag with the right line; the in-band sensor stays silent; an
#         unavailable humidity sensor is ignored. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_humidity_enabled": true, "alert_humidity_low": 25, "alert_humidity_high": 70, "alert_co2_above": 0, "alert_offline": false}' > "${work}/options.json"
run alerts-humidity.json "14:00"
if notified; then pass "notified on humidity cycle"; else fail "expected a humidity notification"; fi
m="$(msg)"
case "${m}" in *"Humidity out of range: Bathroom humidity (85%)"*) pass "reports humidity above high";; *) fail "missing humidity above-high line (got: ${m})";; esac
case "${m}" in *"Humidity out of range: Cellar humidity (18%)"*) pass "reports humidity below low";; *) fail "missing humidity below-low line (got: ${m})";; esac
case "${m}" in *"Living room humidity"*) fail "in-band humidity should not alert (got: ${m})";; *) pass "ignores in-band humidity";; esac
case "${m}" in *"Broken humidity"*) fail "unavailable humidity sensor should be ignored (got: ${m})";; *) pass "ignores unavailable humidity sensor";; esac

# --- 13b. Humidity disabled → silent even with out-of-band sensors. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_humidity_enabled": false, "alert_co2_above": 0, "alert_offline": false}' > "${work}/options.json"
run alerts-humidity.json "14:00"
if notified; then fail "humidity disabled must stay silent (got: $(msg))"; else pass "silent when humidity check is disabled"; fi

# --- 14. Temperature scoping via alert_temp_entities. With a room sensor listed,
#         a listed room temp out of band flags while an UNLISTED device temp (a
#         NAS CPU at 62°) stays silent — killing device-temp false positives. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_temp_enabled": true, "alert_temp_low": 5, "alert_temp_high": 45, "alert_temp_entities": ["sensor.room_temp"], "alert_co2_above": 0, "alert_offline": false}' > "${work}/options.json"
run alerts-temp-scope.json "14:00"
m="$(msg)"
case "${m}" in *"Temperature out of range: Living room temp (2°)"*) pass "scoped temp: listed room sensor flags out of band";; *) fail "scoped temp: listed room sensor should flag (got: ${m})";; esac
case "${m}" in *"NAS CPU temp"*) fail "scoped temp: unlisted device temp must stay silent (got: ${m})";; *) pass "scoped temp: unlisted device temp stays silent";; esac

# --- 14b. Empty alert_temp_entities = legacy behaviour: BOTH the room sensor and
#          the device temp flag (no scoping). ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_temp_enabled": true, "alert_temp_low": 5, "alert_temp_high": 45, "alert_temp_entities": [], "alert_co2_above": 0, "alert_offline": false}' > "${work}/options.json"
run alerts-temp-scope.json "14:00"
m="$(msg)"
case "${m}" in *"Temperature out of range: Living room temp (2°)"*) pass "empty list (legacy): room sensor flags";; *) fail "empty list: room sensor should flag (got: ${m})";; esac
case "${m}" in *"Temperature out of range: NAS CPU temp (62°)"*) pass "empty list (legacy): device temp also flags";; *) fail "empty list: device temp should also flag (got: ${m})";; esac

echo
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all cc-alerts checks passed"
    exit 0
else
    echo "FAIL: ${fails} cc-alerts check(s) failed"
    exit 1
fi
