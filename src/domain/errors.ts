export type ErrorKind =
  'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'unprocessable';

export class DomainError extends Error {
  constructor(
    readonly kind: ErrorKind,
    /** Stable machine-readable identifier, exposed as the tail of the problem `type`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string): DomainError =>
  new DomainError('not_found', 'not-found', `${what} not found`);

export const forbidden = (message = 'You are not allowed to perform this action'): DomainError =>
  new DomainError('forbidden', 'forbidden', message);

export const conflict = (code: string, message: string): DomainError =>
  new DomainError('conflict', code, message);

export const invalid = (code: string, message: string): DomainError =>
  new DomainError('validation', code, message);

export const unprocessable = (code: string, message: string): DomainError =>
  new DomainError('unprocessable', code, message);
