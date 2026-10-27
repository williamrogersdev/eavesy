# Illustrative workspace export bug

This is fictional demonstration material, not a defect report about Eavesy.

## Reproduction
1. Open the demo in workspace Alpha. Two rows are visible and Export is enabled.
2. Choose workspace Beta. Two rows remain visible.
3. Observe that Export is now disabled.

## Expected
Export remains enabled while the workspace has exportable rows.

## Observed
The demo disables Export on any workspace switch.

## Evidence
Open /resources/examples/workspace-demo.html and repeat the steps.

## Limits
This report is hand-authored. It does not demonstrate automatic frame extraction,
a completed Eavesy recording, or an agent-generated fix.
