#!/usr/bin/env swift
// Generates a menu-bar template icon for LumenWindow.
// Template images use alpha only — macOS tints them to match the menu bar.
//
// Design: a rounded square tile with an "A" cut out as negative space,
// echoing the Lumen Translation product mark (A文) in a monochrome form
// suitable for the system status bar.

import AppKit
import CoreGraphics
import CoreText
import Foundation

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "statusicon.png"
let size = 32 // retina-ready for menu bar (displayed at ~16pt)

let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
  data: nil, width: size, height: size,
  bitsPerComponent: 8, bytesPerRow: 0,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("ctx") }

let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)

// Rounded square tile filling most of the canvas.
let tileRect = CGRect(x: 3, y: 3, width: 26, height: 26)
let tilePath = CGPath(
  roundedRect: tileRect, cornerWidth: 6, cornerHeight: 6, transform: nil)

ctx.setFillColor(white)
ctx.addPath(tilePath)
ctx.fillPath()

// Cut out "A" as negative space.
ctx.setBlendMode(.destinationOut)

let attrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 17, weight: .heavy),
  .foregroundColor: NSColor.black,
]
let attr = NSAttributedString(string: "A", attributes: attrs)
let line = CTLineCreateWithAttributedString(attr)
let bounds = CTLineGetBoundsWithOptions(line, [.useOpticalBounds])
let lx = tileRect.midX - bounds.width / 2 - bounds.origin.x
let ly = tileRect.midY - bounds.height / 2 - bounds.origin.y
ctx.textPosition = CGPoint(x: lx, y: ly)
CTLineDraw(line, ctx)

guard let img = ctx.makeImage() else { fatalError("makeImage") }
let nsImg = NSImage(cgImage: img, size: NSSize(width: 16, height: 16))
nsImg.isTemplate = true
guard let tiff = nsImg.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  fatalError("png encode")
}
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath)")
