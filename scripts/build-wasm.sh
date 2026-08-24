#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need rustc
need cargo
need wasm-bindgen

if ! rustup target list --installed | grep -qx "wasm32-unknown-unknown"; then
  echo "rustup target wasm32-unknown-unknown is not installed" >&2
  exit 1
fi

cli_ver="$(wasm-bindgen -V | awk '{print $NF}')"
lock_ver="$(awk '$0 == "name = \"wasm-bindgen\"" {p=1} p && /version =/ {gsub(/"/, "", $3); print $3; exit}' Cargo.lock)"
if [[ -z "${lock_ver}" || "${cli_ver}" != "${lock_ver}" ]]; then
  echo "wasm-bindgen CLI ${cli_ver} != Cargo.lock ${lock_ver}" >&2
  exit 1
fi

wasm_cc_hint() {
  echo "set CC_wasm32_unknown_unknown to a wasm-capable clang" >&2
  echo "  macOS: brew install llvm && CC_wasm32_unknown_unknown=\$(brew --prefix llvm)/bin/clang" >&2
  echo "  CI:    CC_wasm32_unknown_unknown=clang" >&2
}

# secp256k1-sys: clang must accept --target=wasm32-unknown-unknown (not Apple clang).
if [[ -z "${CC_wasm32_unknown_unknown:-}" ]]; then
  wasm_cc_hint
  exit 1
fi

cc_wasm="${CC_wasm32_unknown_unknown}"
cc_ver="$("${cc_wasm}" --version 2>/dev/null | head -n 1 || true)"
if echo "${cc_ver}" | grep -q "Apple clang"; then
  echo "CC_wasm32_unknown_unknown is Apple clang (no wasm backend): ${cc_wasm}" >&2
  wasm_cc_hint
  exit 1
fi
if ! "${cc_wasm}" --print-targets 2>/dev/null | grep -q wasm32; then
  echo "CC_wasm32_unknown_unknown does not list wasm32 in --print-targets: ${cc_wasm}" >&2
  echo "${cc_ver}" >&2
  wasm_cc_hint
  exit 1
fi

export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-llvm-ar}"
export CFLAGS_wasm32_unknown_unknown="${CFLAGS_wasm32_unknown_unknown:---target=wasm32-unknown-unknown -Wno-implicit-function-declaration}"

cargo build --target wasm32-unknown-unknown --release -p nostr-crypto-wasm

gen="${root}/src/wasm/generated"
rm -rf "${gen}"
mkdir -p "${gen}"
wasm-bindgen \
  --target bundler \
  --out-dir "${gen}" \
  "${root}/target/wasm32-unknown-unknown/release/nostr_crypto_wasm.wasm"

wasm_bg="${gen}/nostr_crypto_wasm_bg.wasm"
test -f "${wasm_bg}" || { echo "wasm-bindgen did not emit ${wasm_bg}" >&2; exit 1; }
cp "${wasm_bg}" "${root}/src/wasm/nostr_crypto_wasm_bg.wasm"
