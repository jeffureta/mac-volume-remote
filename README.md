# Mac Volume Remote 🎚️

Control your Mac's system volume and mute state in real-time from your iPhone via a high-performance, OLED-optimized Progressive Web App (PWA).

## Features
- **Sub-1ms Responsiveness**: Powered by a native Swift 6.4 `CoreAudio` helper subscribing to hardware volume changes.
- **2-Way Real-time Sync**: Physical Mac keyboard volume presses and AirPods connections reflect immediately on the iPhone screen without polling.
- **Echo Suppression**: Smooth touch scrubbing with optimistic local dragging that avoids jitter from in-flight server echoes.
- **OLED Control-Center Design**: Clean, mobile-first vertical pillar slider and tactile Mute pill tailored for both **iPhone 15 Pro** and **iPhone SE (2022)** with locked viewport, safe-area insets, and zero bounce.
- **Cross-iPhone Volume Memory**: Persists the latest volume state on your Mac (`~/.config/mac-volume-remote/volume-state.json`) and instantly syncs via `GET /api/state` + wake watchdog when switching between iPhones or restarting the server.
- **Native iOS Home Screen Icon**: Includes opaque PNG `apple-touch-icon.png` (`180×180`), `192×192`, and `512×512` icons labeled **Mac Volume** for Safari **Add to Home Screen**.
- **Zero-Friction Safari / PWA Pairing**: Instant QR bootstrap URL or 4-digit PIN exchange saved to `localStorage`.
- **Resource Conscious**: ~20MB RAM, 0% idle CPU on Apple Silicon (tested on M1 MacBook Air).
- **Background Auto-Start**: Includes optional `launchd` service integration.

## Quick Start

```bash
# 1. Install dependencies and compile
npm install
npm run build

# 2. Start the server
npm start
```

Scan the terminal QR code using your iPhone Camera, tap **Add to Home Screen**, and enjoy your volume remote!

## CLI Commands

```bash
# Display pairing QR code and PIN anytime
npx volremote pair

# Rotate PIN and pairing credentials
npx volremote pair --rotate

# Install as macOS login LaunchAgent
npx volremote service install

# Uninstall LaunchAgent
npx volremote service uninstall
```

## Architecture
- **PWA Client**: Vanilla TypeScript bundled via `esbuild`, Pointer Events, CSS Hardware Acceleration.
- **Server**: Node.js 22 + `ws` WebSocket & HTTP server.
- **Audio Bridge**: Swift binary linking `CoreAudio` and `AudioToolbox` using `kAudioHardwareServiceDeviceProperty_VirtualMainVolume`.
- **Testing**: Vitest with strict Test-Driven Development (TDD).

## License
MIT
