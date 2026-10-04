# In-memory notes capability
<!-- req: R-NOTE -->
Publish NoteStore with put(id, text), get(id), and delete(id). Each operation calls validate_id. Text must be a nonempty string; reject invalid text with ValueError. put creates or replaces the value for one valid id. get and delete raise KeyError for absent valid ids. Failed operations leave other notes unchanged. Stores are independent. Never promise persistence across process exit. This consumer needs R-ID's ValueError and bool rejection, not a new identifier subsystem.
