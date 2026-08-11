interface AlertBannerProps {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  message: string;
}

export function AlertBanner({ tone = 'info', title, message }: AlertBannerProps) {
  return (
    <div className={`demo-alert demo-alert--${tone}`} role="status">
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
}
