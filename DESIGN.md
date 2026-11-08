---
name: chkd
description: Neutral graphite popup with aligned settings and clear analysis state.
colors:
  bg: "#121212"
  surface: "#1c1c1c"
  hover: "#262626"
  line: "#2c2c2c"
  text: "#eeeeec"
  muted: "#ababaa"
  selected: "#dededb"
  selected-text: "#121212"
  danger: "#efb2ab"
  switch-border: "#777776"
  bar-black: "#111111"
typography:
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    lineHeight: 1.5
  result:
    fontSize: "24px"
    fontWeight: 550
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  title:
    fontSize: "16px"
    fontWeight: 650
    letterSpacing: "-0.025em"
  label:
    fontSize: "12px"
  power:
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.03em"
rounded:
  control: "10px"
  segment: "999px"
  switch: "10px"
spacing:
  segment-gap: "2px"
  segment-inset: "3px"
  inline: "8px"
  row-gap: "12px"
  edge: "20px"
components:
  power:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
    typography: "{typography.power}"
  power-on:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.selected-text}"
  segment:
    textColor: "{colors.muted}"
    rounded: "{rounded.segment}"
    padding: "3px 0"
    typography: "{typography.label}"
  segment-active:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.selected-text}"
  select:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "5px 8px"
    typography: "{typography.label}"
  switch:
    width: "32px"
    height: "20px"
    rounded: "{rounded.switch}"
  error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    typography: "{typography.label}"
---

# Design System: chkd

## Overview

The popup is a simple, neutral tool panel. Clear state and optical alignment guide the design: quiet graphite surfaces, light selected controls, compact system type, and shared edges. There are no decorative assets.

**Key Characteristics:**
- Neutral surfaces and functional color.
- Consistent control columns and shared edges.
- Prominent result with quieter supporting information.

## Colors

Light neutral selection is the primary emphasis. Graphite background, raised control surface, hover tone, and divider color establish hierarchy. Main text is light; labels and status use muted text. Restrained red is reserved for error text. The switch has a stronger border when off.

## Typography

Use the system sans stack for every role, with tabular numerals. The result is the largest text; the title is smaller and heavier. Supporting labels and controls share the compact label size. The power control alone uses the smallest, slightly tracked label. This is an operational interface without a display font.

## Layout

The popup has a fixed width (304px) and shared horizontal insets (20px). The header, result, and settings align to those edges. The header has a minimum height (52px). Settings use a two-column grid: a flexible label column, a fixed control column (148px), and a gap (12px), with a minimum row height (40px). Three equal segments fill the control column; the switch aligns to its right edge.

Long result, site, and error text wraps. The board picker appears only with multiple sessions, above the settings; its label and full-width select occupy separate lines. No responsive breakpoint is implemented.

**The Shared Edges Rule.** Preserve the shared content edges and control column when adding settings.

## Elevation & Depth

There are no shadows. Tonal surfaces and thin dividers separate controls and sections. Keyboard focus uses a light outline (2px) offset from the control (3px).

## Shapes

Controls and the error surface use gently rounded corners; segments use the smaller radius. Only the switch and state dot are pill-shaped or circular. Dividers and control borders are thin (1px).

## Components

- **Power:** a compact outlined OFF button; ON fills with the selected neutral and dark text. A small dot echoes the text color. Hover lightens the surface.
- **Segmented settings:** three equal buttons inside a darker group. Selection uses a light fill and heavier dark text; hover uses the hover tone. Preserve pressed-state semantics.
- **Board picker:** full-width native select, shown only when multiple boards are available. Choices use the site, mode, and tab number. Status updates preserve the option nodes.
- **Move arrow and position score switches:** a compact checkbox with switch semantics. Its thumb moves horizontally (12px); background and movement transition over 160ms with ease-out. Reduced motion removes transitions.
- **Auto move:** an independent switch, off by default. The player side is detected from the game API, independently of board orientation. There is no manual side selector. Game mode labels do not gate the operator-selected test board.
- **Error:** a wrapping, selectable text banner on the control surface. It is hidden when no error exists.

Time choices include seconds in every button. Engine cache choices include MB and are always visible beside the other settings. Keep setting labels self-contained; omit explanatory paragraphs in the popup. No divider separates the cache from the display controls.

- **Advantage meter:** a horizontal white/black bar below the result metadata (8px high, 14px top margin). White fills from the left; positive white scores increase that portion, negative scores reduce it. The midpoint means equality. The scale represents evaluation, not win probability. Mate scores fill the winning side. The meter follows the position score toggle and hides without a valid evaluation. Its accessible label states the advantage and score. The meter replaces the divider before settings.

## Do's and Don'ts

- **Do** keep settings aligned to the same control column and shared edges.
- **Do** preserve visible keyboard focus, state semantics, text wrapping, and reduced motion support.
- **Don't** add decorative assets, ornamental shadows, or a display font.
- **Don't** use error red for ordinary selection or enabled state.
