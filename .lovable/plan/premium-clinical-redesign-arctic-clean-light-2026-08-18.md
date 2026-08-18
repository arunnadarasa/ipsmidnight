# Premium clinical redesign — Arctic Clean Light

Reskin IPS Compass from the current dark midnight-navy console into a bright, clinical, premium light theme with real motion and depth. No functional or backend changes — presentation only.

## The look

- **Palette (locked)**: page `#f7fbfe`, ice surfaces `#dbeafe`, medical blue accent `#3b82f6`, deep navy ink `#0c4a6e`. Semantic status colours stay distinct: emerald healthy, amber caution, rose failure — tuned for a light background.
- **Type (locked)**: Outfit for headings (tight tracking, large display sizes), Figtree for body and UI, JetBrains Mono retained for digests, DIDs, addresses and log tails.
- **Mode**: light-first everywhere. The root shell drops its hard-coded `dark` class; a dark variant stays available through the existing `.dark` tokens.
- **Materials**: layered white cards on a faint ice mesh backdrop, hairline blue-tinted borders, soft two-stage shadows, gradient top-edge highlights on primary cards. Glass only where it sits over content (sticky headers, sheets), never as flat decoration.

## What changes on each surface

**Landing (`/`) — cinematic hero**
- Full-bleed hero: soft aurora mesh of blue/aqua, subtle grain, and an animated ECG trace that draws across the headline area then loops.
- Oversized Outfit headline, one-line value statement, primary and secondary CTAs, plus a live trust strip (FHIR IPS · Identus VCs · Midnight ZK anchor).
- A glass "console preview" card floating over the hero showing a mock anchor lifecycle.
- Scroll-revealed feature sections (staggered fade+rise), a three-step "digest → credential → anchor" flow diagram, and a trust/limitations band that keeps the honest wording already in place.
- Footer keeps the GitHub repo link.

**App chrome (`AppShell`)**
- Frosted sticky top bar with a hairline gradient underline and blur-on-scroll.
- Nav becomes a pill rail with an animated active indicator; mobile keeps the sheet, restyled.
- Page headers get eyebrow label + display title + supporting line, consistent across the seven app routes.

**Cards and panels (all `/app/*`)**
- One shared card treatment: rounded-2xl, hairline border, soft shadow, hover lift, gradient edge on the active/primary card.
- Metric tiles on the dashboard with animated count-up and small trend/status chips.
- Empty states get an illustrated icon medallion instead of plain text.

**Living status visuals**
- `StackTimeline`: connected rail with per-step state colour, pulsing ring on the booting step, animated progress fill, shimmer skeletons while polling, and a green settle animation when a step turns healthy.
- Stack/agent panels: pulse dot for healthy, sweeping shimmer for booting, steady rose for failed. Cause lines stay in mono with the copy button.
- `ContractLifecycle`: stage chips (written → compiled → deployed → anchored → confirmed) with a progress spine; log tail as a dark inset terminal panel — the one deliberately dark surface.
- Verify page: the pass list becomes vertical result cards with pass / fail / **not checked** states visually distinct, so the "signature not verified" and "no salt" states read as neutral-grey rather than green or red.

**Micro-interactions**
- Hover lift on cards, sheen sweep on primary buttons, animated tab/nav indicator, count-up numbers, toast restyle, focus rings in medical blue, `prefers-reduced-motion` respected throughout.

## Technical notes

- All colours re-defined as `oklch` tokens in `src/styles.css` (`:root` becomes the light theme, `.dark` gets the dark counterpart). New tokens: `--gradient-hero`, `--gradient-edge`, `--shadow-soft`, `--shadow-lift`, `--glass-bg`, plus `--color-info`/`--color-caution` mappings under `@theme inline`.
- New keyframes/utilities in `styles.css` via `@utility` (`hover-lift`, `sheen`, `pulse-ring`, `shimmer`, `ecg-draw`, `reveal`). No `tailwind.config.js`.
- Fonts swapped in the `__root.tsx` `head().links` Google Fonts URL to Outfit + Figtree + JetBrains Mono; `--font-display` / `--font-sans` updated in `@theme inline`.
- Glass uses Tailwind `backdrop-blur` utilities or the standard `backdrop-filter` property only — no hand-written `-webkit-` prefix.
- Reveal-on-scroll via a small `useReveal` IntersectionObserver hook in `src/components/ui`; no new dependencies.
- Head metadata per route refreshed with unique titles/descriptions while touching them.
- Components edited: `src/styles.css`, `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/components/AppShell.tsx`, `src/components/SectionHeading.tsx`, `src/components/MonoValue.tsx`, `src/components/deploy/StackTimeline.tsx`, `src/components/deploy/ContractLifecycle.tsx`, and the seven `app.*.tsx` routes plus `auth.tsx` for the new card/state treatments.
- No changes to server functions, migrations, RLS, Fly provisioning, or verification logic.
