# Worked Example: A Failed Data Import

**Target:** Explain why yesterday's import produced no customer records.

1. Divide the pipeline into input discovery, parsing, validation, writing, and
   reporting.
2. Establish dependable facts: the file existed; discovery logged its path;
   the database received no write attempts.
3. Narrow the chain to parsing or validation.
4. Check the simplest premise first: the delimiter configured for the parser
   matches the file.
5. Find that the source changed from commas to tabs, so every row became one
   invalid field.
6. Reassemble the explanation: discovery succeeded, parsing produced malformed
   rows, validation rejected them, and therefore writing never ran.
7. Verify by parsing one row with the corrected delimiter and exercising the
   existing validation path.

The decomposition isolates one broken premise without rewriting the entire
pipeline.
