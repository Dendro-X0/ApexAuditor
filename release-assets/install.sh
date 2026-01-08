#!/usr/bin/env bash
set -euo pipefail
REPO="${SIGNALER_REPO:-Dendro-X0/signaler}"
VERSION="latest"
INSTALL_DIR=""
ADD_TO_PATH="0"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:-}"; shift 2 ;;
    --version)
      VERSION="${2:-latest}"; shift 2 ;;
    --dir)
      INSTALL_DIR="${2:-}"; shift 2 ;;
    --add-to-path)
      ADD_TO_PATH="1"; shift 1 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
export SIGNALER_REPO="$REPO"
if command -v signaler >/dev/null 2>&1; then
  if [ "$VERSION" = "latest" ]; then
    signaler upgrade --repo "$REPO"
  else
    signaler upgrade --repo "$REPO" --version "$VERSION"
  fi
  exit 0
fi
BASE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/signaler"
INSTALL_DIR="${INSTALL_DIR:-$BASE_DIR/current}"
BIN_DIR="$BASE_DIR/bin"
mkdir -p "$BIN_DIR"
PROFILE_UPDATED="0"
PROFILE_FILES=("$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.config/fish/config.fish")
for profile in "${PROFILE_FILES[@]}"; do
  if [ -f "$profile" ]; then
    if [ "${profile##*.}" = "fish" ]; then
      if grep -q "SIGNALER_REPO" "$profile" 2>/dev/null; then
        sed -i.bak "s/^set -Ux SIGNALER_REPO .*/set -Ux SIGNALER_REPO \"$REPO\"/" "$profile" || true
      else
        printf '\nset -Ux SIGNALER_REPO "%s"\n' "$REPO" >> "$profile"
      fi
      PROFILE_UPDATED="1"
    else
      if grep -q "SIGNALER_REPO" "$profile" 2>/dev/null; then
        sed -i.bak "s/^export SIGNALER_REPO=.*/export SIGNALER_REPO=\"$REPO\"/" "$profile" || true
      else
        printf '\nexport SIGNALER_REPO="%s"\n' "$REPO" >> "$profile"
      fi
      PROFILE_UPDATED="1"
    fi
  fi
done
if [ "$VERSION" = "latest" ]; then
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
else
  API_URL="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi
JSON="$(curl -fsSL -H 'User-Agent: signaler-installer' "$API_URL")"
ZIP_URL="$(printf '%s' "$JSON" | tr '\n' ' ' | sed -n 's/.*"browser_download_url"[ ]*:[ ]*"\([^"]*\\-portable\\.zip\)".*/\1/p' | head -n 1)"
if [ -z "$ZIP_URL" ]; then
  echo "No *-portable.zip asset found in release." >&2
  exit 1
fi
tmp_zip="$(mktemp -t signaler-portable.XXXXXX.zip)"
tmp_dir="$(mktemp -d -t signaler-staging.XXXXXX)"
trap 'rm -f "$tmp_zip"; rm -rf "$tmp_dir"' EXIT
curl -fL -H 'User-Agent: signaler-installer' "$ZIP_URL" -o "$tmp_zip"
unzip -q "$tmp_zip" -d "$tmp_dir"
root_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$root_dir" ]; then
  echo "Portable zip did not contain a root directory." >&2
  exit 1
fi
rm -rf "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"
mv "$root_dir" "$INSTALL_DIR"
launcher="$BIN_DIR/signaler"
cat > "$launcher" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../current" && pwd)"
node "$ROOT_DIR/dist/bin.js" "$@"
EOF
chmod +x "$launcher"
echo "Installed to: $INSTALL_DIR"
echo "Launcher: $launcher"
if [ "$ADD_TO_PATH" = "1" ]; then
  echo "Add this to your shell profile if not present:" 
  echo "export PATH=\"$BIN_DIR:$PATH\"" 
else
  echo "Add this directory to PATH to run from anywhere: $BIN_DIR" 
fi
if [ "$PROFILE_UPDATED" = "1" ]; then
  echo "Wrote SIGNALER_REPO to your shell profile. Restart your terminal." 
fi
echo "Try: signaler --help" 
