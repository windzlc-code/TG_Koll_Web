import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import runninghub_common


class RunningHubCommonTests(unittest.TestCase):
    def test_query_task_treats_successful_png_result_as_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / 'out.png'
            response = type('Resp', (), {'json': lambda self: {
                'taskId': 'task_png_1',
                'status': 'SUCCESS',
                'results': [
                    {
                        'url': 'https://example.com/out.png',
                        'nodeId': '57',
                        'outputType': 'png',
                        'text': None,
                    }
                ],
                'errorCode': '',
                'errorMessage': '',
                'failedReason': {},
                'usage': {'consumeCoins': '91'},
            }})()
            with patch.object(runninghub_common.requests, 'post', return_value=response), \
                 patch.object(runninghub_common, 'download_file', side_effect=lambda file_url, output_path: Path(output_path).write_bytes(b'png')):
                result = runninghub_common.query_task(task_id='task_png_1', api_key='rh-key', video_output_path=str(output_path))
        self.assertEqual(result['status'], 'success')
        self.assertIn('Image Download successfully!', result['message'])


if __name__ == '__main__':
    unittest.main()
