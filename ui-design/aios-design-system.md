# AIOS Design System

AIOS Design System defines a reusable interface language for operations, monitoring, resource management, workflow administration, and data-heavy product surfaces. It is intentionally brand-neutral: product names, tenant names, subsystem labels, logos, and route names belong to the host application, not to the shared design system.

The system is optimized for long-running operational work: dense but readable information, predictable navigation, clear state feedback, and compact controls. It should feel professional, calm, stable, and data-first.

## Design Character

AIOS interfaces are work surfaces. They prioritize scanning, comparison, triage, and repeated action over visual decoration.

Keywords: professional, compact, stable, data-first, low ornament, strong feedback.

Use light workbench surfaces by default. White panels carry content; blue is reserved for interaction, selection, links, and key metrics. Avoid marketing-style heroes, oversized decorative cards, neon accents, glow effects, glass panels, and broad gradients.

## Foundation Tokens

### Color

| Token | Value | Usage |
| --- | --- | --- |
| `--aios-color-primary` | `#5882FC` | Links, active states, selection edges, highlighted icons, key metrics |
| `--aios-color-primary-hover` | `rgba(88,130,252,0.8)` | Primary hover |
| `--aios-color-primary-active` | `rgba(88,130,252,0.9)` | Primary pressed |
| `--aios-color-primary-bg` | `rgba(88,130,252,0.1)` | Light primary background for tags and weak emphasis |
| `--aios-color-text` | `#606266` | Default body text |
| `--aios-color-info` | `#909399` | Secondary information, muted icons, helper text |
| `--aios-color-disabled` | `#C0C4CC` | Disabled, placeholder, low-priority text |
| `--aios-color-border` | `#DCDFE6` | Default border |
| `--aios-color-page` | `#F1F4F9` | Workbench page background |
| `--aios-color-surface` | `#FFFFFF` | Panels, navigation, popovers, dialogs |
| `--aios-color-hover` | `#F5F5F5` | Table row, menu item, and tool hover |
| `--aios-color-active` | `#F2F4F5` | Menu and tab active backgrounds |
| `--aios-color-table-header` | `#F1F5FE` | Table header background |
| `--aios-color-table-row` | `#FAFAFA` | Striped (odd-row) background — very light gray |
| `--aios-color-table-row-alt` | `#F1F5FE` | Striped (even-row) background — same as header for visual rhythm |
| `--aios-color-success` | `#67C23A` | Normal, running, success |
| `--aios-color-warning` | `#E6A23C` | Warning |
| `--aios-color-danger` | `#F56C6C` | Error, abnormal, destructive |

Primary blue must not become decoration. Use it only for clickable affordances, selected states, links, and key values.

### Typography

Default font stack:

```css
font-family: Tahoma, Helvetica, Arial, Verdana, "Microsoft YaHei", SimSun, 宋体;
```

Do not replace the final Chinese fonts with a generic fallback. The stack is tuned for mixed Chinese and English operational UIs.

| Token | Value | Usage |
| --- | --- | --- |
| `--aios-font-xs` | `12px` | Tags, table helper text, state descriptions |
| `--aios-font-sm` | `13px` | Default body, table cells, navigation items |
| `--aios-font-md` | `14px` | Menu items, form labels, local section titles |
| `--aios-font-lg` | `16px` | Page titles, important section titles |
| `--aios-font-xl` | `18px` | Metric numbers, dialog titles, important values |

Weights: body `400`, emphasized menu/link text `500`, titles and key numbers `700`.

### Radius, Border, Shadow

| Token | Value | Usage |
| --- | --- | --- |
| `--aios-radius-control` | `4px` | Inputs, selects, buttons, tags, tabs |
| `--aios-radius-panel` | `10px` | Cards, global containers, business panels |
| `--aios-border` | `1px solid #DCDFE6` | Inputs, cards, tables, menu separators |
| `--aios-border-primary-2` | `2px solid #5882FC` | Primary module active edge |
| `--aios-border-primary-3` | `3px solid #5882FC` | Secondary menu active edge |
| `--aios-shadow-panel` | `0 0 12px 0 rgba(0,0,0,0.12)` | Main panels, floating layers, side menus |
| `--aios-shadow-popper` | `0 2px 12px 0 rgba(0,0,0,0.1)` | Dropdowns, select poppers |

Controls use small radius. Containers use larger radius. Avoid large pill-shaped navigation items unless a host product explicitly defines them.

### Spacing

AIOS uses a compact spacing rhythm:

