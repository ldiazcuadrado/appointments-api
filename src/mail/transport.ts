import { createTransport } from 'nodemailer';
import type { FastifyBaseLogger as Logger } from 'fastify';

export interface MailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

/** Anything that can deliver a message. Swap implementations without touching callers. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
  close?(): Promise<void> | void;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

export function createSmtpTransport(options: SmtpOptions): MailTransport {
  const transporter = createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
  });
  return {
    async send(message) {
      await transporter.sendMail({ from: options.from, ...message });
    },
    close: () => {
      transporter.close();
    },
  };
}

/** Writes messages to the log instead of delivering them. */
export function createLogTransport(logger: Logger): MailTransport {
  return {
    send(message) {
      logger.info(
        { to: message.to, subject: message.subject },
        'mail not delivered (log transport)',
      );
      return Promise.resolve();
    },
  };
}
