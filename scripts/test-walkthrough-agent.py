"""Exercise the packaged native MCP server over real stdio; no GUI or network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

BINARY = Path(os.environ.get('EAVESY_AGENT_BINARY', str(Path(__file__).resolve().parents[1] / 'desktop/src-tauri/target/debug/eavesy')))


class AgentAccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.folder = self.root / '2026-10-20 Checkout'
        self.folder.mkdir()
        (self.folder / 'frames').mkdir()
        (self.folder / 'frames/18000.jpg').write_bytes(b'\xff\xd8fixture\xff\xd9')
        self.bundle = {'schemaVersion': 1, 'id': 'recording-one', 'title': 'Checkout', 'status': 'complete',
                       'video': 'screen.mp4', 'durationMs': 30000, 'sampleIntervalMs': 2000,
                       'timestampSource': 'segments', 'correctedTranscript': 'Click Continue', 'warnings': [],
                       'capture': {'microphoneEnabled': True, 'microphoneSamplesWritten': 48000},
                       'segments': [{'startMs': 18000, 'endMs': 20000, 'text': 'Click Continue'}],
                       'frames': [{'timestampMs': 18000, 'path': 'frames/18000.jpg', 'text': 'Address required',
                                   'width': 1920, 'height': 1080, 'regions': []}]}
        self.save()

    def save(self):
        (self.folder / 'walkthrough.json').write_text(json.dumps(self.bundle))

    def tearDown(self):
        self.temp.cleanup()

    def request(self, name, arguments):
        message = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}}
        return self.exchange([message])[0]['result']

    def exchange(self, messages):
        process = subprocess.run([str(BINARY), '--walkthrough-mcp', '--recordings-root', str(self.root)],
                                 input='\n'.join(map(json.dumps, messages)) + '\n', text=True, capture_output=True, check=True, timeout=10)
        return [json.loads(line) for line in process.stdout.splitlines()]

    def test_searches_narration_and_screen_text(self):
        for query in ['address required', 'click continue']:
            result = self.request('list_walkthroughs', {'query': query})
            self.assertEqual(json.loads(result['content'][0]['text'])[0]['id'], 'recording-one')
        for query in ['missing', 'segments', 'frames', 'schemaVersion']:
            result = self.request('list_walkthroughs', {'query': query})
            self.assertEqual(json.loads(result['content'][0]['text']), [])

    def test_corrected_search_excerpt_contains_the_match(self):
        self.bundle['correctedTranscript'] = 'prefix ' * 100 + 'Unique corrected phrase'
        self.save()
        result = self.request('list_walkthroughs', {'query': 'unique corrected'})
        matches = json.loads(result['content'][0]['text'])[0]['matches']
        self.assertEqual(matches[0]['kind'], 'corrected')
        self.assertIsNone(matches[0]['timestampMs'])
        self.assertIn('Unique corrected phrase', matches[0]['text'])

    def test_corrected_match_keeps_a_slot_and_unicode_excerpt(self):
        self.bundle['correctedTranscript'] = 'İ ΟΣ Straße ' * 100 + 'Unique corrected phrase'
        self.bundle['segments'] = [{'startMs': i * 1000, 'endMs': i * 1000 + 900, 'text': 'Unique corrected phrase'} for i in range(6)]
        self.save()
        result = self.request('list_walkthroughs', {'query': 'unique corrected'})
        matches = json.loads(result['content'][0]['text'])[0]['matches']
        self.assertEqual(len(matches), 5)
        self.assertEqual(matches[-1]['kind'], 'corrected')
        self.assertIn('Unique corrected phrase', matches[-1]['text'])

    def test_frame_returns_actual_time_and_image(self):
        result = self.request('get_walkthrough_frame', {'id': 'recording-one', 'timestampMs': 19000})
        frame = json.loads(result['content'][0]['text'])
        self.assertEqual(frame['frame']['timestampMs'], 18000)
        self.assertEqual(frame['distanceMs'], 1000)
        self.assertEqual(result['content'][1]['mimeType'], 'image/jpeg')
        self.assertIn('data', result['content'][1])

    def test_rejects_path_escape_and_symlinks(self):
        outside = self.root / 'outside.jpg'
        outside.write_bytes(b'fixture')
        self.bundle['frames'][0]['path'] = '../outside.jpg'
        self.save()
        self.assertTrue(self.request('get_walkthrough_frame', {'id': 'recording-one', 'timestampMs': 0})['isError'])
        (self.folder / 'frames/link.jpg').symlink_to(outside)
        self.bundle['frames'][0]['path'] = 'frames/link.jpg'
        self.save()
        self.assertTrue(self.request('get_walkthrough_frame', {'id': 'recording-one', 'timestampMs': 0})['isError'])

    def test_mcp_initialize_notifications_and_tools(self):
        replies = self.exchange([
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'get_walkthrough', 'arguments': {'id': 'recording-one'}}},
        ])
        self.assertEqual([r['id'] for r in replies], [1, 2, 3])
        self.assertEqual(replies[0]['result']['protocolVersion'], '2025-06-18')
        self.assertEqual(len(replies[1]['result']['tools']), 3)
        self.assertIn('Click Continue', replies[2]['result']['content'][0]['text'])

    def test_ranges_keep_overlapping_speech_and_omit_untimed_full_text(self):
        result = self.request('get_walkthrough', {'id': 'recording-one', 'startMs': 19000, 'endMs': 22000})
        value = json.loads(result['content'][0]['text'])
        self.assertEqual(len(value['bundle']['segments']), 1)
        self.assertEqual(value['bundle']['frames'], [])
        self.assertEqual(value['bundle']['correctedTranscript'], '')
        self.assertTrue(value['correctedTranscriptOmitted'])
        result = self.request('list_walkthroughs', {'query': 'address'})
        self.assertEqual(json.loads(result['content'][0]['text'])[0]['matches'][0]['timestampMs'], 18000)

    def test_handles_missing_recording_and_negative_time(self):
        self.assertTrue(self.request('get_walkthrough', {'id': 'missing'})['isError'])
        self.assertTrue(self.request('get_walkthrough_frame', {'id': 'recording-one', 'timestampMs': -1})['isError'])


if __name__ == '__main__':
    unittest.main()
