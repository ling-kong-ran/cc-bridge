import tempfile
import unittest
from pathlib import Path
from unittest import mock

import memory_index
import memory_vector_store


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
        self.vector_dir = self.home / '.ccb' / 'memory_vectors'
        self.vector_dir.mkdir(parents=True)
        self.patches = [
            mock.patch.object(memory_index, 'INDEX_DIR', self.index_dir),
            mock.patch.object(memory_vector_store, 'VECTOR_DIR', self.vector_dir),
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

    def test_search_semantic_alias_matches_release_wording(self):
        self.write_memory('wiki/decisions/release.md', '---\nname: 发布限制\ntype: decision\n---\n\nrelease workflow 不要手动提交 version bump。')
        memory_index.index_memory(self.cwd, force=True)
        results = memory_index.search_memory('发版限制', self.cwd)
        self.assertTrue(results)
        self.assertEqual(results[0]['file'], 'wiki/decisions/release.md')

    def test_search_merges_optional_vector_results(self):
        self.write_memory('wiki/decisions/vector.md', '---\nname: 语义检索决策\ntype: decision\n---\n\n向量库负责 semantic recall。')
        memory_index.index_memory(self.cwd, force=True)
        with mock.patch.object(memory_index, '_search_vector_memory', return_value=[(
            'wiki/decisions/vector.md', 'wiki/decisions/vector.md', '语义检索决策', '向量库负责 semantic recall。', -0.9, '向量库 semantic recall'
        )]):
            results = memory_index.search_memory('语义召回', self.cwd)
        self.assertTrue(results)
        self.assertEqual(results[0]['file'], 'wiki/decisions/vector.md')

    def test_sqlite_vector_store_matches_alias_terms(self):
        self.write_memory('wiki/decisions/release-vector.md', '---\nname: Release Workflow\ntype: decision\n---\n\nrelease workflow requires checking installer artifacts before publishing。')
        memory_index.index_memory(self.cwd, force=True)
        result = memory_vector_store.index_memory(self.cwd)
        self.assertTrue(result['available'])
        results = memory_vector_store.search_memory('发版流程检查产物', self.cwd)
        self.assertTrue(results)
        self.assertEqual(results[0]['file'], 'wiki/decisions/release-vector.md')
        self.assertEqual(results[0]['retrieval'], 'sqlite-vector')

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
