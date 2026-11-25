# Ubiquitous Language: Mac Volume Remote

- **VolumePercent**: Integer clamped between 0 and 100 representing macOS master output volume level.
- **AudioState**: Domain snapshot consisting of `{ volume: VolumePercent, muted: boolean, outputDevice: string }`.
- **ClientCommand**: Commands dispatched from iPhone to host (`getState`, `setVolume`, `adjustVolume`, `setMuted`, `toggleMute`).
- **ServerMessage**: Authoritative messages dispatched from host to iPhone (`state`, `error`).
- **PairingPin**: 4-digit numeric string for manual pairing verification on LAN.
- **BootstrapToken**: 128-bit hex token embedded in QR URL for instant Safari pairing.
- **SessionToken**: 256-bit cryptographically secure bearer token issued after valid PIN or BootstrapToken exchange.
- **DiagnosticErrorCode**: Strongly typed domain error classification (`E_BOOT_FAILED`, `E_RUNTIME_ERROR`, `E_PAIR_FAILED`, `E_PAIR_RATE_LIMITED`, `E_AUTH_EXPIRED`, `E_SERVER_UNREACHABLE`, `E_WS_TIMEOUT`, `E_WS_DISCONNECTED`, `E_STORAGE_BLOCKED`).
- **DiagnosticReport**: Copy-pasteable structured plain-text summary with sensitive tokens redacted.
- **LanSelection**: Host network interface resolution result prioritizing physical Wi-Fi/Ethernet (`en0`) over VPN virtual tunnels.
- **VpnTunnelNotice**: Proactive warning surfaced when virtual tunnel interfaces are detected.
- **VolumeMemoryStore**: Atomic on-disk JSON store (`volume-state.json`) persisting the latest macOS `AudioState` across server restarts and iPhone switches.
- **PersistedVolumeState**: `AudioState` snapshot augmented with an ISO 8601 `updatedAt` timestamp.
- **StateSyncEndpoint**: Authenticated `GET /api/state` (`Cache-Control: no-store`) endpoint used by mobile clients on boot and app wake to immediately pull authoritative volume state.
- **HomeScreenIcon**: Opaque PNG icon assets (`apple-touch-icon.png` `180×180`, `icon-192.png`, `icon-512.png`) and `"Mac Volume"` manifest metadata for iOS Safari Add to Home Screen.
