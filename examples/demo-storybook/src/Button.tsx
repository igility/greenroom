interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  onClick?: () => void;
}

export function Button({ label, variant = 'primary', disabled, onClick }: ButtonProps) {
  return (
    <button
      type="button"
      className={`demo-button demo-button--${variant}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
