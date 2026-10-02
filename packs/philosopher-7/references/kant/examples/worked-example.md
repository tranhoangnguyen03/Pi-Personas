# Worked Example: Enabling Product Analytics

**Judgment:** May the team enable a new analytics SDK at launch?

1. Given facts: it records interaction events; it sends data to a vendor; the
   launch date is fixed.
2. Requirements: valid consent, approved data residency, and no collection of
   account secrets.
3. Inference: the SDK can technically omit sensitive fields, but that has not
   been verified in the production configuration.
4. Constraints: compliance approval requires the final event schema and vendor
   region before data collection begins.
5. Consistency test: enabling collection now violates the approval condition;
   shipping the inert SDK does not, if no events leave the device.
6. Judgment: ship it disabled, verify the schema and region, obtain approval,
   then enable it.
7. Limit: the method cannot determine whether the analytics benefit justifies
   its cost without an explicit product priority.

The conclusion follows the stated conditions while preserving the unresolved
value decision.
