"""Local in-memory note contracts."""


def validate_id(value):
    """Return value when it is a positive int (bool excluded); raise ValueError otherwise."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"invalid note id: {value!r}")
    return value
