# AfterHours: Fix the Process Behind the Wrong Numbers

Discussion proposal, not an implementation commitment.

## The problem with the current pitch

An AI that reads documents and corrects accruals is useful, but existing accounting products already cover much of that workflow. More accounting features or more agents would not automatically make AfterHours distinctive.

## Recommended main feature

**Find an accounting error, identify the calculation or import rule causing it, propose a repair, and demonstrate that the repair works.**

Instead of correcting entries individually, AfterHours investigates why multiple entries went wrong and helps prevent the same mistake next month.

Target user: a finance systems or finance operations team maintaining financial imports and reconciliation calculations.

## Example demo

This is an illustrative scenario using synthetic records, not an implemented capability or measured result.

1. Several existing accruals appear inflated.
2. The agent inspects the supporting invoices, ledger records, and imported calculation.
3. It discovers that the calculation treats unpaid invoices as unrecorded, although the ledger shows those invoices were posted.
4. It proposes a targeted repair to distinguish payment status from posting status.
5. It reruns the affected cases in an isolated copy and shows the before-and-after amounts with supporting evidence.
6. It checks counterexamples: draft invoices remain excluded, and unrelated cases remain unchanged.
7. A human reviews the proposed repair and its financial consequences before accepting it. Accounting corrections still require their own approval.

**Pitch: AfterHours fixes the financial mistake—and the broken process that would repeat it next month.**

## Why this direction is stronger

| Dimension | Assessment |
| --- | --- |
| Technical depth | Investigation, generated repair, execution, and verification form a meaningful agent workflow. |
| Creativity | Combines financial reasoning with software repair rather than adding another accounting chatbot. |
| Practical value | Addresses recurring errors in the calculations and mappings finance teams maintain. |
| Demo appeal | Shows multiple incorrect results traced to one cause, followed by a tested repair. |

These are design assessments, not validated customer demand or predictions of winning a prize.

## Minimum scope

- Support one calculation or import format with a small, explicit set of repair operations.
- Use synthetic source records and a deliberately faulty example of an existing calculation.
- Preserve original files and posted accounting history.
- Show the proposed change, affected cases, financial differences, and verification results.
- Test against known expected results; a balanced journal alone does not establish correctness.
- Require human approval before accepting a repair. Do not automatically deploy changes or post entries.
- Label live model runs and any simulated or replayed behavior clearly.

Defer general-purpose ERP repair, additional accounting workflows, extra providers, and unrelated integrations.

This changes the current document-storage/accrual-correction scope. Investigation, repair generation, isolated execution, and replay would need to be built; they are not current capabilities.

## Sponsor relevance

- **Hyphenate:** a concrete autonomous finance workflow with human control.
- **Factory:** a meaningful coding task—proposing and testing a calculation or import repair.
- **Bitdeer:** document extraction that supplies evidence for the investigation, if actually used.

These are proposed alignments, not confirmed eligibility. Check the [official track requirements](https://cal-hacks-13-0.devpost.com/) before submitting.

## Competition and limits

Existing products already advertise [unbilled-expense investigation and outreach](https://www.auditoria.ai/solutions-brief-advanced-accruals-for-suppliers/), [shared-root-cause exception investigation](https://www.trintech.com/news/trintech-launches-three-new-ai-agents-to-advance-governed-autonomous-finance/), and [SLA-credit recovery](https://www.nextsignal.io/).

The distinction worth demonstrating is **generating, testing, and replaying a concrete repair**, beyond identifying the discrepancy. This research does not establish that no competitor offers that capability; do not claim a world first.

The main risks are proposing the wrong repair, overfitting to the demo, and making verification depend on the same mistaken assumptions as the original calculation. A convincing prototype must pass counterexamples and explain when it cannot safely repair a case.

## Backup direction

**Prove an entry is wrong despite missing information.** Calculate outcomes under explicitly supported alternative interpretations, identify the minimum guaranteed error within those assumptions, and investigate the missing fact with the largest financial effect.

This is technically interesting but less immediately striking. Keep it as an alternative, not an additional MVP feature.

## Recommendation

Build one complete investigation → proposed repair → isolated replay → human review demonstration. Validate the workflow with someone who maintains financial calculations before expanding the scope.
