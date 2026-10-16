import type { AppConfig } from '../../config/env.js';
import type { MailMessage } from '../../infrastructure/mail/mailer.js';

/**
 * Plain-text transactional emails. One-time tokens go in the URL fragment (#token=...),
 * which browsers never send to servers or in Referer headers.
 */

function footer(config: AppConfig): string {
  return `\n\n-- \n${config.appName}\nIf you did not expect this email, you can ignore it. Never share links or codes from this email.`;
}

export function verifyEmail(to: string, name: string, token: string, config: AppConfig): MailMessage {
  return {
    to,
    subject: `Verify your ${config.appName} email address`,
    text: `Hi ${name},\n\nConfirm your email address to activate your account:\n\n${config.appBaseUrl}/verify-email#token=${token}\n\nThis link expires in 24 hours and works once.${footer(config)}`,
  };
}

export function alreadyRegistered(to: string, config: AppConfig): MailMessage {
  return {
    to,
    subject: `Sign-up attempt for your ${config.appName} account`,
    text: `Someone tried to create a new ${config.appName} account with this email address, but you already have one.\n\nSign in: ${config.appBaseUrl}/login\nForgot your password? ${config.appBaseUrl}/forgot-password${footer(config)}`,
  };
}

export function passwordReset(to: string, name: string, token: string, config: AppConfig): MailMessage {
  return {
    to,
    subject: `Reset your ${config.appName} password`,
    text: `Hi ${name},\n\nUse this link to choose a new password:\n\n${config.appBaseUrl}/reset-password#token=${token}\n\nThe link expires in 30 minutes and works once. Requesting another link cancels this one.${footer(config)}`,
  };
}

export function passwordChanged(to: string, name: string, config: AppConfig): MailMessage {
  return {
    to,
    subject: `Your ${config.appName} password was changed`,
    text: `Hi ${name},\n\nThe password for your account was just changed and other sessions were signed out.\nIf this was not you, reset your password now: ${config.appBaseUrl}/forgot-password${footer(config)}`,
  };
}

export function accountLocked(to: string, name: string, until: Date, config: AppConfig): MailMessage {
  return {
    to,
    subject: `Unusual sign-in activity on your ${config.appName} account`,
    text: `Hi ${name},\n\nWe paused sign-in to your account until ${until.toISOString()} (UTC) after several failed attempts.\nIf this was you, wait and try again. If not, consider resetting your password: ${config.appBaseUrl}/forgot-password${footer(config)}`,
  };
}

export function twoFactorDisabled(to: string, name: string, config: AppConfig): MailMessage {
  return {
    to,
    subject: `Two-factor authentication was turned off`,
    text: `Hi ${name},\n\nTwo-factor authentication was turned off for your ${config.appName} account.\nIf this was not you, reset your password immediately: ${config.appBaseUrl}/forgot-password${footer(config)}`,
  };
}

export function recoveryCodeUsed(to: string, name: string, remaining: number, config: AppConfig): MailMessage {
  return {
    to,
    subject: `A recovery code was used on your ${config.appName} account`,
    text: `Hi ${name},\n\nA two-factor recovery code was just used to sign in. ${remaining} code(s) remain.\nIf this was not you, reset your password and regenerate your recovery codes.${footer(config)}`,
  };
}

export function confirmEmailChange(to: string, name: string, token: string, config: AppConfig): MailMessage {
  return {
    to,
    subject: `Confirm your new ${config.appName} email address`,
    text: `Hi ${name},\n\nConfirm this address to make it your new sign-in email:\n\n${config.appBaseUrl}/confirm-email#token=${token}\n\nThe link expires in 1 hour and works once. After confirming, you will be signed out everywhere.${footer(config)}`,
  };
}

export function emailChangeRequested(to: string, name: string, newEmail: string, config: AppConfig): MailMessage {
  const masked = newEmail.replace(/^(.).*(@.*)$/, '$1***$2');
  return {
    to,
    subject: `Email change requested for your ${config.appName} account`,
    text: `Hi ${name},\n\nSomeone signed in to your account asked to change its email address to ${masked}. Nothing changes until the new address is confirmed.\nIf this was not you, change your password now: ${config.appBaseUrl}/forgot-password${footer(config)}`,
  };
}

export function emailChanged(to: string, name: string, newEmail: string, config: AppConfig): MailMessage {
  const masked = newEmail.replace(/^(.).*(@.*)$/, '$1***$2');
  return {
    to,
    subject: `Your ${config.appName} email address was changed`,
    text: `Hi ${name},\n\nThe sign-in email for your account is now ${masked}. This address will no longer receive account emails.\nIf this was not you, contact support immediately.${footer(config)}`,
  };
}

export function emailInUse(to: string, config: AppConfig): MailMessage {
  return {
    to,
    subject: `Email change attempt on ${config.appName}`,
    text: `Someone tried to move another ${config.appName} account to this address, but you already use it for an account. No change was made.${footer(config)}`,
  };
}
