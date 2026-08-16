# Mobile UX improvements

The screenshot shows the core problem: on a narrow phone the page heading collapses to "Int..." while the action buttons sit beside it, squeezing the description into a one-word-per-line column. Several other console pages share the same header pattern, so the fix is mostly in shared components plus a few page-level touches.

## What changes

### 1. Page and panel headings stack on mobile
- `SectionHeading`: on phones, title/description take the full width and actions drop onto their own row underneath (full-width buttons in a 2-up row), switching to the side-by-side layout from `sm:` up. Remove the `truncate` on the title so long titles wrap instead of becoming "Int...".
- `Panel` header: same treatment — title on one line, actions wrapping below on phones.

### 2. Dashboard
- "Provision stack" and "New summary" become equal-width buttons on one row below the heading, instead of competing with the title.
- Stat cards go 2-up on phones (currently 1-up), so the fold shows more.

### 3. Tab bars scroll instead of clipping
IPS, Identus and Deploy pages use tab bars that can exceed the screen width. Make the tab strip horizontally scrollable with no visible scrollbar and no page-level horizontal overflow.

### 4. Long identifiers, hashes and JSON
DIDs, digests and contract addresses are long mono strings. Ensure they wrap/scroll inside their container (`break-all` for inline values, `overflow-x-auto` for `pre` blocks) so no page scrolls sideways.

### 5. Touch targets and forms
- Buttons and inputs in the builder, deploy and Midnight/Identus panels get comfortable phone heights and full-width behaviour where they currently sit in cramped rows.
- Number/text inputs keep the correct mobile keyboard types where relevant.

### 6. Mobile chrome
- Sticky top bar on mobile (currently scrolls away) so the menu button is always reachable.
- Slightly tighter page padding on phones to reclaim horizontal space.

## Technical notes
- Files touched: `src/components/SectionHeading.tsx`, `src/components/AppShell.tsx`, `src/components/MonoValue.tsx`, `src/routes/app.index.tsx`, `src/routes/app.ips.tsx`, `src/routes/app.identus.tsx`, `src/routes/app.midnight.tsx`, `src/routes/app.deploy.tsx`, `src/routes/app.verify.tsx`, `src/routes/app.activity.tsx`, `src/components/ips/*`, `src/components/identus/FlyAgentPanel.tsx`.
- Presentation-only: no server functions, schema, or business logic changes.
- Pattern followed everywhere: `grid-cols-[minmax(0,1fr)_auto]` only when both cells genuinely fit; otherwise stack on mobile and promote to flex at `sm:`, with `min-w-0` on text containers and `shrink-0` on icons.
- Verification: run the pages at 384px wide in a headless browser and confirm no horizontal overflow and readable headings.
