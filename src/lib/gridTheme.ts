import { themeQuartz } from 'ag-grid-community';

/**
 * AG Grid's Theming API, tuned to the brand palette and the approved
 * design's square-corner "blueprint" visual language (see CLAUDE.md
 * section 4) rather than AG Grid's default rounded look.
 */
export const managerGridTheme = themeQuartz.withParams({
  accentColor: '#1e544b',
  backgroundColor: '#ffffff',
  foregroundColor: '#1c281c',
  borderColor: '#d6d8d0',
  headerBackgroundColor: '#e7e8e4',
  headerTextColor: '#5c5f54',
  oddRowBackgroundColor: '#ffffff',
  rowHoverColor: '#e6edec',
  fontFamily: '"Inter", system-ui, sans-serif',
  headerFontFamily: '"Inter", system-ui, sans-serif',
  headerFontWeight: 600,
  headerFontSize: 10,
  fontSize: 13,
  wrapperBorderRadius: 0,
  borderRadius: 0,
  spacing: 8,
});
