export function validateString(value: any, fieldName: string, required = false): string | null {
  if (value === undefined || value === null) {
    return required ? `Field '${fieldName}' is required.` : null;
  }
  if (typeof value !== 'string') return `Field '${fieldName}' must be a string.`;
  if (required && value.trim() === '') return `Field '${fieldName}' cannot be empty.`;
  return null;
}

export function validateEnum(value: any, fieldName: string, validValues: string[], required = false): string | null {
  if (value === undefined || value === null || value === '') {
    return required ? `Field '${fieldName}' is required.` : null;
  }
  if (!validValues.includes(value)) {
    return `Field '${fieldName}' must be one of: ${validValues.join(', ')}. Received: ${value}`;
  }
  return null;
}
