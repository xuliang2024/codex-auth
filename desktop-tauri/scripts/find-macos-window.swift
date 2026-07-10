import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2 else {
  fputs("Expected one window title.\n", stderr)
  exit(2)
}

let expectedTitle = CommandLine.arguments[1]
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  fputs("Could not inspect macOS windows.\n", stderr)
  exit(1)
}

for window in windows {
  let title = window[kCGWindowName as String] as? String ?? ""
  let layer = window[kCGWindowLayer as String] as? Int ?? -1
  let number = window[kCGWindowNumber as String] as? Int ?? 0
  if layer == 0 && title == expectedTitle && number > 0 {
    print(number)
    exit(0)
  }
}

exit(1)
