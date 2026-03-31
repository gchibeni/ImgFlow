#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
#region Variables

TAURI_BUNDLE_DIR="./src-tauri/target/release/bundle/macos"
APP_NAME="ImgFlow.app"
TAURI_APP_PATH="$TAURI_BUNDLE_DIR/$APP_NAME"
MACOS_APP_PATH="/Applications/$APP_NAME"
TAURI_DEBUG_PATH="$MACOS_APP_PATH/Contents/MacOS/ImgFlow"
PLUGINS_DIR="$TAURI_APP_PATH/Contents/PlugIns"
ENTITLEMENTS="./.entitlements"

ARG_IDENTITY=""
BUNDLE=false
OPEN=false
DEBUG=false

#endregion

#region Arguments

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)
      BUNDLE=true
      shift
      ;;
    --open)
      OPEN=true
      shift
      ;;
    --debug)
      DEBUG=true
      shift
      ;;
    --identity)
      ARG_IDENTITY="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

#endregion

#region Identities

IDENTITIES=()
while IFS= read -r line; do
  IDENTITIES+=("$line")
done < <(
  security find-identity -v -p codesigning \
  | grep '"' \
  | sed -E 's/.*"(.+)"/\1/'
)

if [ ${#IDENTITIES[@]} -eq 0 ]; then
  echo "❌ No valid code signing identities found."
  exit 1
fi

#endregion

#region List

echo ""
echo "Available Code Signing Identities:"
i=1
for identity in "${IDENTITIES[@]}"; do
  printf "%2d) %s\n" "$i" "$identity"
  i=$((i + 1))
done
printf "%2d) Custom identity\n" "$i"

#endregion

#region Choice

while true; do
    if [ -n "$ARG_IDENTITY" ]; then
        INDEX=$(($ARG_IDENTITY - 1))
        SIGN_IDENTITY="${IDENTITIES[$INDEX]}"
        break
    fi
    read -p "Select identity number: " choice
    if ! [[ "$choice" =~ ^[0-9]+$ ]]; then
        echo "Invalid input. Enter a number."
        continue
    fi
    if [ "$choice" -eq "$i" ]; then
        read -p "Enter custom certificate identity: " SIGN_IDENTITY
        break
    fi
    INDEX=$((choice - 1))
    if [ "$INDEX" -lt 0 ] || [ "$INDEX" -ge "${#IDENTITIES[@]}" ]; then
        echo "Number out of range."
        continue
    fi
    SIGN_IDENTITY="${IDENTITIES[$INDEX]}"
    break
done

echo ""
echo "🔏 Using identity:"
echo "   $SIGN_IDENTITY"
echo ""

#endregion

#region Signing Plugins

if [ -d "$PLUGINS_DIR" ]; then
  echo "Signing PlugIns..."

  for plugin in "$PLUGINS_DIR"/*.appex; do
    [ -e "$plugin" ] || continue
    echo "→ Signing $(basename "$plugin")"

    codesign \
      --force \
      --options runtime \
      --entitlements "$ENTITLEMENTS" \
      --timestamp \
      --sign "$SIGN_IDENTITY" \
      "$plugin"
  done
else
  echo "⚠️ PlugIns folder not found, skipping plugins."
fi

#endregion

#region Signing App

echo ""
echo "Signing main app..."
codesign \
  --force \
  --options runtime \
  --timestamp \
  --sign "$SIGN_IDENTITY" \
  "$TAURI_APP_PATH"

#endregion

#region Verification

echo ""
echo "Verifying signature..."
codesign --verify --deep --strict --verbose=2 "$TAURI_APP_PATH"

echo ""
echo "✅ Code signing completed successfully."

#endregion

#region Debug

if $DEBUG; then
    killall ImgFlow || true
    echo "Debug mode enabled, starting application..."
    echo "Removing old version..."
    rm -rf "$MACOS_APP_PATH"
    echo "Installing new version..."
    cp -R "$TAURI_APP_PATH" "/Applications/"
    echo "App installed to /Applications"
    echo ""
    echo ""
    echo ""
    # The app must be installed in Applications folder for it to work propely with all the functions.
    exec "$TAURI_DEBUG_PATH"
    exit 0
fi

#endregion

#region Bundler

# Check for arguments.
if [[ $BUNDLE == false ]]; then
    # Repeat question until valid answer.
    while true; do
        read -p "Do you want to bundle application into a dmg file? [Y]es/[N]o: " response
        response=$(echo "$response" | tr '[:upper:]' '[:lower:]')

        if [[ "$response" == "y" || "$response" == "yes" ]]; then
            BUNDLE=true
            break
        elif [[ "$response" == "n" || "$response" == "no" ]]; then
            BUNDLE=false
            break
        fi
    done
fi

if $BUNDLE; then
    echo ""
    echo "Bundling app into dmg..."

    create-dmg \
    --overwrite \
    --no-version-in-filename \
    --identity "$SIGN_IDENTITY" \
    "$TAURI_APP_PATH" \
    "$TAURI_BUNDLE_DIR"
else
    echo "Skipping bundle."
fi

#endregion

#region File

if $OPEN; then
    open "$TAURI_BUNDLE_DIR"
else
    while true; do
        read -p "Do you want to open build location? [Y]es/[N]o: " response
        response=$(echo "$response" | tr '[:upper:]' '[:lower:]')

        if [[ "$response" == "y" || "$response" == "yes" ]]; then
            open "$TAURI_BUNDLE_DIR"
            break
        else
            break
        fi
    done
fi
#endregion
