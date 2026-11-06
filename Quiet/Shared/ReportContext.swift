import DeviceActivity

/// The context name must match between the app (which hosts the view) and
/// the report extension (which renders it). One constant, two targets.
extension DeviceActivityReport.Context {
    static let quietTotals = Self("QuietTotals")
}
