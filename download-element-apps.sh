#!/bin/bash
set -e

mkdir -p ./nginx/html/apps
cd ./nginx/html/apps

wget "https://packages.element.io/desktop/install/linux/glibc-x86-64/element-desktop-1.12.6.tar.gz" \
    -O element-desktop-linux-x86_64.tar.gz
wget "https://packages.element.io/desktop/install/linux/glibc-aarch64/element-desktop-1.12.6-arm64.tar.gz"
wget "https://packages.element.io/desktop/install/macos/Element.dmg"
wget "https://packages.element.io/desktop/install/win32/x64/Element%20Setup.exe" \
    -O Element.exe
wget "https://github.com/element-hq/element-android/releases/download/v1.6.48/vector-gplay-arm64-v8a-release-signed.apk" \
    -O element.apk
