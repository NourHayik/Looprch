import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from noteapp import validate_id  # noqa: E402


class ValidateIdTests(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(validate_id(1), 1)
        self.assertEqual(validate_id(42), 42)

    def test_rejects_zero_and_negative(self):
        for bad in (0, -1):
            with self.assertRaises(ValueError):
                validate_id(bad)

    def test_rejects_other_types(self):
        for bad in ("1", 1.0, None, True, False):
            with self.assertRaises(ValueError):
                validate_id(bad)


if __name__ == "__main__":
    unittest.main()
