import type { ReactNode } from 'react';

interface CardProps {
  title: string;
  body: string;
  footer?: ReactNode;
}

export function Card({ title, body, footer }: CardProps) {
  return (
    <div className="demo-card">
      <h3>{title}</h3>
      <p>{body}</p>
      {footer ? <div style={{ marginTop: 16 }}>{footer}</div> : null}
    </div>
  );
}
