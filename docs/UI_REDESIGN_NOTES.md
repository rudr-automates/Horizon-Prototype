# Horizon UI redesign and design review

## Direction

PS1 is the selected competition problem statement. Horizon stays an evidence-first recorded-lesson assistant. The screen's signature relationship is the lesson clock → eligible evidence → question → grounded answer or refusal → citation.

The existing Midnight Aurora interface and its measured semantic tokens are coherent and documented in `src/app/globals.css`. I refined that system rather than replacing the visual identity: the long-session reading surfaces stay opaque; the restrained periwinkle remains a link/action color; status colors retain their operational meaning; the video remains the main visual content.

## Skill use

- **Impeccable 4.6.0:** installed project-locally at `.agents/skills/impeccable`. Read its product-init, new-work, shape and craft-floor guidance; created `PRODUCT.md`; ran its one-pass detector on the learner workspace, styles and route components. The detector found a two-pixel colored side border on a citation quote. It is now a one-pixel neutral border. The direct `/impeccable init` chat command cannot be invoked from this terminal surface; the installed skill and references were applied in-thread. The installer added `.codex/hooks.json` for edit and stop events. Those hooks are not active in this session; approve them with Codex `/hooks` and reload the project session to enable automatic scans.
- **Taste Skill:** current project-local `design-taste-frontend` copy installed at `.agents/skills/design-taste-frontend`; read its app-screen workflow. Its first direction run offered a light achromatic ledger and an editorial greeting. The ledger's no-brand-color/light treatment conflicts with the incumbent dark identity and the long-session product context, so I kept its useful data-first, restrained-chrome guidance and preserved Horizon's existing palette/type. Its browser inspector requires Chrome, Edge or Chromium; none is installed or exposed in this session, so no fresh browser review is claimed.
- **UI/UX Pro Max:** installed project-locally at `.agents/skills/ui-ux-pro-max`. Its first automated profile matched Horizon to a generic language-learning landing page and returned testimonials, a childlike palette and display fonts. Those parts were rejected. Focused searches were then used for learning workspace guidance, keyboard focus, reduced motion, error recovery and Next.js App Router boundaries. The generated `MASTER.md` was rewritten against the actual CSS tokens and product behavior, and `pages/workspace.md` records the route-specific hierarchy.

## Implemented refinements

- `AssistantPanel` now exposes the live “through mm:ss” evidence boundary as the question field's accessible description. This makes the asked-at scope relationship available to assistive technology as the playback clock changes.
- Citation quotations now use a thin neutral outline rather than a heavy colored side rail. The quote remains clearly contained without overusing the brand accent.
- `Pill` accepts an optional `id` for a semantic association where a status pill describes another control.
- `PRODUCT.md`, `DESIGN.md`, and the persisted UI/UX Pro Max design system now record the product truth and current interface tokens rather than generic generated suggestions.
- ESLint now excludes the project-local vendored skill/script folders. Their CommonJS and standalone helper scripts are not application code; they caused unrelated rule errors after installation. The app source remains linted.

## Review evidence and limits

The repository has dated browser captures and responsive results in `docs/UI-AUDIT.md` and `docs/EVALUATION.md`; those remain historical evidence, not a fresh review of this change. The current CUA surface exposed no browser and no Chrome/Edge/Chromium executable was found at the standard install locations. Source inspection and automated build checks are available; fresh visual captures at 360, 390, 768, 1024 and 1440 pixels were not possible in this environment.

The connected Supabase project was read-only inspected. Its tables have RLS enabled and no policies, so browser roles do not gain row access. The six mutable-search-path advisor findings apply to `SECURITY INVOKER` search/eligibility functions; the application uses the service role through the server path, and RLS remains deny-by-default. No shared database change is proposed. Four unindexed foreign keys and one unused rate-limit index are low-volume advisor findings, not demonstrated MVP failures.

## Trade-offs

- The three installed skills do not agree on palette or composition. Product truth and the incumbent measured tokens take precedence; no child-oriented or testimonial-oriented visual system was introduced.
- No model, provider, migration, production, deployment or GitHub mutation was performed as part of this redesign.
- Mock interviews remain optional PS1 extension scope; this work keeps the existing learning flow focused.
