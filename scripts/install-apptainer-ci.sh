#!/usr/bin/env bash
set -euo pipefail

sudo add-apt-repository -y ppa:apptainer/ppa

arch="$(dpkg --print-architecture)"
case "$arch" in
  amd64 | arm64) ;;
  *) echo "unsupported Apptainer architecture: $arch" >&2; exit 1 ;;
esac

mapfile -t ppa_sources < <(
  grep -RlF 'https://ppa.launchpadcontent.net/apptainer/ppa/ubuntu/' /etc/apt/sources.list.d
)
test "${#ppa_sources[@]}" -eq 1 || {
  echo "expected exactly one Apptainer PPA source, found ${#ppa_sources[@]}" >&2
  exit 1
}

# Ubuntu 26.04's amd64v3 package index does not contain the PPA package. Ask
# this one PPA source for the matching dpkg architecture so its signed index is
# used without changing apt's system-wide architecture preference.
sudo sed -i \
  -e '/^Architectures:/d' \
  -e "/^Components:/a Architectures: $arch" \
  "${ppa_sources[0]}"
sudo apt-get update -qq

policy="$(apt-cache policy "apptainer:$arch")"
printf '%s\n' "$policy"
grep -Fq 'ppa.launchpadcontent.net/apptainer/ppa/ubuntu' <<<"$policy" || {
  echo "Apptainer PPA is not an install candidate for $arch" >&2
  exit 1
}

sudo apt-get install -y "apptainer:$arch"

profile=/etc/apparmor.d/apptainer
test -r "$profile" || { echo "missing upstream AppArmor profile: $profile" >&2; exit 1; }
grep -Fq '/usr/bin/apptainer' "$profile" || {
  echo "upstream AppArmor profile does not authorize the Apptainer binary" >&2
  exit 1
}
grep -Fq '/usr/libexec/apptainer/bin/starter' "$profile" || {
  echo "upstream AppArmor profile does not match the installed starter" >&2
  exit 1
}