| Value | Usage |
| --- | --- |
| `4px` | Icon/text gap, compact form gaps |
| `8px` | Tool padding, compact card padding, search-area bottom gap |
| `10px` | Panel padding, global container padding |
| `12px` | Toolbar-to-table gap, compact horizontal control gap, table cell vertical padding |
| `14px` | Table cell horizontal padding (Element `.cell` convention; the leftmost/rightmost column edge uses the same 14px) |
| `16px` | Module spacing, standard content spacing |
| `20px` | Dialog body padding, list-card padding |
| `24px` | Page horizontal padding |
| `32px` | Large panel inner compensation spacing |

## Layout System

### Shell

AIOS shell uses a three-part desktop structure:

- Header: full-width, top-aligned, `49px` high, white background, bottom `1px` divider, light shadow.
- Primary module rail: `50px` wide, starts below the header, white background, icon-led top-level modules.
- Secondary menu: `180-200px` wide, starts below the header, white background, function groups and leaf destinations.
- Main content: fills the remaining area, background `#F1F4F9`, with white panels for content.

Header identity must be supplied by the host application. If a real image or SVG logo exists, use it. Do not fake a logo with ordinary text in shared shell components.

Header tools may include workspace switch, platform switch, search, notifications, preferences, language, theme, and user entry. Do not place page-specific business metrics in the header; metrics belong in page content.

### Content Density

The main content area should not use a large hero. A typical first screen is:

1. Breadcrumb or one-line page title.
2. Metric or resource summary cards when useful.
3. Search and filter toolbar.
4. Data panels: tables, charts, monitoring panels, event lists, or alert lists.

### Management List Anatomy

Management pages use a single-title, single-card list structure:

- Title: one line only, such as `模块 / 当前页面`; `16px / 24px`, `700`, `#606266`.
- No duplicate `h1` below the breadcrumb.
- Page padding: `24px` left/right, `22-24px` top/bottom.
- Title-to-card gap: `20px`.
- List card: white background, `10px` radius, `#DCDFE6` border, `20px` padding.
- Toolbar: inside the list card, `32px` controls, `10-12px` control gap, `12px` gap to table.
- Table: prefers fitting desktop target width; use ellipsis, tooltip, or compressed secondary information before adding visible horizontal scroll.
- Table viewport: the table region owns a fixed-height scroll area. The viewport MUST scroll vertically (`overflow-y: auto`, `overflow-x: hidden`) so that every row in the current page is reachable. `overflow: hidden` on the viewport clips rows and is a bug — it must never be used as the table's own scroll policy (it is only valid on the outer list-card to clip rounded corners).
- Pagination: bottom-right inside the card, with enough white space after the final table row. Pagination height is `44px` (matching the Element UI reference `el-pagination`), reserved as a fixed region below the scrollable viewport so it never competes with rows for vertical space.
- Pagination order: `共 N 条` / page-size select / previous icon / page buttons / next icon / `前往 [input] 页`.

Do not split pagination into left and right zones, and do not use range copy such as `1-15 / total` as the primary pagination text.

## Navigation

### Top Navigation

- Background `#FFFFFF`.
- Height `49px`.
- Text `13px`, `#606266`.
- Tool button width around `36px`.
- Hover background `#F2F4F5`.
- Icons `14-20px`, simple line style.

### Primary Module Rail

- Width `50px`; legacy compact implementations may use `49px`.
- White background with `1px solid #DCDFE6` separator on the content side.
- Item height `38-40px`.
- Icon size around `18px`.
- Default color `#393B3E` or `#606266`.
- Hover: `#F5F5F5` background, primary text/icon.
- Active: shallow active background or white, primary text/icon, left `2px solid #5882FC` edge.
- Adjust active item padding so the icon does not jump when the edge appears.
- When content overflows, show a narrow scrollbar only on hover.

Single-module products should show one active module. Multi-module products may add peer modules only when each maps to a real top-level product area.

### Secondary Menu

- Width `180-200px`.
- White background, not a floating card.
- Right border `1px solid #DCDFE6`.
- Header area: `8px 10px 8px 16px`, title `14px`, `700`, single-line ellipsis.
- Menu body padding `8px`.
- Menu item height `36-40px`.
- Text `13-14px`, `#393B3E`.
- Optional description text `12px`, `#909399`, left margin `4px`.
- Long labels always use single-line ellipsis and tooltip on hover.

Active leaf items use primary text plus a left `3px solid #5882FC` edge and local shallow background. Do not use full-row blue blocks or large rounded pills.

