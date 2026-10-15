import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { STATUS_CODES } from 'node:http';
import { DomainError, type ErrorKind } from '../domain/errors.js';

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
};

export const problemType = (code: string): string => `urn:appointments-api:problem:${code}`;

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}

function send(
  request: FastifyRequest,
  reply: FastifyReply,
  problem: Omit<Problem, 'instance' | 'requestId'>,
) {
  const body: Problem = {
    ...problem,
    instance: request.url.split('?')[0] ?? request.url,
    requestId: request.id,
  };
  return reply.status(problem.status).type('application/problem+json').send(body);
}

export function problemErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof DomainError) {
    const status = STATUS_BY_KIND[error.kind];
    if (status === 401) void reply.header('www-authenticate', 'Bearer');
    return send(request, reply, {
      type: problemType(error.code),
      title: STATUS_CODES[status] ?? 'Error',
      status,
      detail: error.message,
    });
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    return send(request, reply, {
      type: problemType('validation-error'),
      title: 'Bad Request',
      status: 400,
      detail: 'The request did not match the expected schema',
      errors: error.validation.map((issue) => ({
        path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
        message: issue.message ?? 'Invalid value',
      })),
    });
  }

  const status =
    'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (isResponseSerializationError(error) || status >= 500) {
    request.log.error({ err: error }, 'unhandled error');
    return send(request, reply, {
      type: problemType('internal-error'),
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred',
    });
  }

  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'request-error';
  return send(request, reply, {
    type: problemType(status === 429 ? 'rate-limited' : code.toLowerCase().replaceAll('_', '-')),
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail: error.message,
  });
}

export function problemNotFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return send(request, reply, {
    type: problemType('not-found'),
    title: 'Not Found',
    status: 404,
    detail: `Route ${request.method} ${request.url.split('?')[0] ?? ''} does not exist`,
  });
}
