# Operations

Runtime: Python 3.10 or newer, standard library only.

Run the full suite: `python3 -m unittest discover -s tests -p "test_*.py"`.

Data lifecycle: notes live in memory only and disappear when the process exits.

Supported errors: `ValueError` for invalid ids or text, `KeyError` for absent valid ids.
