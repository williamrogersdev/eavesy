import Foundation

protocol Recorder: AnyObject {
    func start()
    func stop(completion: @escaping (_ durationSec: Double) -> Void)
    /// Stop keeping what is captured, or start again. Only screen recordings pause.
    func setPaused(_ paused: Bool)
}

extension Recorder {
    func setPaused(_ paused: Bool) {}
}
