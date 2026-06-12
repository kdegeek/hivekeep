---
title: Guidelines
description: Best practices for building high-quality mini-apps.
---

## Dark & Light Mode

Mini-apps must work in both themes. The design system CSS handles this automatically when you use CSS variables and components:

- **Use CSS variables** (`var(--color-background)`, `var(--color-foreground)`, etc.) instead of hardcoded colors
- **Use `@hivekeep/components`** which auto-adapt to the current theme
- **Never hardcode** `#ffffff` or `#000000` for backgrounds/text
- **Test both modes** by toggling the theme in Hivekeep settings

```css
/* ✅ Good */
.my-element { background: var(--color-card); color: var(--color-foreground); }

/* ❌ Bad */
.my-element { background: white; color: black; }
```

## Sidebar-Aware Design

Mini-apps typically run in a side panel (320-600px wide). Design accordingly:

- **Mobile-first layout** — single column by default, expand with breakpoints
- **Use responsive utilities** — `md:grid-cols-2` for wider views
- **Use `useBreakpoint()`** or `useMediaQuery()` for JS-level responsive logic
- **Support full-page mode** — use `isFullPage` from `useHivekeep()` to adjust layout
- **Avoid horizontal scrolling** — keep content within the panel width

```jsx
function App() {
  const { isFullPage } = useHivekeep();
  const bp = useBreakpoint();

  return (
    <Grid columns={isFullPage && bp !== "xs" ? 2 : 1} gap="16px">
      <Sidebar />
      <Content />
    </Grid>
  );
}
```

## Use Existing Components

Before building custom UI, check if `@hivekeep/components` has what you need. The library includes 50+ components covering most common patterns:

- **DataGrid** instead of building custom tables with sorting/pagination
- **Form** compound component instead of manual form state management
- **Modal/Drawer** instead of custom overlays
- **Kanban** for board layouts
- **Charts** (Bar, Line, Pie, SparkLine) for data visualization

Using built-in components ensures consistent styling, theme support, and accessibility.

## Consult Examples

Look at existing mini-apps and templates for patterns:

- Use `get_mini_app_templates` to see available templates with full source code
- Templates cover common patterns: dashboard, todo list, form, data viewer, kanban, responsive layout

## Performance

- **Lazy load heavy content** — use `useInfiniteScroll` or `usePagination` for large datasets
- **Debounce search inputs** — use `useDebounce` to avoid excessive API calls
- **Use `useLocalStorage`** for UI state that doesn't need server sync (collapsed panels, sort preferences)
- **Avoid unnecessary re-renders** — use `usePrevious` to compare state changes

## React Patterns

- **Always call `useHivekeep()` first** and wait for `ready`
- **Use `useStorage`** for persistent state, `useState` for ephemeral UI state
- **Use `useAsync`** for mutations (POST, DELETE) to get loading/error states
- **Use `useApi`** for GET requests that auto-fetch on mount
- **Use JSX** with `<script type="text/jsx">` — it's transpiled server-side, no build step needed

## Backend Best Practices

- Keep `_server.js` focused — one backend per app
- Use `ctx.storage` for data persistence (same namespace as frontend)
- Use `ctx.events.emit()` for real-time updates instead of polling
- Use `ctx.log` for debugging (tagged with app name in server logs)

## File Organization

For complex apps, split code across multiple files:

```
index.html          — Entry point + main app component
app.json            — Dependencies
_server.js          — Backend (if needed)
styles.css          — Custom styles (if needed)
components/*.jsx    — Additional React components
```

Reference them with relative paths:

```html
<link rel="stylesheet" href="styles.css">
<script type="text/jsx" src="components/sidebar.jsx"></script>
```

## Accessibility

- Use semantic HTML and component props (`label`, `error` on inputs)
- Support keyboard navigation (the component library handles this for most cases)
- Provide meaningful `alt` text for images
- Respect `prefers-reduced-motion` (built-in animations do this automatically)
