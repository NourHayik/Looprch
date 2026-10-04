import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class OperationsDocTests(unittest.TestCase):
    def test_operations_doc_exists(self):
        text = open(os.path.join(ROOT, "OPERATIONS.md"), encoding="utf-8").read()
        self.assertIn("python3 -m unittest", text)
        self.assertIn("KeyError", text)

    def test_no_network_imports(self):
        src = open(os.path.join(ROOT, "noteapp.py"), encoding="utf-8").read()
        for mod in ("socket", "urllib", "http"):
            self.assertNotIn(f"import {mod}", src)


if __name__ == "__main__":
    unittest.main()
