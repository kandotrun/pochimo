import { config } from './config.mjs';

const RESEND_API_URL = 'https://api.resend.com/emails';

export class MailService {
  constructor({ apiKey = config.mail.resendApiKey, from = config.mail.from, replyTo = config.mail.replyTo } = {}) {
    this.apiKey = apiKey;
    this.from = from;
    this.replyTo = replyTo;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async sendMail({ to, subject, html, text, attachments = [], tags = [] }) {
    if (!this.enabled) {
      console.log('[mail] RESEND_API_KEY is not set. Skip sending:', { to, subject });
      return { ok: false, skipped: true, reason: 'RESEND_API_KEY is not set' };
    }

    const body = {
      from: this.from,
      to: Array.isArray(to) ? to : [to],
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(this.replyTo ? { reply_to: this.replyTo } : {}),
      ...(tags.length ? { tags } : {})
    };

    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = json.message || json.error || `Resend error: ${res.status}`;
      throw new Error(message);
    }

    return { ok: true, id: json.id };
  }
}

export const mailService = new MailService();
