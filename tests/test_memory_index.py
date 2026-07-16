import tempfile
import unittest
from pathlib import Path
from unittest import mock

import memory_index


class MemoryIndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / 'home'
        self.home.mkdir()
        self.cwd = str(Path(self.tmp.name) / 'project')
        Path(self.cwd).mkdir()
        self.memory_dir = self.home / '.claude' / 'projects' / memory_index._sanitize_path(self.cwd) / 'memory'
        self.memory_dir.mkdir(parents=True)
        self.index_dir = self.home / '.ccb' / 'memory_index'
        self.index_dir.mkdir(parents=True)
        self.patches = [
            mock.patch.object(memory_index, 'INDEX_DIR', self.index_dir),
            mock.patch.object(Path, 'home', classmethod(lambda cls: self.home)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def write_memory(self, rel, text):
        path = self.memory_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def test_list_files_includes_relative_path_and_frontmatter(self):
        self.write_memory('wiki/decisions/sse.md', '---\nname: 采用 SSE\ntype: decision\nsource: session\ninject: auto\ntags: [sse, ui]\nconfidence: 0.9\nscope: project\nlast_verified_at: 2026-07-16\n---\n\n正文')
        files = memory_index.list_memory_files(self.cwd)
        self.assertEqual(files[0]['path'], 'wiki/decisions/sse.md')
        self.assertEqual(files[0]['title'], '采用 SSE')
        self.assertEqual(files[0]['type'], 'decision')
        self.assertEqual(files[0]['source'], 'session')
        self.assertEqual(files[0]['inject'], 'auto')
        self.assertEqual(files[0]['scope'], 'project')
        self.assertEqual(files[0]['last_verified_at'], '2026-07-16')
        self.assertTrue(files[0]['body_hash'])
        self.assertEqual(files[0]['tags'], ['sse', 'ui'])

    def test_same_basename_files_are_indexed_by_relative_path(self):
        self.write_memory('raw/note.md', '---\nname: 原始记录\n---\n\n飞书消息网关')
        self.write_memory('wiki/note.md', '---\nname: 决策记录\n---\n\nSSE 自动注入')
        memory_index.index_memory(self.cwd, force=True)
        files = {item['path'] for item in memory_index.list_memory_files(self.cwd)}
        self.assertTrue({'raw/note.md', 'wiki/note.md'}.issubset(files))
        self.assertIn('wiki/quickstart.md', files)
        self.assertIn('wiki/preferences.md', files)
        hit_paths = {item['file'] for item in memory_index.search_memory('飞书消息', self.cwd)}
        self.assertIn('raw/note.md', hit_paths)

    def test_search_snippet_uses_body_not_filename(self):
        self.write_memory('feedback.md', '---\nname: 协作偏好\n---\n\n用户要求提交信息使用中文。')
        memory_index.index_memory(self.cwd, force=True)
        results = memory_index.search_memory('提交信息中文', self.cwd)
        self.assertTrue(results)
        self.assertIn('提交', results[0]['snippet'])

    def test_search_rerank_prefers_specific_topic_over_index(self):
        self.write_memory('MEMORY.md', '# Memory Index\n\n记忆 系统 检索 命中 质量 优化 项目 功能 说明。')
        self.write_memory('feedback_token.md', '---\nname: 收紧记忆检索\ntype: feedback\n---\n\n记忆检索应更精准，避免普通语句命中过多记忆浪费 token。')
        memory_index.index_memory(self.cwd, force=True)
        results = memory_index.search_memory('记忆检索命中不高质量', self.cwd)
        self.assertTrue(results)
        self.assertEqual(results[0]['file'], 'feedback_token.md')

    def test_save_same_content_does_not_rewrite_body_file(self):
        content = '---\nname: 稳定偏好\ntype: feedback\n---\n\n保持精简。'
        saved = memory_index.save_memory_file('wiki/preferences/stable.md', content, self.cwd)
        self.assertIsNotNone(saved)
        path = self.memory_dir / 'wiki' / 'preferences' / 'stable.md'
        mtime = path.stat().st_mtime_ns
        saved_again = memory_index.save_memory_file('wiki/preferences/stable.md', content, self.cwd)
        self.assertIsNotNone(saved_again)
        self.assertEqual(path.stat().st_mtime_ns, mtime)


if __name__ == '__main__':
    unittest.main()
