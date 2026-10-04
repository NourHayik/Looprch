import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from noteapp import NoteStore  # noqa: E402


class NoteStoreTests(unittest.TestCase):
    def test_put_get_overwrite(self):
        s = NoteStore()
        s.put(1, "a")
        s.put(1, "b")
        self.assertEqual(s.get(1), "b")

    def test_delete_and_absent(self):
        s = NoteStore()
        s.put(2, "x")
        s.delete(2)
        with self.assertRaises(KeyError):
            s.get(2)
        with self.assertRaises(KeyError):
            s.delete(2)

    def test_invalid_input_does_not_mutate(self):
        s = NoteStore()
        s.put(3, "keep")
        for bad in (0, True, "3"):
            with self.assertRaises(ValueError):
                s.put(bad, "x")
        with self.assertRaises(ValueError):
            s.put(3, "")
        self.assertEqual(s.get(3), "keep")

    def test_independent_stores(self):
        a, b = NoteStore(), NoteStore()
        a.put(1, "a")
        with self.assertRaises(KeyError):
            b.get(1)


if __name__ == "__main__":
    unittest.main()
