#!/usr/bin/env bash
# Legal Evidence Manager - start script. Linux: run ./start.sh; macOS: double-click
# "Start Legal Evidence Manager.command", which runs this file.
#  1. Uses Node.js if a recent version is installed; otherwise downloads a private copy
#     into this folder (.runtime/node), verified against the nodejs.org checksums.
#  2. Installs the application libraries only when missing or outdated.
#  3. Checks prerequisites and opens the app in the browser (or reopens a running instance).
set -u
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
LOCAL_NODE="$ROOT/.runtime/node"

echo "=================================================="
echo "  Legal Evidence Manager (proof of concept)"
echo "=================================================="
echo

fail() {
  echo
  echo "The application could not be started. Read the messages above."
  if [ -t 0 ]; then read -r -p "Press Enter to close..." _; fi
  exit 1
}

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)" 2>/dev/null
}

get_node() {
  local os arch base line expected file tmp
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "Unsupported system: $(uname -s)"; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported processor: $(uname -m)"; return 1 ;; esac
  base="https://nodejs.org/dist/latest-v24.x"
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep -E "node-v[0-9.]+-$os-$arch\.tar\.gz$" | head -n 1)" || return 1
  [ -n "$line" ] || { echo "No Node.js download found for $os-$arch"; return 1; }
  expected="${line%% *}"
  file="${line##* }"
  mkdir -p "$ROOT/.runtime"
  echo "      Downloading $file from nodejs.org ..."
  curl -fsSL "$base/$file" -o "$ROOT/.runtime/$file" || return 1
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$ROOT/.runtime/$file" | cut -d' ' -f1)"
  else actual="$(shasum -a 256 "$ROOT/.runtime/$file" | cut -d' ' -f1)"; fi
  if [ "$actual" != "$expected" ]; then rm -f "$ROOT/.runtime/$file"; echo "Checksum mismatch; download discarded."; return 1; fi
  echo "      Checksum verified. Unpacking ..."
  tmp="$ROOT/.runtime/unpack"
  rm -rf "${tmp:?}" && mkdir -p "$tmp" && tar -xzf "$ROOT/.runtime/$file" -C "$tmp" || return 1
  rm -rf "${LOCAL_NODE:?}" && mv "$tmp/${file%.tar.gz}" "$LOCAL_NODE" || return 1
  rm -rf "${tmp:?}" "${ROOT:?}/.runtime/${file:?}"
  echo "      Node.js is ready in $LOCAL_NODE"
}

if [ -x "$LOCAL_NODE/bin/node" ]; then
  PATH="$LOCAL_NODE/bin:$PATH"
else
  # Common install locations that may be missing from PATH when started from Finder.
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
    if ! node_ok && [ -x "$dir/node" ]; then PATH="$dir:$PATH"; fi
  done
  if ! node_ok; then
    echo "A recent Node.js was not found. Downloading a private copy into this folder"
    echo "(about 50 MB; nothing is installed on the computer itself)..."
    get_node || { echo; echo "Please install the LTS version of Node.js from https://nodejs.org/ and start again."; fail; }
    PATH="$LOCAL_NODE/bin:$PATH"
  fi
fi
export PATH

node scripts/ensure-deps.mjs || fail
echo
node node_modules/tsx/dist/cli.mjs scripts/launch.ts "$@" || fail
