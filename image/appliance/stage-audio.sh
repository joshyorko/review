#!/usr/bin/env bash
# Copy only the PulseAudio and ALSA runtime closure into an FSDK rootfs.
set -euo pipefail

dest="${1:?usage: stage-audio <destdir> <library>...}"
shift
(($# > 0)) || { echo 'stage-audio: at least one library is required' >&2; exit 1; }

case "$(uname -m)" in
  x86_64) triplet=x86_64-linux-gnu ;;
  aarch64) triplet=aarch64-linux-gnu ;;
  *) echo "stage-audio: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

target_libdir="${dest}/usr/lib/${triplet}"
base_provided=(
  ld-linux-x86-64.so.2
  ld-linux-aarch64.so.1
  libc.so.6
  libdl.so.2
  libm.so.6
  libpthread.so.0
  libresolv.so.2
  librt.so.1
  libgcc_s.so.1
  libstdc++.so.6
  libffi.so.8
)

is_base_provided() {
  local candidate="$1" provided
  for provided in "${base_provided[@]}"; do
    [[ "$candidate" == "$provided" ]] && return 0
  done
  return 1
}

stage_libraries() {
  local binary="$1" soname arrow resolved _address
  while read -r soname arrow resolved _address; do
    [[ "$soname" == linux-vdso.so.* ]] && continue
    if [[ "$arrow" == '=>' ]]; then
      [[ "$resolved" == /* ]] || {
        echo "stage-audio: unresolved dependency of ${binary}: ${soname}" >&2
        return 1
      }
    elif [[ "$soname" == /* ]]; then
      resolved="$soname"
      soname="$(basename "$soname")"
    else
      continue
    fi
    is_base_provided "$soname" && continue
    [[ -e "$resolved" ]] || {
      echo "stage-audio: missing resolved dependency of ${binary}: ${resolved}" >&2
      return 1
    }
    if [[ ! -e "${target_libdir}/${soname}" ]]; then
      install -D -m 0755 "$resolved" "${target_libdir}/${soname}"
    fi
  done < <(ldd "$binary" 2>/dev/null)
}

install -d -m 0755 "$target_libdir"
for library in "$@"; do
  [[ -f "$library" ]] || {
    echo "stage-audio: missing library: ${library}" >&2
    exit 1
  }
  resolved="$(readlink -f "$library")"
  [[ -f "$resolved" ]] || {
    echo "stage-audio: library target is missing: ${resolved}" >&2
    exit 1
  }
  install -D -m 0755 "$resolved" "${target_libdir}/$(basename "$library")"
  stage_libraries "$resolved"
done

# ALSA's default device needs its small configuration tree even when the
# hardware itself is projected at runtime. No plugin or host configuration is
# copied beyond the package-owned /usr/share/alsa tree.
[[ -d /usr/share/alsa ]] || {
  echo 'stage-audio: /usr/share/alsa is missing from the audio builder' >&2
  exit 1
}
install -d -m 0755 "${dest}/usr/share/alsa"
cp -a /usr/share/alsa/. "${dest}/usr/share/alsa/"

for required in libpulse-simple.so.0 libasound.so.2; do
  [[ -e "${target_libdir}/${required}" ]] || {
    echo "stage-audio: required library was not staged: ${required}" >&2
    exit 1
  }
done
