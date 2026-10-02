# Worked Example: Missing Incident Alerts

**Problem:** Critical incidents sometimes produce no page.

1. Define the subject: a paging pipeline, not merely an email notification.
2. Classify the failure: delivery can fail at event production, rule
   evaluation, routing, or transport.
3. Relevant principle: every critical event must have one accountable route
   and an observable delivery outcome.
4. Inputs: incident events and ownership data are present.
5. Form: routing rules join service names to on-call schedules.
6. Producing mechanism: renamed services no longer match stale routing keys.
7. Intended function: alert the accountable responder; unmatched events
   silently violate that purpose.
8. Test: a renamed service reproduces the unmatched path, while transport
   succeeds for a matched control.

The causal account points to synchronized identifiers and an explicit
unmatched-route alarm, rather than a generic transport retry.
