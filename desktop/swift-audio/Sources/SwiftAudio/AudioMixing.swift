import AVFoundation
import CoreMedia
import Foundation

extension AudioRecorder {

    static let mixFormat: AVAudioFormat = {
        var asbd = AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0)
        return AVAudioFormat(streamDescription: &asbd)!
    }()

    func appendMixed(systemBuffer: CMSampleBuffer) {
        guard let sysPCM = Self.toFloatBuffer(systemBuffer), let sysCh = sysPCM.floatChannelData else {
            appendAudio(archive: systemBuffer, tracks: [(.system, systemBuffer, [])])
            return
        }
        let sysCount = Int(sysPCM.frameLength)
        let system = Array(UnsafeBufferPointer(start: sysCh[0], count: sysCount))

        let chunk = splitChunk(system: system, mic: takeMicSamples(sysCount))

        let pts = CMSampleBufferGetPresentationTimeStamp(systemBuffer)
        guard let mixBuffer = Self.sampleBuffer(chunk.mix, pts: pts) else {
            appendAudio(archive: systemBuffer, tracks: [(.system, systemBuffer, system)])
            return
        }
        var tracks: [(Track, CMSampleBuffer, [Float])] = []
        if let mic = Self.sampleBuffer(chunk.mic, pts: pts) { tracks.append((.mic, mic, chunk.mic)) }
        if let sys = Self.sampleBuffer(chunk.system, pts: pts) { tracks.append((.system, sys, chunk.system)) }
        appendAudio(archive: mixBuffer, tracks: tracks)
    }

    static func sampleBuffer(_ samples: [Float], pts: CMTime) -> CMSampleBuffer? {
        guard !samples.isEmpty,
            let pcm = AVAudioPCMBuffer(pcmFormat: mixFormat, frameCapacity: AVAudioFrameCount(samples.count)),
            let ch = pcm.floatChannelData
        else { return nil }
        pcm.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            ch[0].update(from: src.baseAddress!, count: samples.count)
        }
        return toCMSampleBuffer(pcm, pts: pts)
    }

    static func toFloatBuffer(_ sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else {
            return nil
        }
        let srcFormat = AVAudioFormat(cmAudioFormatDescription: fmtDesc)

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0,
            let srcBuffer = AVAudioPCMBuffer(
                pcmFormat: srcFormat, frameCapacity: AVAudioFrameCount(frameCount))
        else { return nil }
        srcBuffer.frameLength = AVAudioFrameCount(frameCount)

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frameCount),
            into: srcBuffer.mutableAudioBufferList)
        guard status == noErr else { return nil }

        if srcFormat.sampleRate == mixFormat.sampleRate
            && srcFormat.channelCount == 1
            && srcFormat.commonFormat == .pcmFormatFloat32
        {
            return srcBuffer
        }

        guard let converter = AVAudioConverter(from: srcFormat, to: mixFormat) else {
            return nil
        }
        let ratio = mixFormat.sampleRate / srcFormat.sampleRate
        let outCapacity = AVAudioFrameCount(Double(frameCount) * ratio + 1)
        guard
            let outBuffer = AVAudioPCMBuffer(
                pcmFormat: mixFormat, frameCapacity: outCapacity)
        else { return nil }

        var fed = false
        var convError: NSError?
        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return srcBuffer
        }
        let outStatus = converter.convert(
            to: outBuffer, error: &convError, withInputFrom: inputBlock)
        guard outStatus != .error, convError == nil else { return nil }
        return outBuffer
    }

    static func toCMSampleBuffer(_ pcm: AVAudioPCMBuffer, pts: CMTime) -> CMSampleBuffer? {
        let format = pcm.format
        var asbd = format.streamDescription.pointee

        var formatDesc: CMAudioFormatDescription?
        guard
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                magicCookieSize: 0, magicCookie: nil, extensions: nil,
                formatDescriptionOut: &formatDesc) == noErr,
            let formatDesc
        else { return nil }

        let frameCount = Int(pcm.frameLength)
        var sampleBuffer: CMSampleBuffer?
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(asbd.mSampleRate)),
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid)

        guard
            CMSampleBufferCreate(
                allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
                makeDataReadyCallback: nil, refcon: nil, formatDescription: formatDesc,
                sampleCount: frameCount, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sampleBuffer)
                == noErr,
            let sampleBuffer
        else { return nil }

        guard
            CMSampleBufferSetDataBufferFromAudioBufferList(
                sampleBuffer, blockBufferAllocator: kCFAllocatorDefault,
                blockBufferMemoryAllocator: kCFAllocatorDefault,
                flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                bufferList: pcm.audioBufferList) == noErr
        else { return nil }

        return sampleBuffer
    }
}