Use a third menu level only when a group contains multiple peer pages. If a group has a single destination, flatten it to a second-level leaf.

### Menu Interaction

- Clicking a primary module changes active state, swaps the secondary menu tree, and navigates to the module default leaf when available.
- Clicking a group title expands or collapses children without changing the active primary module.
- Clicking a leaf updates active state and navigates or refreshes content.
- Hover gives immediate shallow feedback.
- Active state must not rely on color alone; keep the active edge.
- Collapsing the secondary menu preserves the primary rail and remembers the selected item and scroll position.
- Long menu names use tooltip; tooltip must not change menu width.
- Keyboard support: Tab to focus, Enter to trigger, Esc to close overlays.
- Motion is restrained: `150-300ms` transitions, no bounce or parallax.

## Components

### Page Types

AIOS supports four common page types:

1. Dashboard pages: metric summaries, resource allocation charts, monitoring panels, alert/event lists.
2. Management list pages: title, optional summary, search toolbar, data table, pagination, row operations.
3. Creation entry pages: card-based selection of creation method before entering a detailed form.
4. Feedback and operation states: dropdowns, tooltips, messages, dialogs, and confirmations for row or batch actions.

New pages should match one of these patterns before inventing a new page skeleton.

### Panels And Cards

Business panel:

```css
.aios-panel {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 0 12px 0 rgba(0, 0, 0, 0.12);
  padding: 10px;
}
```

Metric card:

```css
.aios-stat-card {
  min-height: 105px;
  padding: 8px;
  border: 1px solid #dcdfe6;
  border-radius: 10px;
  background: linear-gradient(90deg, rgba(255,255,255,0), rgba(88,130,252,0.1));
}

.aios-stat-card:hover {
  background-color: #f5f5f5;
}
```

Card title rows use `13px / 32px`. Tooltip icons are around `14px`. Key numbers use `18px`, `700`.

Non-statistic information card:

```css
.aios-info-card {
  padding: 12px;
  border-radius: 8px;
  background: #eff3ff;
  transition: background-color 150ms ease;
}

.aios-info-card:hover {
  background: #f5f5f5;
}
```

Use this for compact status, metadata, and read-only information cards, such as service health, database status, and agent status. Do not use it for statistic/KPI cards, charts, tables, form controls, or cards whose background encodes a semantic state.

Do not nest UI cards inside other UI cards. A list card owns its toolbar, table, and pagination directly.

### Tables

AIOS tables follow an Element-style compact data table. The Element-style `.cell` model is authoritative: every `th`/`td` owns its inner spacing through the table primitive's CSS, never through per-cell utility classes.

- Font size `12-13px`.
- Header background `#F1F5FE`.
- Header row height `42px`.
- Header cell padding `12px 14px` (vertical 12px, horizontal 14px).
- Body row height `48px`.
- Body cell padding `12px 14px` (vertical 12px, horizontal 14px).
- The leftmost column's left padding and the rightmost column's right padding are **14px**, identical to inner cell horizontal padding. Do not flush content against the table edge.
- Row divider `#EBEEF5`.
- Outer/container divider `#DCDFE6`.
- Hover row `#F5F5F5`.
- Striped odd row `#FAFAFA` (very light gray — not pure white).
- Striped even row `#F1F5FE` — same value as the header background, giving the header and every second row a shared light-blue band; odd rows stay `#FAFAFA` very-light-gray for readable alternation.
- Sorting, filtering, and selected states use `#5882FC`.
- Empty state text: `暂无数据`, centered, without decorative illustration.
- Operation column is fixed on the right when actions exist; header text is `操作`.
- Inline actions use text buttons.
- Show 2-3 frequent safe operations directly; move secondary or dangerous operations into a `更多` menu.
- Pagination sits below the table on the right.

All list tables in an AIOS product must share the same table primitive. Do not handcraft different header backgrounds, row borders, font sizes, or table chrome per page.

**Cell padding is owned by the table primitive, not by components.** The `.paas-data-table th` / `.paas-data-table td` rules in the global stylesheet set `padding: 12px 14px`. Components MUST NOT override this with Tailwind padding utilities such as `px-3`, `py-2`, `px-4` on `th`/`td` — doing so creates competing sources of truth and produces the left-edge gap inconsistency observed against the Element reference. Per-cell utilities are still allowed for text alignment (`text-right`), color, truncation, and width (`w-[13%]`), but never for padding.

