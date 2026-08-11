interface BadgeProps {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}

export function Badge({ label, tone = 'neutral' }: BadgeProps) {
  return <span className={`demo-badge demo-badge--${tone}`}>{label}</span>;
}
