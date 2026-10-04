# Stable note identifier contract
<!-- req: R-ID -->
Publish validate_id(value) returning the same positive integer for valid input. Reject zero, negative values, strings, floats, None and booleans with ValueError. Validation is deterministic and has no side effects. All note operations consume this contract; exceptions must not mutate stored data. Renaming this function or changing the exception type is a breaking contract change. P-001 owns the implementation; P-002 consumes it.
