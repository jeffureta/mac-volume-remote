import Foundation
import CoreAudio
import AudioToolbox

struct AudioPayload: Codable {
    let type: String
    let volume: Int
    let muted: boolean_t?
    let isMuted: Bool
    let device: String
}

final class CoreAudioController {
    static let shared = CoreAudioController()
    
    private var defaultOutputDeviceID: AudioDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var boundDeviceID: AudioDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var isListening = false
    
    private var defaultDeviceListenerBlock: AudioObjectPropertyListenerBlock?
    private var systemRestartListenerBlock: AudioObjectPropertyListenerBlock?
    private var volumeListenerBlock: AudioObjectPropertyListenerBlock?
    private var muteListenerBlock: AudioObjectPropertyListenerBlock?
    
    private init() {
        refreshDefaultDevice()
    }
    
    func refreshDefaultDevice() {
        var deviceID = AudioDeviceID(kAudioObjectUnknown)
        var propertySize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0,
            nil,
            &propertySize,
            &deviceID
        )
        
        if status == noErr {
            self.defaultOutputDeviceID = deviceID
        } else {
            self.defaultOutputDeviceID = AudioObjectID(kAudioObjectUnknown)
        }
    }
    
    func getDeviceName() -> String {
        guard defaultOutputDeviceID != kAudioObjectUnknown else {
            return "No Output Device"
        }
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var nameCF: CFString = "" as CFString
        var propertySize = UInt32(MemoryLayout<CFString>.size)
        
        let status = withUnsafeMutablePointer(to: &nameCF) { ptr in
            AudioObjectGetPropertyData(
                defaultOutputDeviceID,
                &propertyAddress,
                0,
                nil,
                &propertySize,
                ptr
            )
        }
        
        if status == noErr {
            return nameCF as String
        }
        return "Default Audio Output"
    }
    
    func getVolume() -> Int {
        guard defaultOutputDeviceID != kAudioObjectUnknown else {
            return 0
        }
        var volume: Float32 = 0.0
        var propertySize = UInt32(MemoryLayout<Float32>.size)
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        
        let status = AudioObjectGetPropertyData(
            defaultOutputDeviceID,
            &propertyAddress,
            0,
            nil,
            &propertySize,
            &volume
        )
        
        if status == noErr {
            return Int(round(volume * 100.0))
        }
        return 0
    }
    
    func setVolume(_ volumePercent: Int) {
        guard defaultOutputDeviceID != kAudioObjectUnknown else { return }
        var volume = Float32(max(0, min(100, volumePercent))) / 100.0
        let propertySize = UInt32(MemoryLayout<Float32>.size)
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        
        _ = AudioObjectSetPropertyData(
            defaultOutputDeviceID,
            &propertyAddress,
            0,
            nil,
            propertySize,
            &volume
        )
    }
    
    func isMuted() -> Bool {
        guard defaultOutputDeviceID != kAudioObjectUnknown else { return false }
        var muted: UInt32 = 0
        var propertySize = UInt32(MemoryLayout<UInt32>.size)
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        
        let status = AudioObjectGetPropertyData(
            defaultOutputDeviceID,
            &propertyAddress,
            0,
            nil,
            &propertySize,
            &muted
        )
        
        if status == noErr {
            return muted != 0
        }
        return false
    }
    
    func setMuted(_ mute: Bool) {
        guard defaultOutputDeviceID != kAudioObjectUnknown else { return }
        var muted: UInt32 = mute ? 1 : 0
        let propertySize = UInt32(MemoryLayout<UInt32>.size)
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        
        _ = AudioObjectSetPropertyData(
            defaultOutputDeviceID,
            &propertyAddress,
            0,
            nil,
            propertySize,
            &muted
        )
    }
    
    func emitState() {
        let vol = getVolume()
        let mute = isMuted()
        let device = getDeviceName()
        let payload: [String: Any] = [
            "type": "state",
            "volume": vol,
            "muted": mute,
            "device": device
        ]
        if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
           var lineData = String(data: jsonData, encoding: .utf8)?.data(using: .utf8) {
            lineData.append(0x0A)
            FileHandle.standardOutput.write(lineData)
        }
    }
    
    func startObserving() {
        guard !isListening else { return }
        isListening = true
        
        // Listen to default output device changes
        var defaultDeviceAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        let devBlock: AudioObjectPropertyListenerBlock = { _, _ in
            DispatchQueue.main.async {
                CoreAudioController.shared.refreshDefaultDevice()
                CoreAudioController.shared.bindDeviceListeners()
                CoreAudioController.shared.emitState()
            }
        }
        self.defaultDeviceListenerBlock = devBlock
        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &defaultDeviceAddress,
            DispatchQueue.main,
            devBlock
        )
        
        // Listen to coreaudiod daemon restarts
        var restartAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyServiceRestarted,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let restartBlock: AudioObjectPropertyListenerBlock = { _, _ in
            DispatchQueue.main.async {
                CoreAudioController.shared.refreshDefaultDevice()
                CoreAudioController.shared.bindDeviceListeners()
                CoreAudioController.shared.emitState()
            }
        }
        self.systemRestartListenerBlock = restartBlock
        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &restartAddress,
            DispatchQueue.main,
            restartBlock
        )
        
        bindDeviceListeners()
    }
    
    private func unbindDeviceListeners() {
        guard boundDeviceID != kAudioObjectUnknown else { return }
        
        var volumeAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        if let block = volumeListenerBlock {
            AudioObjectRemovePropertyListenerBlock(boundDeviceID, &volumeAddress, DispatchQueue.main, block)
            volumeListenerBlock = nil
        }
        
        var muteAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        if let block = muteListenerBlock {
            AudioObjectRemovePropertyListenerBlock(boundDeviceID, &muteAddress, DispatchQueue.main, block)
            muteListenerBlock = nil
        }
        
        boundDeviceID = AudioObjectID(kAudioObjectUnknown)
    }
    
    private func bindDeviceListeners() {
        unbindDeviceListeners()
        
        guard defaultOutputDeviceID != kAudioObjectUnknown else { return }
        boundDeviceID = defaultOutputDeviceID
        
        var volumeAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        let volBlock: AudioObjectPropertyListenerBlock = { _, _ in
            DispatchQueue.main.async {
                CoreAudioController.shared.emitState()
            }
        }
        self.volumeListenerBlock = volBlock
        AudioObjectAddPropertyListenerBlock(boundDeviceID, &volumeAddress, DispatchQueue.main, volBlock)
        
        var muteAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        let muteBlock: AudioObjectPropertyListenerBlock = { _, _ in
            DispatchQueue.main.async {
                CoreAudioController.shared.emitState()
            }
        }
        self.muteListenerBlock = muteBlock
        AudioObjectAddPropertyListenerBlock(boundDeviceID, &muteAddress, DispatchQueue.main, muteBlock)
    }
}

