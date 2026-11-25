# Ubiquitous Language: Mac Volume Remote

- **VolumePercent**: Integer clamped between 0 and 100 representing macOS master output volume level.
- **AudioState**: Domain snapshot consisting of `{ volume: VolumePercent, muted: boolean, outputDevice: string }`.
- **ClientCommand**: Commands dispatched from iPhone to host (`getState`, `setVolume`, `adjustVolume`, `setMuted`, `toggleMute`).
- **ServerMessage**: Authoritative messages dispatched from host to iPhone (`state`, `error`).
- **PairingPin**: 4-digit numeric string for manual pairing verification on LAN.
- **BootstrapToken**: 128-bit hex token embedded in QR URL for instant Safari pairing.
- **SessionToken**: 256-bit cryptographically secure bearer token issued after valid PIN or BootstrapToken exchange.
