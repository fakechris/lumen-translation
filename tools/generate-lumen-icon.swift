#!/usr/bin/env swift
// Generates a PopClip-style icon for the Lumen extension.
// Output: 128x128 RGBA PNG, pure white on transparent (PopClip tints icons,
// so colour would be discarded).
//
// Design: a speech-bubble (body + tail pointing DOWN-LEFT) containing a bold
// lowercase "L" (Lumen). Avoids the "A | 文" silhouette used by other
// translation extensions.
//
// Coordinate system: CGContext is native bottom-left (+y up). PNG files
// are stored top-down, and NSBitmapImageRep's representation(using: .png)
// writes rows top-first. When we draw in native CG coords (bottom-left
// origin, +y up) and export via NSBitmapImageRep, the result is that the
// image stored in the PNG displays matching what we drew — the bitmap rep
// handles the orientation correctly for us. So we do NOT flip the context;
// we draw in CG native coords (+y up).
//
// Verified empirically: an L drawn with its baseline at small y (near the
// bottom of the CG canvas) appears at the bottom of the PNG as displayed
// by Preview. A tail with its tip at smaller y than the body's bottom
// edge appears below the body.

import AppKit
import CoreGraphics
import CoreText
import Foundation

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 128

let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
  data: nil, width: size, height: size,
  bitsPerComponent: 8, bytesPerRow: 0,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("ctx") }

let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
let black = CGColor(red: 0, green: 0, blue: 0, alpha: 1)

// Larger bubble to fill more of the 128x128 canvas.
// Native CG coords: y=0 is the bottom. So body at top of canvas needs
// a large y (e.g. 30..114). Tail hangs BELOW the body, so smaller y.
let bodyRect = CGRect(x: 10, y: 30, width: 108, height: 84)
let bodyPath = CGPath(
  roundedRect: bodyRect, cornerWidth: 20, cornerHeight: 20, transform: nil)

ctx.setFillColor(white)
ctx.addPath(bodyPath)
ctx.fillPath()

// Tail: attached to the BOTTOM of the body, pointing DOWN-LEFT.
// In native CG coords, "down" means smaller y.
let tail = CGMutablePath()
tail.move(to: CGPoint(x: 26, y: 30))    // on body bottom edge
tail.addLine(to: CGPoint(x: 44, y: 30)) // other side of body bottom edge
tail.addLine(to: CGPoint(x: 16, y: 12)) // tip pointing down-left (smaller y)
tail.closeSubpath()
ctx.addPath(tail)
ctx.fillPath()

// Subtract the "L" so it shows as negative space.
ctx.setBlendMode(.destinationOut)

let attrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 64, weight: .heavy),
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
