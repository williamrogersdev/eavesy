import Foundation

protocol Recorder: AnyObject {
    func start()
    func stop(completion: @escaping (_ durationSec: Double) -> Void)
}
