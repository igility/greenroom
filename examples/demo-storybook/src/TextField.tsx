interface TextFieldProps {
  label: string;
  placeholder?: string;
  helpText?: string;
  error?: string;
  value?: string;
}

export function TextField({ label, placeholder, helpText, error, value }: TextFieldProps) {
  return (
    <div className="demo-field">
      <label>
        {label}
        <input
          type="text"
          placeholder={placeholder}
          defaultValue={value}
          aria-invalid={error ? 'true' : undefined}
        />
      </label>
      {error ? (
        <span className="demo-field-error">{error}</span>
      ) : helpText ? (
        <span className="demo-field-help">{helpText}</span>
      ) : null}
    </div>
  );
}
