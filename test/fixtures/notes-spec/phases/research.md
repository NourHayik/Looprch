# Engineering research - training fixture
Research date: 2026-09-23. This is a local example of the package format, not live deployment evidence.
<!-- research: RES-001 -->
## RES-001: minimal standard-library design
Use a pure identifier validator, explicit ValueError/KeyError contracts and Python's unittest discovery for the small local scope. Dictionary storage is deliberately transient. No database, HTTP stack or dependency installer is necessary; adding one would change scope rather than improve this example. Exact runtime selection for a real project requires current compatibility research.
Primary sources: https://docs.python.org/3/library/unittest.html and https://docs.python.org/3/library/exceptions.html . This fixture exercises toolkit contracts with synthetic workers; it does not benchmark or authenticate any AI provider.
<!-- /research: RES-001 -->
