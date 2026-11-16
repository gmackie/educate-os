# Teacher board

A source-card UI and bounded preparation storage shared by the Week Ahead, Research Kit and Assignment Companion blueprints. No source records are persisted; only teacher-authored notes and checklist items enter gadget storage. Sample records are opt-in and labeled. Each blueprint owns its connector adapter and example data. Sharing a blueprint copies code, not preparation storage. Explicitly save notes; concurrent editors use last-save-wins semantics. No subscriptions or acquired RPC stubs are retained.
