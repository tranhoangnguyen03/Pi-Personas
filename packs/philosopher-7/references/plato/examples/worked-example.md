# Worked Example: Three Approval Systems

**Cases:** Editorial review, expense approval, and production deployment use
different tools and titles.

1. Remove incidental labels and retain the shared structure: a proposer, a
   change, a risk boundary, an accountable reviewer, and an auditable outcome.
2. Identify the invariant: review should be independent enough for the risk,
   informed enough to judge it, and proportional to the cost of delay.
3. Ideal model: route by risk; declare the decision owner; preserve evidence;
   escalate exceptions.
4. Derive implications: low-risk changes may be self-approved under automated
   constraints; high-risk changes need an independent qualified reviewer.
5. Map back: editorial reputational risk, financial limits, and deployment
   blast radius require different classifiers and evidence.
6. Mismatches: emergencies may bypass the ordinary path, so retrospective
   review and explicit exception logging are needed.

The abstraction yields a common design without pretending the three domains
have identical risks.
