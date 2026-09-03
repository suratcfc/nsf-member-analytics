#!/bin/bash

set -u

tableau_host="${NSF_TABLEAU_HOST:-nsfwnbi.nsf.or.th}"
repository="${NSF_GITHUB_REPOSITORY:-suratcfc/nsf-member-analytics}"
workflow="${NSF_GITHUB_WORKFLOW:-update-tableau-dashboard.yml}"
gh_bin="${NSF_GH_BIN:-/opt/homebrew/bin/gh}"
state_dir="${NSF_DASHBOARD_STATE_DIR:-${HOME}/Library/Application Support/nsf-dashboard-network-monitor}"
state_file="${state_dir}/state"
lock_dir="${state_dir}/lock"

mkdir -p "${state_dir}"
if ! mkdir "${lock_dir}" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "${lock_dir}" 2>/dev/null || true' EXIT

timestamp() {
  /bin/date '+%Y-%m-%d %H:%M:%S %Z'
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*"
}

boot_id="$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null || printf 'unknown-boot')"
previous_state="unknown"
previous_boot=""
if [[ -f "${state_file}" ]]; then
  IFS=$'\t' read -r previous_state previous_boot < "${state_file}" || true
fi

resolved_addresses="$(/usr/bin/dscacheutil -q host -a name "${tableau_host}" 2>/dev/null | /usr/bin/awk '/ip_address:/ { print $2 }')"
tableau_reachable=false
while IFS= read -r address; do
  if [[ "${address}" =~ ^10\. ]] ||
     [[ "${address}" =~ ^192\.168\. ]] ||
     [[ "${address}" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]]; then
    if /usr/bin/nc -z -G 5 "${address}" 443 >/dev/null 2>&1; then
      tableau_reachable=true
      break
    fi
  fi
done <<< "${resolved_addresses}"

if [[ "${tableau_reachable}" != true ]]; then
  printf 'unreachable\t%s\n' "${boot_id}" > "${state_file}"
  if [[ "${previous_state}" != "unreachable" ]] || [[ "${previous_boot}" != "${boot_id}" ]]; then
    log "Tableau network is unavailable; waiting for the NSF network or VPN"
  fi
  exit 0
fi

if [[ "${previous_state}" == "reachable" ]] && [[ "${previous_boot}" == "${boot_id}" ]]; then
  exit 0
fi

if [[ ! -x "${gh_bin}" ]]; then
  log "GitHub CLI was not found at ${gh_bin}"
  printf 'dispatch-failed\t%s\n' "${boot_id}" > "${state_file}"
  exit 1
fi

if ! "${gh_bin}" auth status --hostname github.com >/dev/null 2>&1; then
  log "GitHub CLI authentication is unavailable; run: gh auth login --hostname github.com --web"
  printf 'dispatch-failed\t%s\n' "${boot_id}" > "${state_file}"
  exit 1
fi

if "${gh_bin}" workflow run "${workflow}" --repo "${repository}" --ref main; then
  printf 'reachable\t%s\n' "${boot_id}" > "${state_file}"
  log "Tableau network recovered; dispatched ${workflow}"
  exit 0
fi

log "Tableau network recovered, but workflow dispatch failed; retrying on the next monitor interval"
printf 'dispatch-failed\t%s\n' "${boot_id}" > "${state_file}"
exit 1
