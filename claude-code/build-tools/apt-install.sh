#!/bin/bash
# apt-install.sh PACKAGE...  (build time only, bind-mounted, never in the image)
# Installs from the Debian snapshot named by DEBIAN_SNAPSHOT, so the same tree
# installs the same package versions on any day, and leaves no build-time state
# (indexes, logs, caches, a generated machine id) behind in the layer.
set -euo pipefail
# APT_INSTALL_ROOT lets the self-test point the clean-up at a scratch tree.
root="${APT_INSTALL_ROOT:-}"
: "${DEBIAN_SNAPSHOT:?DEBIAN_SNAPSHOT is not set}"
# A snapshot's Release files carry Valid-Until; once it passes, apt drops the
# suite with an error and still exits 0, so expiry is switched off for the pinned
# snapshot and any other error fails the build.
opts=(-o "APT::Snapshot=${DEBIAN_SNAPSHOT}" -o Acquire::Check-Valid-Until=false)
apt-get "${opts[@]}" update --error-on=any
apt-get "${opts[@]}" install -y --no-install-recommends "$@"
rm -rf "${root}"/var/lib/apt/lists/* "${root}"/var/cache/apt/*.bin \
       "${root}"/var/log/apt/* "${root}"/var/log/dpkg.log "${root}"/var/log/alternatives.log \
       "${root}"/var/cache/ldconfig/aux-cache "${root}"/var/cache/debconf/*-old "${root}"/var/lib/dpkg/*-old
# dbus generates a random machine id on install; a container gets none baked in.
rm -f "${root}"/etc/machine-id "${root}"/var/lib/dbus/machine-id
