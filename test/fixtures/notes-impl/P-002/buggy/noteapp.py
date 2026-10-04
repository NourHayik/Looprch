"""Local in-memory note contracts (first attempt with a bug: delete ignores absent ids)."""


def validate_id(value):
    """Return value when it is a positive int (bool excluded); raise ValueError otherwise."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"invalid note id: {value!r}")
    return value


class NoteStore:
    def __init__(self):
        self._notes = {}

    def put(self, note_id, text):
        note_id = validate_id(note_id)
        if not isinstance(text, str) or not text:
            raise ValueError("text must be a nonempty string")
        self._notes[note_id] = text

    def get(self, note_id):
        note_id = validate_id(note_id)
        return self._notes[note_id]

    def delete(self, note_id):
        note_id = validate_id(note_id)
        self._notes.pop(note_id, None)
