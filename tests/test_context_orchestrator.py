import unittest
from unittest import mock

import context_orchestrator


class ContextOrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.cwd = "/tmp/ccb-project"

    def test_low_signal_greeting_skips_memory_recall(self):
        with mock.patch.object(context_orchestrator.memory_index, "index_memory") as index_memory:
            trace = context_orchestrator.retrieve_context_trace("你好", self.cwd)

        index_memory.assert_not_called()
        self.assertEqual(trace["injected"], [])
        self.assertIn("low-signal", trace["skipped"][0]["reason"])

    def test_raw_and_inject_never_are_not_auto_injected_by_default(self):
        search_results = [
            {"name": "raw/session.md", "file": "raw/session.md", "title": "Raw Session"},
            {"name": "wiki/never.md", "file": "wiki/never.md", "title": "Never"},
            {"name": "wiki/alpha.md", "file": "wiki/alpha.md", "title": "Alpha Workflow"},
        ]
        files = {
            "raw/session.md": {
                "file": "raw/session.md",
                "title": "Raw Session",
                "content": "---\nname: Raw Session\ntype: raw\nsource: raw\n---\n\nalpha beta gamma raw evidence",
                "body": "alpha beta gamma raw evidence",
            },
            "wiki/never.md": {
                "file": "wiki/never.md",
                "title": "Never",
                "content": "---\nname: Never\ninject: never\n---\n\nalpha beta gamma hidden",
                "body": "alpha beta gamma hidden",
            },
            "wiki/alpha.md": {
                "file": "wiki/alpha.md",
                "title": "Alpha Workflow",
                "content": "---\nname: Alpha Workflow\ntype: workflow\nscope: project\nlast_verified_at: 2026-07-16\n---\n\nalpha beta gamma deployment workflow",
                "body": "alpha beta gamma deployment workflow",
            },
        }

        with (
            mock.patch.object(context_orchestrator.memory_index, "index_memory", return_value=3),
            mock.patch.object(context_orchestrator.memory_index, "search_memory", return_value=search_results),
            mock.patch.object(context_orchestrator.memory_index, "get_memory_file", side_effect=lambda name, cwd: files.get(name)),
            mock.patch.object(context_orchestrator.wiki_store, "search", return_value={"results": []}),
        ):
            trace = context_orchestrator.retrieve_context_trace("alpha beta gamma deployment", self.cwd)

        self.assertEqual([item["path"] for item in trace["injected"]], ["wiki/alpha.md"])
        skipped_reasons = " ".join(item["reason"] for item in trace["skipped"])
        self.assertIn("raw evidence disabled", skipped_reasons)
        self.assertIn("inject: never", skipped_reasons)

    def test_project_wiki_is_prioritized_before_global_wiki(self):
        project_file = {
            "file": "wiki/decisions/alpha.md",
            "title": "Project Alpha Decision",
            "content": "---\nname: Project Alpha Decision\ntype: decision\n---\n\nalpha beta gamma project decision",
            "body": "alpha beta gamma project decision",
        }

        with (
            mock.patch.object(context_orchestrator.memory_index, "index_memory", return_value=1),
            mock.patch.object(context_orchestrator.memory_index, "search_memory", return_value=[
                {"name": "wiki/decisions/alpha.md", "file": "wiki/decisions/alpha.md", "title": "Project Alpha Decision"}
            ]),
            mock.patch.object(context_orchestrator.memory_index, "get_memory_file", side_effect=lambda name, cwd: project_file if name == "wiki/decisions/alpha.md" else None),
            mock.patch.object(context_orchestrator.wiki_store, "search", return_value={
                "results": [{"id": "global-alpha", "title": "Global Alpha"}]
            }),
            mock.patch.object(context_orchestrator.wiki_store, "get_node", return_value={
                "id": "global-alpha",
                "title": "Global Alpha",
                "type": "reference",
                "body": "alpha beta gamma global wiki",
                "access_count": 100,
            }),
        ):
            trace = context_orchestrator.retrieve_context_trace(
                "alpha beta gamma decision",
                self.cwd,
                settings={"memoryInjectMaxItems": 1},
            )

        self.assertEqual(trace["injected"][0]["path"], "wiki/decisions/alpha.md")
        self.assertEqual(trace["retrieval_order"][0], "project canonical entry pages")

    def test_explicit_raw_request_allows_raw_fallback(self):
        raw_file = {
            "file": "raw/session.md",
            "title": "Raw Session",
            "content": "---\nname: Raw Session\ntype: raw\nsource: raw\n---\n\nalpha beta gamma raw evidence",
            "body": "alpha beta gamma raw evidence",
        }

        with (
            mock.patch.object(context_orchestrator.memory_index, "index_memory", return_value=1),
            mock.patch.object(context_orchestrator.memory_index, "search_memory", return_value=[
                {"name": "raw/session.md", "file": "raw/session.md", "title": "Raw Session"}
            ]),
            mock.patch.object(context_orchestrator.memory_index, "get_memory_file", side_effect=lambda name, cwd: raw_file if name == "raw/session.md" else None),
            mock.patch.object(context_orchestrator.wiki_store, "search", return_value={"results": []}),
        ):
            trace = context_orchestrator.retrieve_context_trace("show raw evidence for alpha beta gamma", self.cwd)

        self.assertTrue(trace["raw_allowed"])
        self.assertEqual(trace["raw_reason"], "explicit user request")
        self.assertEqual(trace["injected"][0]["path"], "raw/session.md")


if __name__ == "__main__":
    unittest.main()
