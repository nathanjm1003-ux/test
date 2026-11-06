import WidgetKit
import SwiftUI

@main
struct QuietWidgetBundle: WidgetBundle {
    var body: some Widget {
        HomeWidget()
        if #available(iOS 18.0, *) {
            QuietControl()
        }
    }
}
