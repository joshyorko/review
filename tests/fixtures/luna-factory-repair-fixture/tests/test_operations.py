import unittest

from operations import subtract


class SubtractTests(unittest.TestCase):
    def test_positive_operands(self):
        self.assertEqual(subtract(9, 4), 5)

    def test_negative_result(self):
        self.assertEqual(subtract(-2, 3), -5)


if __name__ == "__main__":
    unittest.main()
