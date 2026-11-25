import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct IconTarget {
    let filename: String
    let size: Int
}

let targets = [
    IconTarget(filename: "public/apple-touch-icon.png", size: 180),
    IconTarget(filename: "public/icon-192.png", size: 192),
    IconTarget(filename: "public/icon-512.png", size: 512)
]

func renderIcon(size: Int, outputPath: String) throws {
    let width = size
    let height = size
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue

    guard let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        throw NSError(domain: "IconGen", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create CGContext"])
    }

    let s = CGFloat(size)

    // Flip to top-left origin for intuitive SVG-like coordinates
    ctx.translateBy(x: 0, y: s)
    ctx.scaleBy(x: 1, y: -1)

    // Background OLED charcoal gradient (#18181D -> #08080A)
    let gradColors = [
        CGColor(red: 0x18 / 255.0, green: 0x18 / 255.0, blue: 0x1D / 255.0, alpha: 1.0),
        CGColor(red: 0x08 / 255.0, green: 0x08 / 255.0, blue: 0x0A / 255.0, alpha: 1.0)
    ] as CFArray
    if let gradient = CGGradient(colorsSpace: colorSpace, colors: gradColors, locations: [0.0, 1.0]) {
        ctx.drawLinearGradient(
            gradient,
            start: CGPoint(x: 0, y: 0),
            end: CGPoint(x: s, y: s),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    }

    // Subtle ambient blue glow behind sound waves
    let glowColors = [
        CGColor(red: 0x0A / 255.0, green: 0x84 / 255.0, blue: 0xFF / 255.0, alpha: 0.20),
        CGColor(red: 0x0A / 255.0, green: 0x84 / 255.0, blue: 0xFF / 255.0, alpha: 0.0)
    ] as CFArray
    if let glow = CGGradient(colorsSpace: colorSpace, colors: glowColors, locations: [0.0, 1.0]) {
        ctx.drawRadialGradient(
            glow,
            startCenter: CGPoint(x: s * 0.62, y: s * 0.50),
            startRadius: 0,
            endCenter: CGPoint(x: s * 0.62, y: s * 0.50),
            endRadius: s * 0.40,
            options: []
        )
    }

    // Speaker glyph centered inside iOS squircle safe zone
    ctx.setFillColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0))
    let speakerPath = CGMutablePath()
    speakerPath.move(to: CGPoint(x: s * 0.19, y: s * 0.42))
    speakerPath.addLine(to: CGPoint(x: s * 0.29, y: s * 0.42))
    speakerPath.addLine(to: CGPoint(x: s * 0.43, y: s * 0.28))
    speakerPath.addLine(to: CGPoint(x: s * 0.46, y: s * 0.28))
    speakerPath.addLine(to: CGPoint(x: s * 0.46, y: s * 0.72))
    speakerPath.addLine(to: CGPoint(x: s * 0.43, y: s * 0.72))
    speakerPath.addLine(to: CGPoint(x: s * 0.29, y: s * 0.58))
    speakerPath.addLine(to: CGPoint(x: s * 0.19, y: s * 0.58))
    speakerPath.closeSubpath()
    ctx.addPath(speakerPath)
    ctx.fillPath()

    // Apple-blue sound waves (#0A84FF)
    ctx.setStrokeColor(CGColor(red: 0x0A / 255.0, green: 0x84 / 255.0, blue: 0xFF / 255.0, alpha: 1.0))
    ctx.setLineCap(.round)
    ctx.setLineWidth(max(4.0, s * 0.056))

    let center = CGPoint(x: s * 0.49, y: s * 0.50)
    let angle = CGFloat.pi / 4.2

    // Inner arc
    ctx.beginPath()
    ctx.addArc(center: center, radius: s * 0.15, startAngle: -angle, endAngle: angle, clockwise: false)
    ctx.strokePath()

    // Outer arc
    ctx.beginPath()
    ctx.addArc(center: center, radius: s * 0.26, startAngle: -angle * 1.1, endAngle: angle * 1.1, clockwise: false)
    ctx.strokePath()

    guard let image = ctx.makeImage() else {
        throw NSError(domain: "IconGen", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to make CGImage"])
    }

    let url = URL(fileURLWithPath: outputPath)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "IconGen", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to create PNG destination"])
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) {
        throw NSError(domain: "IconGen", code: 4, userInfo: [NSLocalizedDescriptionKey: "Failed to write PNG"])
    }
}

for target in targets {
    try renderIcon(size: target.size, outputPath: target.filename)
    print("Generated \(target.filename) (\(target.size)x\(target.size))")
}
