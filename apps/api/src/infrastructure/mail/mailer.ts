import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;

  constructor(
    private readonly config: AppConfig['mail'],
    private readonly logger: Logger,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: config.password ?? '' } } : {}),
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.config.from, ...message });
    this.logger.info({ subject: message.subject }, 'email sent');
  }
}

/**
 * Development-only: writes emails to the log instead of sending them. Message bodies can
 * contain one-time links, so this transport is refused in production by config validation.
 */
export class LogMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  send(message: MailMessage): Promise<void> {
    this.logger.info({ to: message.to, subject: message.subject, body: message.text }, 'email (log transport, not sent)');
    return Promise.resolve();
  }
}

/** Test helper: keeps messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  last(to?: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

export function createMailer(config: AppConfig, logger: Logger): Mailer {
  return config.mail.transport === 'smtp' ? new SmtpMailer(config.mail, logger) : new LogMailer(logger);
}
