#!/usr/bin/env swift
// Generates a PopClip-style icon for the Lumen extension.
// Output: 128x128 RGBA PNG, pure white on transparent (PopClip tints icons,
// so colour would be discarded).
//
// Design: a speech-bubble (body + tail pointing DOWN-LEFT) containing a bold
// lowercase "L" (Lumen). Avoids the "A | 文" silhouette used by other
// translation extensions.
//
// Coordinate system: Core Graphics native. Origin is BOTTOM-left, +y is up.
// The tail must have smaller y than the body for it to point downward after
// NSBitmapImageRep writes the PNG (PNG rows are top-first, but CGContext
// pre-multiplied drawing already accounts for this — we draw in CG coords
// and let the bitmap rep flip on export).

import AppKit
import CoreGraphics
import CoreText
import Foundation

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 128

let colorSpace = CGColorSpaceCreateDeviceRGB()
// Use .premultipliedLast so PNG export keeps the alpha channel correctly.
guard let ctx = CGContext(
  data: nil, width: size, height: size,
  bitsPerComponent: 8, bytesPerRow: 0,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("ctx") }

// NO flip: draw in native CG coordinates. CGContext -> CGImage -> NSImage
// -> tiff -> NSBitmapImageRep handles the Y inversion for PNG output
// correctly when we leave the context unflipped.

let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
let black = CGColor(red: 0, green: 0, blue: 0, alpha: 1)

// Body occupies the upper portion; tail is BELOW it (smaller y).
let bodyRect = CGRect(x: 18, y: 34, width: 92, height: 72)
let bodyPath = CGPath(
  roundedRect: bodyRect, cornerWidth: 18, cornerHeight: 18, transform: nil)

// Fill body solid white.
ctx.setFillColor(white)
ctx.addPath(bodyPath)
ctx.fillPath()

// Tail: triangle attached to the bottom-left of the body, pointing DOWN.
// Coordinates (native CG, +y up):
//   top: y = 34 (body bottom edge)
//   tip: y = 18 (below body)
let tail = CGMutablePath()
tail.move(to: CGPoint(x: 30, y: 34))   // top-right of tail (on body edge)
tail.addLine(to: CGPoint(x: 44, y: 34)) // top-left of tail (on body edge)
tail.addLine(to: CGPoint(x: 22, y: 18)) // tip pointing down-left
tail.closeSubpath()
ctx.addPath(tail)
ctx.fillPath()

// Subtract the "L" so it shows as negative space.
ctx.setBlendMode(.destinationOut)

let attrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 56, weight: .heavy),
  .foregroundColor: NSColor(cgColor: black) ?? .black,
]
let attr = NSAttributedString(string: "L", attributes: attrs)
let line = CTLineCreateWithAttributedString(attr)
let bounds = CTLineGetBoundsWithOptions(line, [.useOpticalBounds])
let lx = bodyRect.midX - bounds.width / 2 - bounds.origin.x
let ly = bodyRect.midY - bounds.height / 2 - bounds.origin.y - 2
ctx.textPosition = CGPoint(x: lx, y: ly)
CTLineDraw(line, ctx)

ctx.setBlendMode(.normal)

guard let img = ctx.makeImage() else { fatalError("makeImage") }
let nsImg = NSImage(cgImage: img, size: NSSize(width: size, height: size))
guard let tiff = nsImg.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  fatalError("png encode")
}
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath)")
