import CoreGraphics
import CoreImage
import Foundation
import ImageIO

let usage = "usage: tiff-to-heic [--json] INPUT_TIFF OUTPUT_HEIC hlg|pq\n       tiff-to-heic [--json] --preflight\n       tiff-to-heic --help\n"
var arguments = Array(CommandLine.arguments.dropFirst())
let json = arguments.contains("--json")
arguments.removeAll { $0 == "--json" }

func fail(_ code: String, _ condition: String, _ remedy: String, _ status: Int32) -> Never {
    if json {
        let payload = ["error": ["code": code, "condition": condition, "remedy": remedy]]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        FileHandle.standardError.write(data + Data("\n".utf8))
    } else {
        FileHandle.standardError.write(Data("ERROR [\(code)]: \(condition)\nRemedy: \(remedy)\n".utf8))
    }
    exit(status)
}

if arguments == ["--help"] || arguments == ["-h"] {
    print(usage, terminator: "")
    exit(0)
}
if arguments == ["--preflight"] {
    print(json ? "{\"preflight\":{\"status\":\"ready\"}}" : "READY")
    exit(0)
}
guard arguments.count == 3 else {
    fail("usage_error", "expected an input TIFF, output HEIC, and hlg or pq transfer", "run tiff-to-heic --help", 2)
}

let input = URL(fileURLWithPath: arguments[0])
let output = URL(fileURLWithPath: arguments[1])
let transfer = arguments[2]
let colorSpaceName: CFString

switch transfer {
case "hlg":
    colorSpaceName = CGColorSpace.itur_2100_HLG
case "pq":
    colorSpaceName = CGColorSpace.itur_2100_PQ
default:
    fail("usage_error", "transfer must be hlg or pq", "pass hlg or pq as the transfer", 2)
}

guard let colorSpace = CGColorSpace(name: colorSpaceName),
      let workingColorSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020),
      let image = CIImage(contentsOf: input, options: [.colorSpace: colorSpace, .expandToHDR: true]) else {
    fail("input_unusable", "could not read the input TIFF as HDR", "pass a readable 16-bit RGB TIFF", 2)
}

let context = CIContext(options: [
    .workingColorSpace: workingColorSpace,
    .workingFormat: CIFormat.RGBAh,
])

do {
    try context.writeHEIF10Representation(
        of: image,
        to: output,
        colorSpace: colorSpace,
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 1.0]
    )
} catch {
    fail("heic_encode_failed", "HEIC encoding failed: \(error)", "repair the macOS Core Image HEIC encoder", 1)
}
