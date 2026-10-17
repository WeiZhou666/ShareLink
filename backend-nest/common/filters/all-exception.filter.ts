import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { Request, Response } from 'express';

/**
 * 全局异常过滤器
 * 使用 WINSTON_MODULE_PROVIDER 获取原生 winston logger，保留meta元数据
 */
@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  constructor(@Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger) { }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    let status: number;
    let message: string;
    // 响应体：字符串异常统一 { statusCode, message }；
    // 对象形态的 HttpException（如分块上传的 expectedChunkIndex 续传协议、
    // 分享密码的 error: "share_password_required" 错误码）必须整体展开——
    // 前端按响应体里的 error 字段做协议分支，压平会把这些字段丢掉
    let body: Record<string, unknown>;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
        body = { statusCode: status, message };
      } else {
        const obj = res as Record<string, unknown>;
        message = (obj.message as string) ?? exception.message;
        body = { statusCode: status, ...obj };
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = '服务器内部错误';
      body = { statusCode: status, message };
    }

    // 写入错误日志，记录请求信息：url、method、query、body、堆栈
    this.logger.error('请求发生异常', {
      url: request.url,
      method: request.method,
      query: request.query,
      body: request.body,
      statusCode: status,
      errorMsg: message,
      error: exception instanceof Error ? exception.stack : String(exception)
    });

    // 返回给前端统一JSON格式，与旧后端约定一致（无 code/data 包装）
    response.status(status).json(body);
  }
}
