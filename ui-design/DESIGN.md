# AIOS Frontend Design Contract

This project follows the AIOS Design System.

## Source Of Truth

- Authoritative design system: the AIOS design-system markdown document in `ui-design/`

## Product Identity

- Treat the UI as an AIOS operations console, not as a product-branded marketing surface.
- Product names, subsystem names, logos, and menu titles are implementation content. They must be supplied by the host application, not hard-coded into the design system.
- Header identity should use the host application's real image/SVG mark when a brand is available. Do not replace missing brand assets with plain text pretending to be a logo.
- The primary module rail represents product-level modules. Single-module products should show one active module entry; multi-module products may add peers only when they map to real top-level product areas.
- Leaf pages should be flattened into second-level menu items when each group contains only one child. Use third-level menus only when a group has multiple peer destinations.

## Required Surface

- Light console theme by default.
- Page background: `#F1F4F9`.
- Panels, navigation, popovers, and dialogs: white surfaces.
- Primary blue `#5882FC` is reserved for clickable affordances, active states, links, and key metrics.
- Status colors are semantic and stable: success `#67C23A`, warning `#E6A23C`, danger `#F56C6C`, info `#909399`.
- Default data density is compact: `12-14px` text, `32px` controls, `10px` panel radius, `10-16px` panel padding.
- Tables, filters, monitoring panels, status tags, and confirmation dialogs take precedence over decorative visuals.
- Desktop shell uses a full-width `49px` header first, then a `50px` primary module rail plus a `180-200px` secondary menu below it. White surfaces are separated by `#DCDFE6`.
- Primary module icon size is `18px`; secondary menu icons are `14px`. Icons use a simple line style and semantic colors.
- Active primary module uses a left `2px` primary edge. Active secondary menu uses primary text plus a `3px` primary edge, not a rounded pill.
- Management pages use list anatomy: search toolbar, Element-style table header, fixed operation column when actions exist, and compact pagination.
- All list tables use one shared Element-style table primitive: `#F1F5FE` header, `#EBEEF5` row rules, `12-13px` text, `35-40px` header rows, `44-48px` body rows, right fixed operation column, and no custom per-page table chrome.
- Management list pages use one title line only, such as `模块 / 当前页面`, at `16px/24px`, `700`, with no separate `h1` and no unrelated right-side health summary in the content heading.
- Main content padding for list pages is target-aligned: `24px` horizontal page padding, `22-24px` top/bottom padding, `20px` breadcrumb-to-card spacing, and one rounded white list card.
- The list card owns toolbar, table, and pagination: `20px` card padding, `12px` toolbar-to-table gap, no internal browser-style horizontal scrollbar at desktop target widths, and pagination right-aligned inside the card bottom.
- Element pagination order is fixed: total count, page-size select, previous icon, page buttons, next icon, `前往 [input] 页`. Do not use split left/right pagination or `1-15 / total` copy in management list pages.
- Non-statistic information cards use the shared `.paas-info-card` primitive: default background `#EFF3FF`, hover background `#F5F5F5`, `8px` radius, and `150ms` background transition. Apply this to compact status, metadata, and read-only information cards that present state rather than numeric KPI trends. Statistic/KPI cards keep their own metric-card styling and must not silently inherit this primitive.

## Prohibited Drift

- No hard-coded product, tenant, or subsystem branding in shared design-system components.
- No plain text replacement for a missing logo in the header.
- No dark/hero-first observability dashboard styling for the default AIOS console experience.
- No neon cyan/purple accents, glow text, glass blur panels, or marketing gradients.
- No extra primary-module rail entries unless they represent real top-level product areas.
- No nested third-level menu for pages that already map one-to-one to a second-level leaf.
- No color-only status indication; pair state with text or icons.
- No destructive action without confirmation or explicit warning copy.
- No ad-hoc background utilities for non-statistic information cards; use `.paas-info-card` so default and hover states remain consistent.
