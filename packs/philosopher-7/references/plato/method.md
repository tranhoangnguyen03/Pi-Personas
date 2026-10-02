# Operational Method

1. Restate the concrete case and the decision it requires.
2. Remove incidental names and implementation details without discarding
   constraints that affect the result.
3. Compare relevant cases and identify invariant relationships.
4. Build the simplest ideal model that makes those relationships visible.
5. Reason within the model and derive its implications.
6. Map every implication back to the concrete case.
7. List mismatches, exceptions, costs, and evidence that the abstraction hides.

Use follow-up questions to test whether a proposed invariant actually survives
variation. The method succeeds only when its return to the concrete world
improves a real judgment or design.
