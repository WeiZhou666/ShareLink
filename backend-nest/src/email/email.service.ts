import { Inject, Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { Logger } from 'winston';

/**
 * 邮件服务：激活验证码 / 忘记密码两封事务邮件的统一出口
 *
 * 投递策略由 MAIL_DELIVERY 环境变量切换：
 * - log（默认）：邮件内容投递到日志——与 SMTP 接入前「日志投递」行为完全一致，
 *   开发/单测环境零配置（验证码只能从日志拿，这本身就是天然的安全兜底）
 * - smtp：nodemailer 真实发信——transporter 懒创建（首次发送才连接，
 *   SMTP 不可用不阻塞应用启动），发送失败 fail-open：只记 warn 不抛错，
 *   因为验证码/重置 token 在发信前已落库（可重发），邮件失败不应阻断注册主流程
 */
@Injectable()
export class EmailService {
  /** SMTP transporter：懒创建，log 模式下永远不连接 */
  private transporter: Transporter | null = null;

  constructor(
    private readonly i18n: I18nService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /**
   * 邮箱激活验证码（6 位数字码，10 分钟有效）——用户在 /auth/verify 回填提交
   * lang 由调用方从请求链路透传（I18nContext.current()?.lang），决定邮件语言
   */
  async sendActivationCode(to: string, code: string, lang?: string) {
    const subject = this.i18n.t('email.activationSubject', { lang });
    const html = this.renderActivationCode(code, lang);
    await this.deliver(
      to,
      subject,
      html,
      `[激活邮件·日志投递] ${to} 激活验证码：${code}（10 分钟内有效）`,
    );
  }

  /**
   * 忘记密码重置验证码（6 位数字码，10 分钟有效）——用户在重置页回填提交新密码
   * 用验证码而非重置链接：邮件里没有 URL，不受邮件商安全跳转拦截/预扫描提前消费影响，跨设备体验也好
   */
  async sendResetCode(to: string, code: string, lang?: string) {
    const subject = this.i18n.t('email.resetSubject', { lang });
    const html = this.renderResetCode(code, lang);
    await this.deliver(
      to,
      subject,
      html,
      `[重置邮件·日志投递] ${to} 重置验证码：${code}（10 分钟内有效）`,
    );
  }

  /** 管理员连通性自检（admin testEmail 端点）：与业务邮件走同一 deliver 链路，验证 SMTP 配置 */
  async sendTestEmail(to: string) {
    const subject = this.i18n.t('email.testSubject');
    const html = `
      <div style="max-width:480px;margin:0 auto;font-family:'Segoe UI',sans-serif;color:#333">
        <h2 style="color:#6741d9;margin-bottom:16px">ShareLink</h2>
        <p>${this.i18n.t('email.testBody')}</p>
      </div>`;
    await this.deliver(
      to,
      subject,
      html,
      `[测试邮件·日志投递] ${to} 邮件配置连通性正常`,
    );
  }

  /**
   * 分享链接投递（上传完成弹窗的"发送到邮箱"）：把 /s/{shareId} 链接发给指定收件人
   * lang 透传与激活/重置邮件一致；链接指向前端公开分享页（FRONTEND_URL）
   */
  async sendShareLink(
    to: string,
    shareName: string,
    shareUrl: string,
    lang?: string,
  ) {
    const subject = this.i18n.t('email.shareLinkSubject', { lang });
    const hello = this.i18n.t('email.shareLinkHello', { lang });
    const body = this.i18n.t('email.shareLinkBody', {
      args: { name: shareName },
      lang,
    });
    const footer = this.i18n.t('email.footer', { lang });
    const html = `
      <div style="max-width:480px;margin:0 auto;font-family:'Segoe UI',sans-serif;color:#333">
        <h2 style="color:#6741d9;margin-bottom:16px">ShareLink</h2>
        <p>${hello}</p>
        <p>${body}</p>
        <p style="font-size:18px"><a href="${shareUrl}" style="color:#6741d9">${shareUrl}</a></p>
        <p style="color:#888;font-size:12px;margin-top:24px">${footer}</p>
      </div>`;
    await this.deliver(
      to,
      subject,
      html,
      `[分享链接·日志投递] ${to} 分享「${shareName}」链接：${shareUrl}`,
    );
  }

  /** 投递分发：smtp 真发信（fail-open），否则退回日志投递 */
  private async deliver(
    to: string,
    subject: string,
    html: string,
    logFallback: string,
  ) {
    if (process.env.MAIL_DELIVERY === 'smtp') {
      try {
        await this.getTransporter().sendMail({
          from: process.env.SMTP_FROM,
          to,
          subject,
          html,
        });
      } catch (e) {
        // fail-open：验证码/重置 token 已落库（可重发），仅告警不抛错
        this.logger.warn(
          `邮件发送失败：${to} | ${subject} | ${(e as Error).message}`,
          { context: EmailService.name },
        );
      }
      return;
    }
    // 日志投递：话术与接入前保持一致（回归对照 / 兜底取码通道）
    this.logger.info(logFallback, { context: EmailService.name });
  }

  /** SMTP 连接参数：secure=true 走 465 隐式 TLS；587 端口则 secure=false + STARTTLS */
  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 1025),
        secure: process.env.SMTP_SECURE === 'true',
        // 免认证模式（本地 Mailpit）：SMTP_USER 留空则不带 auth
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
    }
    return this.transporter;
  }

  // ---------- HTML 模板（TS 函数拼装，主题色 #6741d9；邮件样式多了再换 handlebars） ----------

  private renderActivationCode(code: string, lang?: string) {
    const hello = this.i18n.t('email.activationHello', { lang });
    const body = this.i18n.t('email.activationBody', { lang });
    const footer = this.i18n.t('email.footer', { lang });
    return `
      <div style="max-width:480px;margin:0 auto;font-family:'Segoe UI',sans-serif;color:#333">
        <h2 style="color:#6741d9;margin-bottom:16px">ShareLink</h2>
        <p>${hello}</p><p>${body}</p>
        <div style="font-size:32px;letter-spacing:8px;font-weight:700;color:#6741d9;text-align:center;padding:16px;background:#f6f4fe;border-radius:8px">${code}</div>
        <p style="color:#888;font-size:12px;margin-top:24px">${footer}</p>
      </div>`;
  }

  private renderResetCode(code: string, lang?: string) {
    const hello = this.i18n.t('email.resetHello', { lang });
    const body = this.i18n.t('email.resetBody', { lang });
    const footer = this.i18n.t('email.footer', { lang });
    return `
      <div style="max-width:480px;margin:0 auto;font-family:'Segoe UI',sans-serif;color:#333">
        <h2 style="color:#6741d9;margin-bottom:16px">ShareLink</h2>
        <p>${hello}</p><p>${body}</p>
        <div style="font-size:32px;letter-spacing:8px;font-weight:700;color:#6741d9;text-align:center;padding:16px;background:#f6f4fe;border-radius:8px">${code}</div>
        <p style="color:#888;font-size:12px;margin-top:24px">${footer}</p>
      </div>`;
  }
}
