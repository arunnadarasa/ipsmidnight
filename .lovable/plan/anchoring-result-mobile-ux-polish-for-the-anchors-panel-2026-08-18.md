# Anchoring result + mobile UX polish for the Anchors panel

## Did it work?

Yes. The second screenshot shows the anchor reaching `anchored` with `undeployed block #591` and a real tx hash (`006432dbdb…55…`), after the deploy step completed. That is the runner successfully proving and submitting `anchorSummary` with the commitment only. It is not yet promoted to `confirmed` — that state is only set after a separate ledger-membership check ("Check ledger"), so the honest reading today is "written in block #591, membership not re-verified".

## Mobile UX problems visible in the screenshots

1. The status dot stays amber even when the row says `anchored`, because the dot only turns green on `confirmed`. Looks like a failure when it isn't.
2. On a 384px screen the row is a two-column grid: the action buttons take a fixed right column, squeezing status chips, commitment and tx onto 2-3 wrapped lines each, and the buttons render oversized/misaligned.
3. The full-width `Submit` button remains primary and enabled after a successful anchor, inviting a pointless re-anchor.
4. The inline timeline + runner log sit inside the narrow left column, so log lines wrap hard.

## Changes

Anchors list row (`src/routes/app.midnight.tsx`):
- Stack the row on mobile: single column with the metadata block first and a full-width action row underneath; restore the side-by-side grid from `sm:` upward.
- Status treatment: distinct visual states for `queued` / `proving` (amber, pulsing), `anchored` (blue/primary, "on ledger"), `confirmed` (green), `error` (destructive). Dot and badge derive from one shared mapping so they never disagree.
- Compact meta line: network and block collapse into one wrapped `text-xs` line; commitment and tx keep truncation with copy buttons and get `min-w-0` so they truncate rather than wrap.
- Actions: buttons become a 2-up grid full width on mobile, `size="sm"` with equal height. Once `anchored`/`confirmed`, `Submit` demotes to a secondary "Re-anchor" and `Check ledger` becomes the primary call to action.
- Timeline/log block moves out of the metadata column to span the row's full width on mobile so the runner log and Copy log controls get the whole viewport width.

Queue buttons:
- Bundle "Queue …" buttons truncate long titles instead of stretching the row.

No backend, contract, or anchoring-logic changes — presentation only.
