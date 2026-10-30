/**
 * A small line chart of a series, drawn in the current text colour so it follows the theme. It is
 * decorative beside the figure it illustrates, so it is hidden from assistive technology, which
 * reads the figure and the label instead.
 */
export const Sparkline = ({ values, label }: { values: readonly number[]; label: string }) => {
  if (values.length < 2) return null;
  const width = 120;
  const height = 28;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((value, i) => `${(i * step).toFixed(1)},${(height - (value / max) * (height - 2) - 1).toFixed(1)}`).join(" ");
  return (
    <svg data-testid={`sparkline-${label}`} aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-kumo-subtle">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};