**Header typography is owned by the table primitive.** The `.paas-data-table th` rule sets `font-family: var(--paas-font-family)`, `font-size: var(--paas-font-xs)` (12px), `font-weight: 700`, `color: var(--paas-color-text)` (#606266). Components MUST NOT attach `font-medium`, `font-semibold`, `font-bold`, `font-normal`, or any other font-weight utility to `th` — Tailwind's font-weight utilities live in `@layer utilities`, which outranks the component-layer rule, so an incidental `font-medium` (500) silently overrides the intended 700 and produces the weight mismatch observed against the Element reference. The CSS class is the single source of truth; leave `th` typography untouched in components.

**Striped rows and hover are owned by the table primitive.** The `.paas-data-table tbody tr:nth-child(odd)` rule sets the odd-row background (`#FAFAFA`, very light gray — not white), `.paas-data-table tbody tr:nth-child(even)` sets the even-row striped background (`#F1F5FE`, intentionally the same value as the table header to form a shared light-blue band), and `.paas-data-table tbody tr:hover` sets the hover background (`#F5F5F5`). Components MUST NOT re-declare these with Tailwind utilities such as `odd:bg-white`, `even:bg-[...]`, or `hover:bg-[...]` on table rows — doing so creates a competing second source of truth (Tailwind utilities outrank the component-layer rule and silently take over) and produced the striped-row mismatch observed against the Element reference. The CSS class is the single source of truth; rows should carry no background utility at all. A selected-row highlight (`bg-[var(--paas-color-primary)]/10` plus inset shadow) is a legitimate business state and remains allowed on `tr`, since the table primitive does not model selection.

Typical list structure:

```text
搜索工具条
表格列：业务标识、版本/类型、状态、来源/归属、资源指标、时间、操作
分页：共 N 条 / 页码 / 每页条数 / 前往页
```

### Field-Level Color Encoding

Business enum fields should use a shared tag component, not loose colored text.

Tag specification:

- Small size, visual height around `22px`.
- Font size `13px`.
- Radius `4px`.
- Light variant uses semantic low-opacity background/border and solid semantic text.
- Empty, unknown, or `-` values stay as neutral text.

Recommended mappings:

| Field Type | Values | Component / Color |
| --- | --- | --- |
| Operation type | `登录` / `LOGIN` | success light tag, text `#67C23A` |
| Operation type | `登出` / `LOGOUT` | danger light tag, text `#F56C6C` |
| Result state | `成功` / `SUCCESS` | success light tag, text `#67C23A` |
| Result state | `失败` / `FAIL` | danger light tag, text `#F56C6C` |
| Vendor/type/category | concrete non-empty value | primary light tag, text `#5882FC`, background/border `rgba(88,130,252,0.15)` |
| Vendor/type/category | `-` or empty | plain neutral table text |
| Safe row action | `编辑` / `复制` / `查看` | inline text button, `#5882FC`, `12px / 500` |
| Dangerous row action | `删除` / `重启` / `禁用` | inline text button, `#F56C6C`, `12px / 500` |

Do not tint an entire row or column for a single field state.

### Form Controls

Inputs and selects:

- Height `32px`.
- Font size `13px`.
- Border `1px solid #DCDFE6`.
- Radius `4px`.
- Padding `0 8px`.
- Focus border `#5882FC`.
- Disabled background `#F5F7FA`; disabled text `#C0C4CC`.

Search and filter areas:

- Usually live inside the list card above the table.
- Height around `45-48px`.
- Control height `32px`.
- Control gap `4-5px` for tight groups, `10-12px` for toolbar groups.
- Select width often `250px`.
- Use either `搜索` or `查询` consistently on the same page.
- Reset, refresh, and clear actions are secondary or plain buttons.

### Buttons

Primary button:

- Background `#5882FC`.
- Hover `rgba(88,130,252,0.8)`.
- Active `rgba(88,130,252,0.9)`.

Button hierarchy:

- Primary actions: 新增, 创建, 确定, 查询, 搜索.
- Secondary actions: 取消, 刷新, 重置, 资源监控.
- Inline actions: 编辑, 查看, 终端, 详情.
- Dangerous actions: 删除, 重启, 禁用, 取消. These require confirmation when they mutate data.
- Batch actions live in the filter toolbar. If nothing is selected, show a message instead of opening an empty dialog.

Button labels should be short verbs. Icon-only buttons should use recognizable icons and show tooltips on hover.

### Tags And Status

Default primary tag:

```css
background: rgba(88,130,252,0.1);
border-color: rgba(88,130,252,0.1);
color: #5882FC;
```

Semantic status:

- Normal/running/success: `#67C23A`.
- Abnormal/error/failure: `#F56C6C`.
- Warning: `#E6A23C`.
- Info/unknown/loading: `#909399`.

Status labels should use `12px` when possible. State must not rely on color alone; pair color with text or an icon.

### Tabs

- Height `40px`.
- Inactive background `#F5F7FA`.
- Inactive text `#707274`.
- Border `#E0E0E0`.
- Active background white.
- Active text primary.
- Active tab removes bottom border where it connects to content.
- Hover text primary.
- Card tabs use radius `4px 4px 0 0`.

### Creation Entry Pages

Use an entry page when users must choose among multiple creation methods before filling a form.

- Breadcrumb/title: `模块 / 页面 / 新增`.
- Main container: white background, `10px` radius, panel shadow.
- Method cards: height around `120px`, margin `10px`, border `#DCDFE6`, radius `6-10px`.
- Card title is stronger than description; description remains `13px`, default text color.
- Bottom action area may use an independent white bar around `53px` high.
- Cancel returns to the source list.

For a single lightweight create form, use a dialog or drawer instead.

### Dialogs, Popovers, And Feedback

Dialog:

- Header height `50px`.
- Title `16px`, `#1A1A1A`.
- Header white with bottom `1px solid #E0E0E0`.
- Body padding `20px`.
- Footer height `50px`, right-aligned actions.

Confirmation:

- Width around `550px`.
- White background, `4px` radius, `#DCDFE6` border.
- Shadow `0 0 12px rgba(0,0,0,.12)`.
- Title usually `确定`.
- Content is a short consequence statement, for example `此操作将重启组件，是否继续?`.
- Footer action order: `取消`, `确定`.
- Opening a confirmation must not mutate data. Mutation happens only after confirmation.

Dropdown/select popper:

- White background.
- Border `#E4E7ED`.
- Radius `4px`.
- Shadow `0 2px 12px 0 rgba(0,0,0,0.1)`.
- Menu item height `34-38px`.

More menu:

- Triggered from a row `更多` text button.
- Text `12-14px`.
- Hover background shallow gray or blue; hover text primary.
- Dangerous items may use danger text, but not a strong red block hover.

Tooltip:

- Background `#303133`.
- Text white.
- Radius `4px`.
- Padding `10px`.
- Shadow `0 0 12px rgba(0,0,0,.12)`.

Messages:

- Use for lightweight success/failure feedback and missing preconditions.
- Non-blocking.
- Short copy, for example `请选择数据`.
- Do not replace confirmation dialogs for destructive actions.

## Interaction Patterns

### List Query

- Filters sit above the table, usually beside create or batch actions.
- Order filters from primary object, status/type, keyword, then query action.
- Clicking query refreshes only the table region and resets pagination to page 1.
- No-results state stays inside the table as `暂无数据`.

### Row Operations

- Operation column is fixed on the right.
- Safe frequent actions are visible directly.
- Secondary and dangerous actions move into `更多`.
- Row hover changes background and cursor affordance only.
- After an action, stay in the current list context and refresh the affected row or current page.

### Batch Operations

- Depend on first-column checkboxes.
- If nothing is selected, show `请选择数据`.
- Dangerous batch actions require confirmation.
- On completion, clear selection and refresh the current list.

### Create And Edit

- Multiple creation methods use a creation entry page.
- Single lightweight creation may use a dialog or drawer.
- Save buttons enter loading/disabled state to prevent duplicate submission.
- Successful save shows a short message and refreshes data.
- Failed save preserves input and displays field or top-level error.
- If an edited form has unsaved changes, complex flows should confirm before leaving.

### Destructive Actions

- Delete, restart, disable, cancel, and similar mutations require confirmation.
- Confirmation copy states the consequence in plain language.
- Cancel never changes data.
- Confirm enters loading or disabled state while executing.
- Success shows a message and refreshes data.
- Failure explains the cause or next step when available.

### Loading, Empty, Disabled

- Short loading is local: table, button, or cell.
- Long loading may use table loading or skeletons while navigation and filters remain visible.
- Empty states use short text and minimal decoration.
- Disabled controls use low contrast and explain the reason when unclear.
- Loading, empty, and disabled states must include text or icon cues, not color alone.

### Error And Validation

- Field errors appear below the field in danger color.
- Validate required, format, and duplicate-name errors before submit where possible.
- Server errors preserve user input.
- Error copy format: what happened + how to fix.

### Help And Tooltip

- Use tooltip for icon buttons, truncated text, and table-header explanations.
- Tooltips hold short explanations only.
- Do not use tooltip as the only label for a core operation unless the icon is universally recognizable.

### Interaction Matrix

| Scenario | Trigger | Feedback | Follow-up State |
| --- | --- | --- | --- |
| Query list | Click `查询` / `搜索` | Table local loading | Update table, reset to first page |
| Batch action without selection | Click batch button | Message `请选择数据` | Stay on current page |
| Safe row action | Click text action | Dialog/page/local loading | Refresh affected data |
| Dangerous row action | Click destructive action | Open confirmation | Execute only after confirm |
| More menu | Click `更多` | Dropdown opens | Close after item selection |
| Form submit success | Click `确定` / `保存` | Button loading + success message | Close dialog and refresh, or enter detail |
| Form submit failure | Click `确定` / `保存` | Error message or field error | Preserve input |
| Long text view | Hover truncated text | Tooltip with full content | Close on mouse leave |

## Charts And Data Display

Charts are for readability, not decoration.

- Donut chart backgrounds may use `rgba(88,130,252,0.1)`.
- Percent numbers use `16-18px`, bold.
- Legend text uses `12px`.
- Resource allocation data should show percentage first, then details.
- Positive, negative, abnormal, and warning indicators use semantic colors.
- Do not introduce extra decorative colors for chart cards.

## Theming

Default theme:

```html
html.light.aios-theme-sea
```

Optional primary themes:

| Theme | Primary |
| --- | --- |
| sea | `#5882FC` |
| dawn | `#38C0FC` |
| sky | `#1D84FF` |
| magenta | `#FF80C8` |
| purple | `#B48DF3` |
| orange | `#F9901F` |
| green | `#60C041` |

Dark mode may exist in host products, but the default AIOS specification is light + sea.

## CSS Variable Reference

```css
:root {
  --aios-color-primary: #5882fc;
  --aios-color-primary-bg: rgba(88, 130, 252, 0.1);
  --aios-color-text: #606266;
  --aios-color-text-secondary: #909399;
  --aios-color-text-disabled: #c0c4cc;
  --aios-color-border: #dcdfe6;
  --aios-color-page: #f1f4f9;
  --aios-color-surface: #fff;
  --aios-color-hover: #f5f5f5;
  --aios-color-active: #f2f4f5;
  --aios-color-info-card: #eff3ff;
  --aios-color-success: #67c23a;
  --aios-color-warning: #e6a23c;
  --aios-color-danger: #f56c6c;

  --aios-font-family: Tahoma, Helvetica, Arial, Verdana, "Microsoft YaHei", SimSun, 宋体;
  --aios-font-xs: 12px;
  --aios-font-sm: 13px;
  --aios-font-md: 14px;
  --aios-font-lg: 16px;
  --aios-font-xl: 18px;

  --aios-radius-control: 4px;
  --aios-radius-panel: 10px;
  --aios-shadow-panel: 0 0 12px 0 rgba(0, 0, 0, 0.12);
  --aios-border: 1px solid var(--aios-color-border);
}
```

## Usage Principles

1. Reuse proven component structures before inventing custom primitives.
2. New business pages use white `10px` radius panels, not large colored backgrounds.
3. Primary color means clickable, selected, linked, or key. Do not use it as decoration.
4. Tables and filters stay compact; `32px` controls are the default.
5. Multi-level navigation supports collapse, ellipsis, hover, active, and keyboard states.
6. Operational states use semantic colors consistently across the system.
7. Page titles and key numbers may be bold; ordinary fields should not be.
8. Empty, loading, and disabled states stay quiet and do not steal focus from data.
9. Creation entries, confirmations, more menus, and messages should follow the same interaction model across products.
10. Destructive actions must use confirmation or explicit warning copy.

## Do's And Don'ts

Do:

- Use one shared table primitive across list pages.
- Keep status text visible alongside semantic color.
- Use the active edge in navigation, not color alone.
- Keep filters, pagination, and row operations predictable.
- Let host applications provide product names, menu labels, logos, and routes.

Don't:

- Hard-code product, tenant, or subsystem names into shared components.
- Replace a missing logo with ordinary text pretending to be a logo.
- Use dark neon dashboards as the default AIOS surface.
- Use gradients, glow, glass blur, or oversized hero composition for operational pages.
- Add third-level menus for single-child groups.
- Execute destructive actions without a confirmation step.