// Check arguments or stdin loop
let args = CommandLine.arguments
if args.contains("--get") {
    CoreAudioController.shared.emitState()
    exit(0)
}

CoreAudioController.shared.startObserving()
CoreAudioController.shared.emitState()

// Read stdin NDJSON commands asynchronously using utility QoS
let stdIn = FileHandle.standardInput

DispatchQueue.global(qos: .utility).async {
    while true {
        let data = stdIn.availableData
        guard !data.isEmpty else {
            exit(0)
        }
        if let line = String(data: data, encoding: .utf8) {
            let lines = line.split(separator: "\n")
            for single in lines {
                let trimmed = single.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                if let jsonData = trimmed.data(using: .utf8),
                   let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                   let cmd = dict["cmd"] as? String {
                    DispatchQueue.main.async {
                        if cmd == "get" {
                            CoreAudioController.shared.emitState()
                        } else if cmd == "setVolume", let vol = dict["volume"] as? Int {
                            CoreAudioController.shared.setVolume(vol)
                            CoreAudioController.shared.emitState()
                        } else if cmd == "setMuted", let m = dict["muted"] as? Bool {
                            CoreAudioController.shared.setMuted(m)
                            CoreAudioController.shared.emitState()
                        }
                    }
                }
            }
        }
    }
}

RunLoop.main.run()
