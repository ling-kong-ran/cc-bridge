import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import memory_consolidator
import memory_index
import memory_llm


class MemoryConsolidatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / 'home'
        self.home.mkdir()
        self.index_dir = self.home / '.ccb' / 'memory_index'
        self.index_dir.mkdir(parents=True)
        self.jobs_path = Path(self.tmp.name) / 'jobs.json'
        self.patches = [
            mock.patch.object(memory_consolidator, 'JOBS_PATH', self.jobs_path),
            mock.patch.object(memory_index, 'INDEX_DIR', self.index_dir),
            mock.patch.object(Path, 'home', classmethod(lambda cls: self.home)),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def test_failed_extraction_result_triggers_regex_fallback(self):
        job_id = memory_consolidator.enqueue_consolidation(
            'sid', '/tmp/project', 'run', 'cid', user_message='请记住以后提交信息使用中文'
        )
        result = memory_consolidator.run_consolidation_job(
            job_id,
            {'memoryAutoConsolidate': 'safe'},
            memory_llm.ExtractionResult(status='failed', candidates=[], error='not logged in'),
        )
        self.assertEqual(result.get('extraction_source'), 'regex_fallback')
        self.assertGreaterEqual(result.get('candidates', 0), 1)
        self.assertTrue(result.get('raw_files'))
        self.assertTrue(result.get('files'))
        self.assertTrue(result['raw_files'][0]['filename'].startswith('raw/sessions/'))
        self.assertTrue(result['files'][0]['filename'].startswith('wiki/preferences/'))

    def test_ok_empty_extraction_does_not_fallback(self):
        job_id = memory_consolidator.enqueue_consolidation(
            'sid', '/tmp/project', 'run', 'cid', user_message='请记住以后提交信息使用中文'
        )
        result = memory_consolidator.run_consolidation_job(
            job_id,
            {'memoryAutoConsolidate': 'safe'},
            memory_llm.ExtractionResult(status='ok', candidates=[]),
        )
        self.assertEqual(result.get('extraction_source'), 'llm')
        self.assertEqual(result.get('candidates'), 0)

    def test_job_store_keeps_concurrent_enqueues(self):
        def enqueue(i):
            memory_consolidator.enqueue_consolidation(f'sid{i}', '/tmp/project', f'run{i}', 'cid', user_message=f'请记住规则 {i}')
        threads = [threading.Thread(target=enqueue, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(memory_consolidator._load_jobs()), 20)

    def test_regex_fallback_classifies_decision_workflow_and_troubleshooting(self):
        cases = [
            ('请记住我们决定发布流程不要手动提交版本文件', 'decision', 'wiki/decisions/'),
            ('请记住每次发版先运行 release workflow 再检查产物', 'workflow', 'wiki/workflows/'),
            ('请记住遇到 SSE 断连报错的排查步骤是先看 heartbeat', 'troubleshooting', 'wiki/troubleshooting/'),
        ]
        for message, expected_type, prefix in cases:
            job_id = memory_consolidator.enqueue_consolidation(
                'sid', '/tmp/project', expected_type, 'cid', user_message=message
            )
            result = memory_consolidator.run_consolidation_job(
                job_id,
                {'memoryAutoConsolidate': 'safe'},
                memory_llm.ExtractionResult(status='failed', candidates=[], error='not logged in'),
            )
            self.assertEqual(result['files'][0]['type'], expected_type)
            self.assertTrue(result['files'][0]['filename'].startswith(prefix))


if __name__ == '__main__':
    unittest.main()
