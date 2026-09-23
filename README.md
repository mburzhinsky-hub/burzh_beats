# BURZH beats

Minimal Android music player with a monochrome Nothing-inspired UI.

## Current test station

- Lo-Fi: Yandex Music playlist `a0a4175e-9293-1c07-b536-aa9a4522bee8`

## Build

Every push to `main` runs GitHub Actions and produces a debug APK artifact.

The Android app is a small native shell:
- Java `Activity`
- local HTML/CSS/JS UI in `android_asset`
- native Yandex Music HTTP integration
- Android `MediaPlayer` playback

Build trigger: 2026-09-23
