import nodemailer from 'nodemailer'
import { config } from '../config'

interface MailOptions {
  to?: string
  // Hidden recipients: a batch to many people, none of whom should see the others' addresses.
  bcc?: string[]
  subject: string
  html: string
  text: string
}

const transporter = config.email
  ? nodemailer.createTransport({ service: 'gmail', auth: config.email })
  : undefined

// Sends one email. Callers decide whether a failure matters: password reset swallows and logs it
// (so the endpoint can't reveal which emails exist), the emergency broadcast does the same.
// With no EMAIL_* configured (development only — production refuses to boot without them) the
// message is printed to the console instead, which is how you grab a reset link locally.
export const sendMail = async ({ to, bcc, subject, html, text }: MailOptions) => {
  if (!transporter || !config.email) {
    const recipients = to ?? `${bcc?.length ?? 0} recipient(s) in bcc`
    console.log(`[mail disabled] To: ${recipients}\nSubject: ${subject}\n${text}`)
    return
  }
  await transporter.sendMail({
    from: `AidBridge <${config.email.user}>`,
    to,
    bcc,
    subject,
    html,
    text,
  })
}
