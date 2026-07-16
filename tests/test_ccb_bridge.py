import unittest

import ccb_bridge


class CCBBridgeSessionIdTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_drops_pending_resume_id(self):
        session = ccb_bridge.CCBSession()
        await session.start(cwd=".", resume_id="pending-1784179868124")
        self.assertIsNone(session.session_id)

    def test_native_session_id_validation_requires_uuid(self):
        self.assertFalse(ccb_bridge.is_valid_native_session_id("pending-1784179868124"))
        self.assertTrue(ccb_bridge.is_valid_native_session_id("550e8400-e29b-41d4-a716-446655440000"))


if __name__ == "__main__":
    unittest.main()
